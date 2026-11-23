/**
 * Devedores — parcelas e recebimentos (VF-2-03b2, UI). Modal aberto a partir de devedores.js.
 * "Atrasada" é exibição derivada (pendente com vencimento passado); o status gravado só muda via
 * recebimento (paid) ou cancelamento. Registrar recebimento é atômico (js/services/debtPayments.js).
 */
import { el, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  field, iconButton, emptyBlock, dataTable, formModal, confirmModal,
  formatDate, formatMonth, formatCentsInput, selectOptions, todayIso,
} from '../components/form-kit.js';
import {
  listDebts, listDebtPayments, createDebtPlan, cancelDebt, cancelDebtGroup, settleDebts, settleInstallment, settleMonthInstallments,
  previewMonthSettlement, newOperationId, formatCents,
} from '../services/debtPayments.js';
import { debtorPendingCents, debtorObligations, receivedByInstallment, accountLabel } from '../core/model.js';
import { getDebtor, getDebtorStatement } from '../services/debtors.js';
import { listCards } from '../services/creditCards.js';
import { listAccounts } from '../services/accounts.js';
import { describeError } from '../utils/errors.js';
import { openReversalModal } from '../components/reversal-modal.js';

const STATUS_LABELS = { pending: 'Pendente', partial: 'Parcial', paid: 'Paga', late: 'Atrasada', cancelled: 'Cancelada' };

/** Status exibido: pendente vencida aparece como atrasada (sem gravar). */
export function displayDebtStatus(debt, today = todayIso()) {
  return debt.status === 'pending' && debt.dueDate < today ? 'late' : debt.status;
}

/**
 * @param {{ user: {uid:string}, debtor: object, onChange: () => Promise<void> }} ctx
 */
export async function openDebtorInstallments(args) {
  // Falha de carga (rede, indisponibilidade…) vira aviso explícito, nunca uma ação "morta" sem retorno.
  try { return await openDebtorInstallmentsInner(args); } catch (error) {
    console.error('[devedores] falha ao abrir parcelas', error);
    toast(describeError(error), 7000);
    return undefined;
  }
}

async function openDebtorInstallmentsInner({ user, debtor, onChange, month = 'all', startCreate = false }) {
  const [debts, payments, accounts, statement, cards] = await Promise.all([
    listDebts(user.uid, debtor.id),
    listDebtPayments(user.uid, { where: [['debtorId', '==', debtor.id]] }),
    listAccounts(user.uid),
    getDebtorStatement(user.uid, debtor, month === 'all' ? todayIso().slice(0, 7) : month, { tolerateReversalsDenied: true }), // negado = estornos DESCONHECIDOS: modo limitado (abaixo)
    listCards(user.uid).catch(() => []),
  ]);
  const cardName = new Map(cards.map((c) => [c.id, c.name]));
  debts.sort((a, b) => a.installmentNumber - b.installmentNumber);
  // Recebimentos por parcela (dívida ou compra no cartão); cada um é contado uma única vez.
  const { byDebt: receivedBy, byPurchase: receivedByPurchase } = receivedByInstallment(payments, statement.reversals ?? []);
  // Estornos ilegíveis (Rules antigas): recebido/situação por parcela dependem deles e seriam INCORRETOS se estornos existirem.
  // Modo LIMITADO: esses valores e as ações de recebimento ficam ocultos; só "Nova dívida" (não depende deles) segue disponível.
  const limited = statement.reversalsUnavailable === true;
  const isOpen = debtor.status === 'open';
  // Quitado também aceita nova dívida (reabre o devedor); cancelado só consulta até ser reaberto.
  const canAddDebt = isOpen || debtor.status === 'paid';
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a) }));

  const refresh = async () => {
    await onChange?.();
    const fresh = await getDebtor(user.uid, debtor.id);
    await openDebtorInstallments({ user, debtor: fresh ?? debtor, onChange, month });
  };

  const reopen = () => { closeModal(); openDebtorInstallments({ user, debtor, onChange, month }).catch((error) => toast(describeError(error), 6000)); };

  // Quitar dívida (VF-2-03n): baixa do restante de todas as parcelas pendentes de uma dívida (ou de todas), em lote.
  const openSettle = (groupId, label) => {
    const operationId = newOperationId(); // idempotência do lote: retry/duplo clique retomam o MESMO lote
    const pending = debts.filter((d) => ['pending', 'late'].includes(d.status) && (!groupId || (d.debtGroupId ?? d.id) === groupId));
    const total = pending.reduce((t, d) => t + Math.max(0, d.principalCents - (receivedBy.get(d.id) ?? 0)), 0);
    formModal({
      title: `Quitar — ${label}`,
      formId: 'debt-settle-form',
      submitLabel: 'Quitar',
      focusId: 'accountId',
      fields: [
        el('p', { class: 'card__hint', text: `${pending.length} parcela(s) pendente(s) serão quitadas, totalizando ${formatCents(total)}. As compras de cartão não são afetadas.` }),
        field('Data *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
        field('Conta que recebe *', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, selectOptions(activeAccounts, '', { placeholder: 'Selecione uma conta' }))),
        field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 2 })),
      ],
      submit: (d) => settleDebts(user.uid, debtor.id, groupId ? { groupId } : {}, {
        date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined, operationId,
      }),
      onDone: async (r) => {
        toast(r.debtorPaid ? 'Dívida quitada — devedor quitado!' : `Dívida quitada (${r.count} parcela(s), ${formatCents(r.totalCents)}).`);
        await refresh();
      },
    });
  };

  // Nova dívida (VF-2-03m): à vista (1 parcela) ou parcelada; soma ao emprestado do devedor.
  const openCreate = () => formModal({
    title: `Nova dívida — ${debtor.name}`,
    formId: 'debt-form',
    submitLabel: 'Criar dívida',
    focusId: 'description',
    fields: [
      field('Descrição *', 'description', el('input', { type: 'text', id: 'description', name: 'description', maxlength: 120, autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Valor total (R$) *', 'totalCents', el('input', { type: 'text', id: 'totalCents', name: 'totalCents', placeholder: '0,00', autocomplete: 'off' })),
        field('Parcelas (1 = à vista) *', 'installments', el('input', { type: 'number', id: 'installments', name: 'installments', min: 1, max: 120, value: 1 })),
      ]),
      field('1º vencimento *', 'firstDueDate', el('input', { type: 'date', id: 'firstDueDate', name: 'firstDueDate', value: todayIso() })),
      el('p', { class: 'card__hint', text: 'As parcelas vencem todo mês no mesmo dia; o total é somado ao valor emprestado do devedor.' }),
    ],
    submit: (d) => createDebtPlan(user.uid, {
      debtorId: debtor.id, description: d.get('description').trim(), totalCents: d.get('totalCents'),
      installments: d.get('installments'), firstDueDate: d.get('firstDueDate'),
    }),
    onDone: async (r) => { toast(r.installments > 1 ? `Dívida criada em ${r.installments} parcelas.` : 'Dívida à vista criada.'); await refresh(); },
  });

  // QUITAR UMA PARCELA (dívida ou compra no cartão): só ela; valor padrão = restante (editável: menor = recebimento parcial).
  const openSettleInstallment = (item) => {
    const operationId = newOperationId(); // chave de idempotência: duplo clique/retry desta mesma abertura não duplica
    const early = item.dueDate && item.dueDate > todayIso();
    formModal({
      title: `Quitar parcela ${item.installmentNumber}${item.installmentsTotal ? `/${item.installmentsTotal}` : ''} — ${item.description}`,
      formId: 'debt-pay-form',
      submitLabel: 'Quitar parcela',
      focusId: 'amountCents',
      fields: [
        el('p', { class: 'card__hint', text: `Vencimento ${item.dueDate ? formatDate(item.dueDate) : formatMonth(item.referenceMonth)} · restante da parcela ${formatCents(item.remainingCents)}${item.receivedCents > 0 ? ` (já recebido ${formatCents(item.receivedCents)} de ${formatCents(item.amountCents)})` : ''} · pendente do devedor ${formatCents(debtorPendingCents(debtor))}. Só esta parcela é afetada${early ? ' (antecipação)' : ''}.` }),
        field('Valor recebido (R$) *', 'amountCents', el('input', { type: 'text', id: 'amountCents', name: 'amountCents', value: formatCentsInput(item.remainingCents), autocomplete: 'off' })),
        field('Data do pagamento *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
        field('Conta que recebe *', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, selectOptions(activeAccounts, '', { placeholder: 'Selecione uma conta' }))),
        field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 2 })),
      ],
      submit: (d) => settleInstallment(user.uid, debtor.id, item.source === 'debt' ? { debtId: item.id } : { purchaseId: item.id }, {
        amountCents: d.get('amountCents'), date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined, operationId,
      }, { dueDate: item.dueDate }),
      onDone: async (r) => {
        toast(r.debtorPaid ? 'Parcela quitada — devedor quitado!' : r.settled ? (r.anticipated ? 'Parcela antecipada e quitada.' : 'Parcela quitada.') : `Recebimento parcial registrado (restam ${formatCents(r.remainingCents)}).`);
        await refresh();
      },
    });
  };

  // QUITAR TODAS AS PARCELAS PENDENTES DE UM MÊS: confirmação com mês, quantidade e valor total.
  const ledger = { debts, payments, reversals: statement.reversals ?? [], purchases: statement.purchases, invoicesById: statement.invoicesById };
  const openSettleMonth = (m) => {
    const operationId = newOperationId();
    const preview = previewMonthSettlement({ debtor, ledger, month: m });
    formModal({
      title: `Quitar parcelas de ${formatMonth(m)} — ${debtor.name}`,
      formId: 'debt-month-form',
      submitLabel: 'Confirmar quitação',
      focusId: 'accountId',
      fields: [
        el('p', { role: 'status', id: 'month-settle-summary', text: `Mês de referência: ${formatMonth(m)} · ${preview.count} parcela(s) pendente(s) · total a quitar ${formatCents(preview.totalCents)}.` }),
        el('p', { class: 'card__hint', text: 'Parcelas já pagas e de outros meses não são alteradas. Cada parcela recebe o seu próprio recebimento.' }),
        dataTable({
          columns: [
            { key: 'description', label: 'Dívida', render: (v, i) => (i.cardName ? `${v} · ${i.cardName}` : v) },
            { key: 'installmentNumber', label: 'Parcela', render: (v, i) => (i.installmentsTotal ? `${v}/${i.installmentsTotal}` : String(v)) },
            { key: 'remainingCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
          ],
          rows: preview.items,
        }),
        field('Data do pagamento *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
        field('Conta que recebe *', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, selectOptions(activeAccounts, '', { placeholder: 'Selecione uma conta' }))),
        field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 2 })),
      ],
      submit: (d) => settleMonthInstallments(user.uid, debtor.id, m, {
        date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined, operationId,
      }),
      onDone: async (r) => {
        toast(r.debtorPaid ? `Mês quitado (${r.count} parcela(s), ${formatCents(r.totalCents)}) — devedor quitado!` : `Mês quitado: ${r.count} parcela(s), ${formatCents(r.totalCents)}.`);
        await refresh();
      },
    });
  };

  // Lista única de dívidas/parcelas (VF-2-03m): à vista, parceladas, legadas e de cartão.
  const obligations = debtorObligations({
    debtor, debts, receivedByDebt: receivedBy, receivedByPurchase, purchases: statement.purchases,
    invoicesById: statement.invoicesById, cardsById: cardName,
  });
  const reopenMonth = (m) => { closeModal(); openDebtorInstallments({ user, debtor, onChange, month: m }).catch((error) => toast(describeError(error), 6000)); };
  const listAll = month === 'all';
  const closingMonth = statement.month;
  const monthValues = [...new Set([...obligations.items.map((i) => i.referenceMonth).filter(Boolean), closingMonth])].sort();
  const monthSelect = el('select', { id: 'statement-month', 'aria-label': 'Mês de referência', onChange: (e) => reopenMonth(e.target.value) }, [
    el('option', { value: 'all', selected: listAll }, 'Todos os meses'),
    ...monthValues.map((m) => el('option', { value: m, selected: !listAll && m === month }, formatMonth(m))),
  ]);
  const visible = obligations.items.filter((i) => listAll || i.referenceMonth === month);
  const KIND_LABELS = { cash: 'À vista', installment: 'Parcelada', legacy: 'Parcela', card: 'Cartão' };
  // Situação visual: paga (devedor pagou a parcela) × pendente × atrasada × cancelada. Em parcela de cartão a
  // situação da FATURA aparece à parte (fatura paga ≠ devedor pagou).
  const INVOICE_LABELS = { open: 'fatura aberta', closed: 'fatura fechada', paid: 'fatura paga' };
  const statusOf = (i) => {
    if (i.paymentState === 'partial') return 'partial'; // estado derivado da soma dos recebimentos
    if (i.source === 'card') return i.status;
    const raw = debts.find((d) => d.id === i.id);
    return raw ? displayDebtStatus(raw) : i.status;
  };
  const statusBadge = (i) => {
    if (limited) return el('span', { class: 'badge badge--neutral', 'data-status': 'unknown', text: 'Indisponível' });
    const status = statusOf(i);
    const mark = status === 'paid' ? '✓ ' : '';
    const extra = status === 'partial' ? ` · recebido ${formatCents(i.receivedCents)} de ${formatCents(i.amountCents)}`
      : i.source === 'card' && status === 'pending' && INVOICE_LABELS[i.invoiceStatus] ? ` · ${INVOICE_LABELS[i.invoiceStatus]}` : '';
    return el('span', { class: `badge badge--${status === 'paid' ? 'success' : status === 'late' ? 'danger' : status === 'partial' ? 'warning' : 'neutral'}`, 'data-status': status, text: `${mark}${STATUS_LABELS[status] ?? status}${extra}` });
  };

  const table = visible.length
    ? dataTable({
      columns: [
        { key: 'kind', label: 'Tipo', render: (v) => KIND_LABELS[v] ?? v },
        { key: 'description', label: 'Dívida', render: (v, i) => (i.cardName ? `${v} · ${i.cardName}` : v) },
        { key: 'installmentNumber', label: 'Parcela', render: (v, i) => (i.installmentsTotal ? `${v}/${i.installmentsTotal}` : String(v)) },
        { key: 'referenceMonth', label: 'Mês', render: (v) => formatMonth(v) },
        { key: 'dueDate', label: 'Vencimento', render: (v, i) => (v ? formatDate(v) : (i.source === 'card' ? '—' : '—')) },
        { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
        { key: 'receivedCents', label: 'Recebido', numeric: true, render: (v) => (limited ? '—' : formatCents(v)) },
        { key: 'status', label: 'Situação', render: (_, i) => statusBadge(i) },
      ],
      rows: visible,
      actions: (item) => {
        if (limited) return [];
        if (!isOpen || item.status !== 'pending' || item.remainingCents <= 0) return [];
        const label = `parcela ${item.installmentNumber} de ${item.description}`;
        const acts = [iconButton(`Quitar ${label}`, 'check', () => openSettleInstallment(item), 'btn--success')];
        if (item.source !== 'debt') return acts;
        const debt = debts.find((d) => d.id === item.id);
        if (!debt || !['pending', 'late'].includes(debt.status)) return acts;
        // Quitar a DÍVIDA inteira (todas as parcelas pendentes dela) é outra operação: só aparece em dívida parcelada.
        if ((debt.installmentsTotal ?? 1) > 1) acts.push(iconButton(`Quitar dívida ${debt.description}`, 'check-check', () => openSettle(debt.debtGroupId ?? debt.id, debt.description), 'btn--secondary'));
        // Cancelar a DÍVIDA inteira: só as parcelas pendentes/atrasadas SEM recebimentos; as com recebimento ficam
        // (o servidor recusa cancelá-las: estorne o recebimento antes). Só aparece em dívida parcelada.
        if ((debt.installmentsTotal ?? 1) > 1) {
          const groupKey = debt.debtGroupId ?? debt.id;
          const open = debts.filter((d) => (d.debtGroupId ?? d.id) === groupKey && ['pending', 'late'].includes(d.status));
          const cancellable = open.filter((d) => !(receivedBy.get(d.id) > 0));
          const kept = open.length - cancellable.length;
          if (cancellable.length) {
            acts.push(iconButton(`Cancelar dívida ${debt.description}`, 'ban', () => confirmModal({
              title: 'Cancelar dívida',
              message: `Cancelar ${cancellable.length} parcela(s) pendente(s) de "${debt.description}" de ${debtor.name}?`,
              hint: kept ? `${kept} parcela(s) com recebimento serão mantidas: estorne o recebimento para poder cancelá-las. Parcelas já pagas não mudam.` : 'Parcelas já pagas não mudam.',
              confirmLabel: 'Cancelar dívida',
              onConfirm: async () => {
                const r = await cancelDebtGroup(user.uid, cancellable.map((d) => d.id));
                if (r.ok) { toast(`Dívida cancelada (${r.count} parcela(s)).`); await refresh(); } else { toast(r.errors._form, 7000); if (r.partial) await refresh(); else reopen(); }
              },
            }), 'btn--danger'));
          }
        }
        if (!(receivedBy.get(debt.id) > 0)) {
          acts.push(iconButton(`Cancelar parcela ${debt.installmentNumber} de ${debt.description}`, 'x-circle', () => confirmModal({
            title: 'Cancelar parcela', message: `Cancelar a parcela ${debt.installmentNumber} de ${debtor.name}?`, confirmLabel: 'Cancelar parcela',
            onConfirm: async () => {
              const r = await cancelDebt(user.uid, debt.id);
              if (r.ok) { toast('Parcela cancelada.'); await refresh(); } else { toast(r.errors._form, 6000); reopen(); }
            },
          }), 'btn--danger'));
        }
        return acts;
      },
    })
    : emptyBlock('list-checks', 'Sem dívidas neste filtro', 'Crie uma dívida (à vista ou parcelada) ou lance uma compra de cartão vinculada a este devedor.');

  // Histórico de RECEBIMENTOS (imutável): cada recebimento pode ser ESTORNADO (lançamento compensatório pelo servidor);
  // o original permanece na lista, marcado como estornado.
  const reversedPayments = new Set((statement.reversals ?? []).filter((r) => r.targetCollection === 'debtPayments').map((r) => r.targetId));
  const sortedPayments = [...payments].sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
  const paymentsTable = sortedPayments.length && !limited
    ? dataTable({
      columns: [
        { key: 'date', label: 'Data', render: (v) => formatDate(v) },
        { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
        { key: 'accountId', label: 'Conta', render: (v) => { const a = accounts.find((x) => x.id === v); return a ? accountLabel(a) : '—'; } },
        { key: 'id', label: 'Situação', render: (v) => (reversedPayments.has(v) ? el('span', { class: 'badge', text: 'Estornado' }) : el('span', { class: 'badge badge--success', text: 'Recebido' })) },
      ],
      rows: sortedPayments,
      actions: (p) => (reversedPayments.has(p.id) ? [] : [iconButton(`Estornar recebimento de ${formatCents(p.amountCents)}`, 'undo-2', () => openReversalModal({
        user, kind: 'debtPayment', targetId: p.id, amountCents: Number(p.amountCents) || 0,
        summary: `Recebimento de ${debtor.name} — ${formatCents(Number(p.amountCents) || 0)} em ${formatDate(p.date)}`,
        onDone: () => refresh(),
      }), 'btn--danger')]),
    })
    : null;

  // Resumo e ação do MÊS selecionado (quitar o mês ≠ quitar uma parcela ≠ quitar toda a dívida).
  const monthPending = listAll ? null : previewMonthSettlement({ debtor, ledger, month });
  const monthPaid = listAll ? 0 : obligations.items.filter((i) => i.referenceMonth === month && i.status === 'paid').length;
  const monthPartial = listAll ? 0 : monthPending.items.filter((i) => i.paymentState === 'partial').length;
  const monthPanel = limited
    ? el('p', { class: 'card__hint', text: 'Parcelas do mês indisponíveis: os estornos não puderam ser lidos.' })
    : listAll
    ? el('p', { class: 'card__hint', text: 'Escolha um mês de referência para quitar todas as parcelas pendentes dele de uma vez.' })
    : el('div', { class: 'card', id: 'month-settlement' }, [
      el('p', { class: 'card__label', text: `Parcelas de ${formatMonth(month)}` }),
      el('p', { class: 'card__value', text: formatCents(monthPending.totalCents) }),
      el('p', { class: 'card__hint', text: `${monthPending.count} pendente(s)${monthPartial ? ` (${monthPartial} com recebimento parcial)` : ''} · ${monthPaid} paga(s)` }),
      isOpen && monthPending.count > 0
        ? el('button', { type: 'button', class: 'btn btn--primary', id: 'settle-month', onClick: () => openSettleMonth(month), text: 'Quitar todas as parcelas pendentes deste mês' })
        : null,
    ]);
  const closing = el('div', { class: 'card' }, [
    el('p', { class: 'card__label', text: `Total a receber em ${formatMonth(closingMonth)}` }),
    el('p', { class: 'card__value', text: isOpen && !limited ? formatCents(statement.totalCents) : '—' }),
    el('p', { class: 'card__hint', text: `Cartão ${formatCents(statement.cardCents)} + dívidas ${formatCents(statement.loanCents)}${statement.capped ? ` — limitado ao total em aberto (${formatCents(obligations.openCents)})` : ''}.` }),
  ]);
  const totals = el('div', { class: 'card' }, [
    el('p', { class: 'card__label', text: 'Total em aberto' }),
    el('p', { class: 'card__value', text: limited ? '—' : formatCents(obligations.openCents) }),
    el('p', { class: 'card__hint', text: `Emprestado ${formatCents(debtor.lentCents)} − recebido ${formatCents(debtor.receivedCents ?? 0)}. Detalhado: ${formatCents(obligations.listedCents)}${obligations.unlistedCents > 0 ? ` · sem parcelas cadastradas ${formatCents(obligations.unlistedCents)}` : ''}.` }),
  ]);

  openModal({
    title: `Dívidas — ${debtor.name}`,
    body: el('div', {}, [
      el('div', { class: 'grid grid--cards' }, [totals, closing]),
      limited ? el('p', { class: 'notice', role: 'alert', id: 'reversals-unavailable', text: 'Limitação: não foi possível ler os estornos (as regras de acesso publicadas ainda não incluem essa coleção). Recebido, situação das parcelas e totais estão ocultos por não serem confiáveis; recebimentos estão desativados. Cadastrar nova dívida continua disponível.' }) : null,
      debtor.status === 'paid' ? el('p', { class: 'card__hint', text: 'Devedor quitado: uma nova dívida (ou compra no cartão vinculada) o reabre.' }) : null,
      debtor.status === 'cancelled' ? el('p', { class: 'card__hint', text: 'Devedor cancelado: somente consulta. Reabra-o na lista para lançar dívidas.' }) : null,
      el('div', { class: 'form__field' }, [el('label', { for: 'statement-month', text: 'Mês de referência' }), monthSelect]),
      monthPanel,
      canAddDebt ? el('button', { type: 'button', class: 'btn btn--primary', onClick: openCreate, text: 'Nova dívida' }) : null,
      !limited && isOpen && debts.some((d) => ['pending', 'late'].includes(d.status))
        ? el('button', { type: 'button', class: 'btn btn--secondary', onClick: () => openSettle(null, `todas as dívidas de ${debtor.name}`), text: 'Quitar todas as dívidas' }) : null,
      table,
      paymentsTable ? el('h3', { text: 'Recebimentos' }) : null,
      paymentsTable,
    ]),
    footer: [el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Fechar' })],
  });
  refreshIcons();
  if (startCreate && canAddDebt) openCreate(); // atalho "Nova dívida" da lista de devedores
}
