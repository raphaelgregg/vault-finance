/**
 * Transferências — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista transferências com filtros
 * - Modal para criar/editar transferência
 * - Ações: confirmar, cancelar
 * - Validação client-side espelhando Security Rules (conta origem ≠ conta destino)
 * - Persistência em users/{uid}/transfers
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import { createStatCard } from '../components/stat-card.js';
import { formatCentsInput, formatDate, clearErrors, showFormErrors as showErrors, confirmModal } from '../components/form-kit.js';
import {
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  confirmTransfer,
  cancelTransfer,
  getTransferStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/transfers.js';
import { createPager } from '../services/pager.js';
import { createPagerFooter } from '../components/pager-footer.js';
import { listAccounts } from '../services/accounts.js';
import { accountLabel, isAccountLinkedGoal, goalSavedCents } from '../core/model.js';
import {
  listGoals, listGoalTransactions, listRecentGoalTransactions, transferableGoals, depositToGoal, withdrawFromGoal,
} from '../services/goals.js';

import { todayInAppZone, currentMonthKey } from '../utils/dates.js';
import { newOperationId } from '../services/financeApi.js';
import { openReversalModal } from '../components/reversal-modal.js';
import { listReversals } from '../services/reversals.js';
import { readReversals, reversalsUnavailable, loadErrorMessage } from '../utils/reversalsAccess.js';
import { describeError } from '../utils/errors.js';
export const meta = { title: 'Transferências', icon: 'arrow-left-right' };

let currentUser = null;
let transfersCache = [];
let pager = null;
let accountsCache = [];
let goalsCache = [];
let goalSaved = new Map(); // goalId → centavos guardados (aportes − resgates)
let goalTxCounts = new Map();
let recentGoalTxs = [];
let reversedGoalTxIds = new Set(); // movimentos de meta já estornados (VF-ARQ-02)
let reversalsUnknown = false; // leitura de estornos negada (Rules antigas): estornos DESCONHECIDOS → modo limitado de metas
let currentTransferEdit = null;
const GOAL_PREFIX = 'goal:'; // valor das opções de meta nos selects (contas usam o próprio id)
let currentFilter = { status: 'all', month: null };

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  try {
    await loadData();
  } catch (error) {
    // `app.js` não aguarda o render: sem este tratamento uma falha de carga (rede, indisponibilidade…) deixaria a tela em branco.
    console.error('[transferencias] falha ao carregar', error);
    container.replaceChildren(el('section', { class: 'panel' }, [el('div', { class: 'panel__body' }, [
      el('p', { class: 'notice', role: 'alert', id: 'transfers-load-error', text: `Não foi possível carregar as transferências. ${loadErrorMessage(error, describeError)}` }),
    ])]));
    return;
  }
  renderPage(container);
}

/** Carrega dados iniciais. */
async function loadData() {
  // Paginação por cursor (VF-4-03): só a página mais recente; "Carregar mais antigas" no rodapé.
  pager = createPager({
    fetchPage: ({ limit, startAfterId }) => listTransfers(currentUser.uid, { limit, startAfterId }),
  });
  [, accountsCache, goalsCache, recentGoalTxs] = await Promise.all([
    pager.loadFirst(),
    listAccounts(currentUser.uid),
    listGoals(currentUser.uid),
    listRecentGoalTransactions(currentUser.uid, 20),
  ]);
  transfersCache = pager.items;
  // Leitura negada ≠ "nenhum estorno": fica DESCONHECIDO (modo limitado); qualquer outro erro propaga e a tela mostra o erro.
  const reversals = await readReversals(listReversals(currentUser.uid, { limit: 500 }), { tolerate: true });
  const txs = await Promise.all(goalsCache.map(async (g) => [g.id, await listGoalTransactions(currentUser.uid, g.id, { tolerateReversalsDenied: true })]));
  reversalsUnknown = reversalsUnavailable(reversals) || txs.some(([, rows]) => rows.reversalsUnavailable === true);
  reversedGoalTxIds = new Set(reversals.filter((r) => r.targetCollection === 'goalTransactions').map((r) => r.targetId));
  goalSaved = reversalsUnknown ? new Map() : new Map(txs.map(([id, rows]) => [id, goalSavedCents(rows)]));
  goalTxCounts = new Map(txs.map(([id, rows]) => [id, rows.length]));
}

/** Metas que recebem aportes por transferência (ativas, sem vínculo de conta). */
const goalDestinations = () => (reversalsUnknown ? [] : transferableGoals(goalsCache, goalTxCounts)); // modo limitado: o guardado é desconhecido
/** Metas de onde dá para sacar: com valor guardado, ativas/concluídas, sem vínculo de conta. */
const goalSources = () => (reversalsUnknown ? [] : goalsCache).filter((g) => ['active', 'completed'].includes(g.status)
  && !isAccountLinkedGoal(g, goalTxCounts.get(g.id)) && (goalSaved.get(g.id) ?? 0) > 0);
const goalName = (id) => goalsCache.find((g) => g.id === id)?.name ?? id;

async function loadMore() {
  await pager.loadMore();
  transfersCache = pager.items;
  renderPage($('.content') || document.getElementById('page-content'));
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'arrow-left-right', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Transferências' }),
        el('p', { class: 'card__hint', text: 'Movimentações entre contas e aportes em metas — nunca contam como receita ou despesa.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openTransferModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova transferência',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Transferido no mês', formatCents(stats.confirmedThisMonth), 'arrow-left-right', null, 'Apenas confirmadas movem saldo'),
    createStatCard('Pendentes', String(stats.pendingCount), 'clock', null, 'Aguardando confirmação'),
  ]);

  const filterBar = createFilterBar();
  const table = createTransfersTable();

  const limitedNotice = reversalsUnknown
    ? el('p', { class: 'notice', role: 'alert', id: 'reversals-unavailable', text: 'Limitação: não foi possível ler os estornos (as regras de acesso publicadas ainda não incluem essa coleção). Aportes e resgates de metas, o valor guardado e o histórico de movimentos de meta estão indisponíveis até a publicação; transferências entre contas não são afetadas.' })
    : null;
  const nodes = [
    header,
    limitedNotice,
    cards,
    filterBar,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Transferências registradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${getFilteredTransfers().length} registro${getFilteredTransfers().length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
    createPagerFooter({ pager, noun: 'transferências', onLoadMore: loadMore }),
    createGoalMovementsPanel(),
  ];

  container.replaceChildren(...nodes.filter(Boolean));
  refreshIcons();
}

/** Histórico recente de aportes (conta → meta) e resgates (meta → conta). */
function createGoalMovementsPanel() {
  if (reversalsUnknown) return null; // sem estornos legíveis, o histórico (e o botão Estornar) não é confiável
  if (!recentGoalTxs.length) return null;
  const head = el('tr', {}, ['Data', 'Movimento', 'Meta', 'Conta', 'Valor', 'Situação'].map((t, i) => el('th', { class: i === 4 ? 'num' : '', text: t })));
  const body = recentGoalTxs.map((t) => el('tr', {}, [
    el('td', { text: formatDate(t.date) }),
    el('td', { text: t.type === 'deposit' ? 'Aporte (conta → meta)' : 'Resgate (meta → conta)' }),
    el('td', { text: goalName(t.goalId) }),
    el('td', { text: getAccountLabel(t.accountId) }),
    el('td', { class: 'num', text: formatCents(Number(t.amountCents) || 0) }),
    el('td', {}, reversedGoalTxIds.has(t.id)
      ? [el('span', { class: 'badge', text: 'Estornado' })]
      : [el('button', {
        type: 'button', class: 'btn btn--icon btn--danger', 'aria-label': 'Estornar movimentação da meta', title: 'Estornar (lançamento compensatório)',
        onClick: () => openReversalModal({
          user: currentUser, kind: 'goalTransaction', targetId: t.id, amountCents: Number(t.amountCents) || 0,
          summary: `${t.type === 'deposit' ? 'Aporte' : 'Resgate'} — ${goalName(t.goalId)} — ${formatCents(Number(t.amountCents) || 0)}`,
          onDone: async () => { await loadData(); renderPage($('.content') || document.getElementById('page-content')); },
        }),
        html: '<i data-lucide="undo-2" aria-hidden="true"></i>',
      })]),
  ]));
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Aportes e resgates em metas' }),
      el('div', { class: 'topbar__spacer' }),
      el('span', { class: 'badge', text: 'Últimos 20' }),
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [
      el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [el('thead', {}, [head]), el('tbody', {}, body)])]),
    ]),
  ]);
}

/** Computa estatísticas rápidas do mês atual. */
function computeStats() {
  const month = currentMonthKey(); // mês corrente no fuso America/Sao_Paulo

  let confirmedThisMonth = 0;
  let pendingCount = 0;

  for (const transfer of transfersCache) {
    const isThisMonth = String(transfer.date).slice(0, 7) === month;

    if (transfer.status === 'confirmed' && isThisMonth) {
      confirmedThisMonth += Number(transfer.amountCents) || 0;
    }
    if (transfer.status === 'pending') {
      pendingCount++;
    }
  }

  return { confirmedThisMonth, pendingCount };
}

/** Cria barra de filtros. */
function createFilterBar() {
  const statusOptions = [
    { value: 'all', label: 'Todos' },
    { value: 'pending', label: 'Pendentes' },
    { value: 'confirmed', label: 'Confirmadas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];

  const monthOptions = [{ value: '', label: 'Todos os meses' }];
  const months = new Set();
  for (const transfer of transfersCache) {
    const m = transfer.date?.substring(0, 7);
    if (m) months.add(m);
  }
  const sortedMonths = Array.from(months).sort().reverse();
  for (const m of sortedMonths) {
    const [y, mo] = m.split('-');
    monthOptions.push({ value: m, label: `${mo}/${y}` });
  }

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Filtros' }),
    ]),
    el('div', { class: 'panel__body filter-body' }, [
      el('div', { class: 'form__row filter-row' }, [
        el('div', { class: 'form__field filter-field' }, [
          el('label', { for: 'filter-status', text: 'Status' }),
          el('select', {
            id: 'filter-status',
            value: currentFilter.status,
            onChange: (e) => {
              currentFilter.status = e.target.value;
              refreshTable();
            },
          }, statusOptions.map((o) => el('option', { value: o.value, selected: currentFilter.status === o.value }, o.label))),
        ]),
        el('div', { class: 'form__field filter-field' }, [
          el('label', { for: 'filter-month', text: 'Mês' }),
          el('select', {
            id: 'filter-month',
            value: currentFilter.month ?? '',
            onChange: (e) => {
              currentFilter.month = e.target.value || null;
              refreshTable();
            },
          }, monthOptions.map((o) => el('option', { value: o.value, selected: currentFilter.month === o.value }, o.label))),
        ]),
      ]),
    ]),
  ]);
}

/** Retorna transferências filtradas. */
function getFilteredTransfers() {
  return transfersCache.filter((transfer) => {
    if (currentFilter.status !== 'all' && transfer.status !== currentFilter.status) return false;
    if (currentFilter.month && !transfer.date?.startsWith(currentFilter.month)) return false;
    return true;
  });
}

/** Atualiza apenas a tabela. */
function refreshTable() {
  const tableContainer = $('#transfers-table-container');
  if (tableContainer) {
    tableContainer.replaceWith(createTransfersTable());
    refreshIcons();
  }
}

/** Cria a tabela de transferências. */
function createTransfersTable() {
  const filtered = getFilteredTransfers();

  if (!filtered.length) {
    return el('div', { id: 'transfers-table-container', class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'arrow-left-right', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma transferência encontrada' }),
      el('p', { class: 'empty__text', text: currentFilter.status !== 'all' || currentFilter.month
        ? 'Tente ajustar os filtros acima.'
        : 'Transfira entre contas mantendo o histórico auditável e o patrimônio correto.' }),
      (currentFilter.status !== 'all' || currentFilter.month) ? el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        onClick: () => {
          currentFilter = { status: 'all', month: null };
          refreshTable();
        },
        text: 'Limpar filtros',
      }) : null,
    ]);
  }

  const columns = [
    { key: 'fromAccountId', label: 'Origem', render: (v) => getAccountLabel(v) },
    { key: 'toAccountId', label: 'Destino', render: (v) => getAccountLabel(v) },
    { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'date', label: 'Data', render: (v) => formatDate(v) },
    { key: 'reason', label: 'Motivo' },
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = filtered.map((transfer) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = transfer[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, createTransferActions(transfer)),
    ])
  );

  return el('div', { id: 'transfers-table-container', class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Cria botões de ação para uma transferência. */
function createTransferActions(transfer) {
  const actions = [];

  if (transfer.status === 'pending') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--success',
        'aria-label': `Confirmar transferência de ${formatCents(transfer.amountCents)}`,
        onClick: () => confirmTransferAction(transfer),
        html: '<i data-lucide="check-circle-2" aria-hidden="true"></i>',
      })
    );
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Cancelar transferência`,
        onClick: () => confirmCancelTransfer(transfer),
        html: '<i data-lucide="x-circle" aria-hidden="true"></i>',
      })
    );
  }

  // VF-ARQ-02: transferência CONFIRMADA é imutável (move dinheiro): só estorno compensatório pelo servidor.
  if (transfer.status === 'confirmed') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': 'Estornar transferência',
        title: 'Estornar (lançamento compensatório)',
        onClick: () => openReversalModal({
          user: currentUser, kind: 'transfer', targetId: transfer.id, amountCents: Number(transfer.amountCents) || 0,
          summary: `${getAccountLabel(transfer.fromAccountId)} → ${getAccountLabel(transfer.toAccountId)} — ${formatCents(Number(transfer.amountCents) || 0)}`,
          onDone: async () => { await loadData(); renderPage($('.content') || document.getElementById('page-content')); },
        }),
        html: '<i data-lucide="undo-2" aria-hidden="true"></i>',
      })
    );
    return actions;
  }

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `Editar transferência`,
      onClick: () => openTransferModal(transfer),
      html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
    })
  );

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon btn--danger',
      'aria-label': `Excluir transferência`,
      onClick: () => confirmDeleteTransfer(transfer),
      html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
    })
  );

  return actions;
}

/** Abre modal para criar/editar transferência. */
function openTransferModal(transfer = null) {
  const isEdit = !!transfer;
  const operationId = newOperationId(); // idempotência da criação: duplo clique/retry desta abertura não duplica
  currentTransferEdit = transfer;
  const statuses = getTransferStatusOptions();
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');

  const form = el('form', { id: 'transfer-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'fromAccountId', text: 'Origem *' }),
        el('select', {
          id: 'fromAccountId',
          name: 'fromAccountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !transfer }, 'Selecione a origem'),
          el('optgroup', { label: 'Contas' }, activeAccounts.map((a) =>
            el('option', { value: a.id, selected: transfer?.fromAccountId === a.id }, accountLabel(a))
          )),
          ...(!isEdit && goalSources().length ? [el('optgroup', { label: 'Metas (sacar o guardado)' }, goalSources().map((g) =>
            el('option', { value: `${GOAL_PREFIX}${g.id}` }, `Meta: ${g.name} (guardado ${formatCents(goalSaved.get(g.id) ?? 0)})`)
          ))] : []),
        ]),
        el('span', { class: 'form__error', 'data-for': 'fromAccountId' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'toAccountId', text: 'Destino *' }),
        el('select', {
          id: 'toAccountId',
          name: 'toAccountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !transfer }, 'Selecione o destino'),
          el('optgroup', { label: 'Contas' }, activeAccounts.map((a) =>
            el('option', { value: a.id, selected: transfer?.toAccountId === a.id }, accountLabel(a))
          )),
          ...(!isEdit && goalDestinations().length ? [el('optgroup', { label: 'Metas (guardar / investir)' }, goalDestinations().map((g) =>
            el('option', { value: `${GOAL_PREFIX}${g.id}` }, `Meta: ${g.name} (guardado ${formatCents(goalSaved.get(g.id) ?? 0)} de ${formatCents(g.targetCents)})`)
          ))] : []),
        ]),
        el('span', { class: 'form__error', 'data-for': 'toAccountId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'amountCents', text: 'Valor (R$) *' }),
        el('input', {
          type: 'text',
          id: 'amountCents',
          name: 'amountCents',
          required: true,
          placeholder: '0,00',
          value: transfer?.amountCents ? formatCentsInput(transfer.amountCents) : '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'amountCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'date', text: 'Data *' }),
        el('input', {
          type: 'date',
          id: 'date',
          name: 'date',
          required: true,
          value: transfer?.date ?? todayInAppZone(),
        }),
        el('span', { class: 'form__error', 'data-for': 'date' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'reason', text: 'Motivo *' }),
        el('input', {
          type: 'text',
          id: 'reason',
          name: 'reason',
          required: true,
          maxlength: 120,
          value: transfer?.reason ?? '',
          placeholder: 'Ex.: Reserva, investimento, aporte em meta...',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'reason' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: transfer?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
        el('span', { class: 'card__hint', id: 'goal-transfer-hint', hidden: true, text: 'Com uma meta, o aporte/resgate é efetivado na hora e o saldo das contas é atualizado.' }),
      ]),
    ]),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', {
        id: 'notes',
        name: 'notes',
        maxlength: 500,
        rows: 3,
        value: transfer?.notes ?? '',
      }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar transferência' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar transferência: ${transfer.reason}` : 'Nova transferência',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#amountCents', modal.overlay);
  moneyInput.addEventListener('blur', () => {
    const cents = parseMoneyToCents(moneyInput.value);
    moneyInput.value = cents !== null ? formatCentsInput(cents) : '';
  });

  // Validação de conta origem ≠ destino
  const fromSelect = $('#fromAccountId', form);
  const toSelect = $('#toAccountId', form);
  const statusSelect = $('#status', form);
  const goalHint = $('#goal-transfer-hint', form);
  const syncGoalMode = () => {
    const withGoal = fromSelect.value.startsWith(GOAL_PREFIX) || toSelect.value.startsWith(GOAL_PREFIX);
    statusSelect.disabled = withGoal;
    if (withGoal) statusSelect.value = 'confirmed';
    goalHint.hidden = !withGoal;
  };
  const validateAccounts = () => {
    syncGoalMode();
    if (fromSelect.value && toSelect.value && fromSelect.value === toSelect.value) {
      toSelect.setCustomValidity('A conta de destino deve ser diferente da conta de origem.');
      toSelect.reportValidity();
    } else {
      toSelect.setCustomValidity('');
    }
  };
  fromSelect.addEventListener('change', validateAccounts);
  toSelect.addEventListener('change', validateAccounts);

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const formData = new FormData(form);
    const rawData = {
      fromAccountId: formData.get('fromAccountId'),
      toAccountId: formData.get('toAccountId'),
      amountCents: formData.get('amountCents'),
      date: formData.get('date'),
      reason: formData.get('reason').trim(),
      status: formData.get('status'),
      notes: formData.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = await submitTransfer(isEdit ? rawData : { ...rawData, operationId });

    if (result.ok) {
      toast(result.goalMovement === 'deposit' ? 'Aporte na meta registrado — saldo da conta atualizado.'
        : result.goalMovement === 'withdraw' ? 'Resgate da meta registrado — valor devolvido à conta.'
        : (isEdit ? 'Transferência atualizada com sucesso.' : 'Transferência criada com sucesso.'));
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar transferência';
  }

  form.addEventListener('submit', handleSubmit);
  $('#fromAccountId', form).focus();
}

/**
 * Cria/edita a transferência. Se origem ou destino for uma META, vira aporte (conta → meta) ou resgate
 * (meta → conta) pelo serviço de metas (atômico, saldo derivado, com checagem de saldo); metas não aparecem
 * como conta e não há transferência entre metas. Erros dos campos de conta voltam ao select correspondente.
 */
async function submitTransfer(rawData) {
  const isGoal = (v) => String(v ?? '').startsWith(GOAL_PREFIX);
  const goalId = (v) => String(v).slice(GOAL_PREFIX.length);
  const { fromAccountId: from, toAccountId: to, operationId } = rawData;
  if (!isGoal(from) && !isGoal(to)) {
    return currentTransferEdit
      ? updateTransfer(currentUser.uid, currentTransferEdit.id, rawData)
      : createTransfer(currentUser.uid, rawData); // rawData.operationId = chave de idempotência da intenção
  }
  if (currentTransferEdit) return { ok: false, errors: { _form: 'Aportes e resgates de metas não podem ser editados; exclua-os pela meta ou registre outro.' } };
  if (isGoal(from) && isGoal(to)) return { ok: false, errors: { toAccountId: 'Não há transferência entre metas: resgate para uma conta primeiro.' } };
  const notes = [rawData.reason, rawData.notes].filter(Boolean).join(' — ').slice(0, 300);
  const base = { amountCents: rawData.amountCents, date: rawData.date, notes, operationId };
  const deposit = isGoal(to);
  const result = deposit
    ? await depositToGoal(currentUser.uid, goalId(to), { ...base, accountId: from })
    : await withdrawFromGoal(currentUser.uid, goalId(from), { ...base, accountId: to });
  if (result.ok) return { ...result, goalMovement: deposit ? 'deposit' : 'withdraw' };
  const errors = { ...result.errors };
  if (errors.accountId) { errors[deposit ? 'fromAccountId' : 'toAccountId'] = errors.accountId; delete errors.accountId; }
  // Erro da meta (ex.: resgate acima do guardado) aparece junto do select da meta, não só em toast.
  if (errors._form) { errors[deposit ? 'toAccountId' : 'fromAccountId'] = errors._form; delete errors._form; }
  return { ok: false, errors };
}

/** Confirma transferência. */
async function confirmTransferAction(transfer) {
  const result = await confirmTransfer(currentUser.uid, transfer.id);
  if (result.ok) {
    toast('Transferência confirmada — saldo das contas atualizado.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form || 'Erro ao confirmar transferência.', 5000);
  }
}

/** Pede confirmação (cancelar é terminal) e só então cancela. */
function confirmCancelTransfer(transfer) {
  confirmModal({
    title: 'Cancelar transferência',
    message: `Cancelar a transferência "${transfer.reason ?? "transferência"}"?`,
    hint: 'A transferência cancelada não será efetivada.',
    confirmLabel: 'Cancelar transferência',
    onConfirm: async () => {
      const result = await cancelTransfer(currentUser.uid, transfer.id);
      if (result.ok) {
        toast('Transferência cancelada.');
        await loadData();
        renderPage($('.content') || document.getElementById('page-content'));
      } else {
        toast(result.errors?._form || 'Erro ao cancelar.', 5000);
      }
    },
  });
}

/** Confirma exclusão. */
function confirmDeleteTransfer(transfer) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a transferência "${transfer.reason}"?` }),
    el('p', { class: 'card__hint', text: transfer.status === 'confirmed'
      ? `Transferência confirmada: ao excluir, ${formatCents(Number(transfer.amountCents) || 0)} voltam para ${getAccountLabel(transfer.fromAccountId)} e saem de ${getAccountLabel(transfer.toAccountId)} (o saldo é calculado dos lançamentos, nada é regravado). Esta ação não pode ser desfeita.`
      : 'Transferência não confirmada: o saldo de nenhuma conta é afetado. Esta ação não pode ser desfeita.' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteTransfer(currentUser.uid, transfer.id);
        if (result.ok) {
          toast(result.reversed ? `Transferência excluída — ${formatCents(result.amountCents)} estornados entre as contas.` : 'Transferência excluída.');
          await loadData();
          renderPage($('.content') || document.getElementById('page-content'));
        } else {
          toast(`Erro: ${result.errors._form}`, 5000);
        }
      },
      text: 'Excluir',
    }),
  ];

  openModal({ title: 'Confirmar exclusão', body, footer });
}

function getAccountLabel(accountId) {
  const acc = accountsCache.find((a) => a.id === accountId);
  return acc ? accountLabel(acc) : accountId ?? '—';
}

function getStatusLabel(value) {
  const statuses = getTransferStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}
