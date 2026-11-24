/**
 * Serviço de Cartões, Compras e Faturas (VF-2-03d). Contrato = firestore.rules.
 * - Limite usado/disponível e total de fatura aberta são DERIVADOS; `totalCents` é gravado
 *   só no fechamento e `paidCents` só no pagamento.
 * - Compra parcelada = N documentos `cardPurchases` (valor dividido em centavos inteiros, resto
 *   na 1ª), cada um ligado à fatura do seu mês. Faturas ausentes são criadas ANTES (lote próprio,
 *   `commitAtomic`, ID determinístico `${cardId}_${AAAA-MM}`) e as parcelas vão em outro lote
 *   atômico — as Rules usam exists() e não enxergam documentos do mesmo lote.
 * - Ciclo: compra após o dia de fechamento vai para a fatura seguinte; faturas não abertas
 *   são puladas. Fatura: open → closed (soma das parcelas) → paid (pagamento integral).
 * Limitações: leitura prévia + lote sem transação (compras simultâneas podem estourar o limite
 * ou regravar uma fatura recém-criada); pagar a fatura NÃO movimenta conta (o schema `invoices`
 * não tem `accountId`); sem cancelamento de fatura nem pagamento parcial.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { financeResult } from './financeApi.js';
import { todayInAppZone } from '../utils/dates.js';
import {
  list,
  getById,
  count,
  createAudited,
  updateAudited,
  removeAudited,
  commitAtomic,
} from './firestore.js';
import {
  buildEntity,
  checkCategoryForMovement,
  addMonths,
  cardLimitUsage,
  centsToMoneyString,
  invoiceDatesFor,
  clampDayInMonth,
  invoiceMonthForPurchase,
  invoiceTotalCents,
  splitInstallments,
  consolidationDeltaCents,
  parseMoneyToCents,
  formatCents,
  isValidIsoDate,
  SCHEMAS,
  CARD_STATUSES,
  INVOICE_STATUSES,
} from '../core/model.js';

const CARDS = COLLECTIONS.creditCards;
const PURCHASES = COLLECTIONS.cardPurchases;
const INVOICES = COLLECTIONS.invoices;
const PURCHASE_CATEGORY_KINDS = SCHEMAS.cardPurchases.fields.categoryId.kindCompat;

const byCard = (cardId) => ({ where: [['cardId', '==', cardId]] });

export async function listCards(uid, options = {}) {
  const constraints = { orderBy: ['createdAt', 'desc'] };
  if (options.where) constraints.where = options.where;
  return list(uid, CARDS, constraints);
}
export const getCard = (uid, cardId) => getById(uid, CARDS, cardId);
export const listCardPurchases = (uid, cardId) => list(uid, PURCHASES, byCard(cardId));
export const listInvoices = (uid, cardId) => list(uid, INVOICES, byCard(cardId));

async function usageOf(uid, card, io) {
  const fetchList = io.list ?? list;
  const [purchases, invoices] = await Promise.all([
    fetchList(uid, PURCHASES, byCard(card.id)),
    fetchList(uid, INVOICES, byCard(card.id)),
  ]);
  return { purchases, invoices, ...cardLimitUsage(card, purchases, invoices) };
}

async function checkOptionalAccount(uid, data, io) {
  if (!data.accountId) return null;
  const account = await (io.getById ?? getById)(uid, COLLECTIONS.accounts, data.accountId);
  return account ? null : { accountId: 'Conta não encontrada.' };
}

/** Cria cartão (status sempre `active`). Retorna { ok, id, errors }. */
export async function createCard(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('creditCards', { ...rawData, status: 'active' });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const id = await createAudited(uid, CARDS, data, io);
  return { ok: true, id };
}

/** Edita cartão não cancelado preservando status; o limite não pode ficar abaixo do usado. */
export async function updateCard(uid, cardId, rawData, io = {}) {
  const current = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!current) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (current.status === 'cancelled') return { ok: false, errors: { _form: 'Cartão cancelado não pode ser editado.' } };
  const { ok, data, errors } = buildEntity('creditCards', { ...rawData, status: current.status });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const { usedCents } = await usageOf(uid, current, io);
  if (data.limitCents < usedCents) {
    return { ok: false, errors: { limitCents: `O limite não pode ser menor que o já utilizado (${formatCents(usedCents)}).` } };
  }
  await updateAudited(uid, CARDS, cardId, data, io);
  return { ok: true };
}

const MAX_CARD_DELETE_INVOICES = 200; // 2 escritas por fatura (+ cartão) no lote de 500

/** Fatura com movimentação real: fechada/paga com total ou valor pago. Cancelada, zerada ou aberta vazia: não. */
const hasRealInvoiceMovement = (invoice) => ['closed', 'paid'].includes(invoice.status)
  && ((Number(invoice.totalCents) || 0) > 0 || (Number(invoice.paidCents) || 0) > 0);

/**
 * Exclui o cartão (VF-2-03t). Bloqueia (fail-closed) com: compras/parcelas, assinaturas vinculadas ou faturas
 * fechadas/pagas COM movimentação. Faturas canceladas, zeradas ou abertas sem compras NÃO bloqueiam: são
 * removidas junto com o cartão, no MESMO lote atômico (cada remoção com auditoria) — sem faturas órfãs.
 * Para manter o histórico de um cartão em uso, cancele-o.
 */
export async function deleteCard(uid, cardId, io = {}) {
  const card = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  let purchases;
  let subscriptions;
  let invoices;
  try {
    const countFn = io.count ?? count;
    [purchases, subscriptions, invoices] = await Promise.all([
      countFn(uid, PURCHASES, byCard(cardId)),
      countFn(uid, COLLECTIONS.subscriptions, byCard(cardId)),
      (io.list ?? list)(uid, INVOICES, byCard(cardId)),
    ]);
  } catch (error) {
    console.error('[creditCards] falha ao verificar vínculos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os vínculos do cartão. A exclusão foi cancelada por segurança; tente novamente.' } };
  }
  const moving = invoices.filter(hasRealInvoiceMovement).length;
  const used = [
    { n: purchases, label: 'compras' },
    { n: subscriptions, label: 'assinaturas' },
    { n: moving, label: 'faturas com movimentação' },
  ].filter((c) => c.n > 0);
  if (used.length) {
    return { ok: false, errors: { _form: `Este cartão não pode ser excluído: possui ${used.map((c) => `${c.n} ${c.label}`).join(', ')}. Cancele-o para manter o histórico.` } };
  }
  if (invoices.length > MAX_CARD_DELETE_INVOICES) {
    return { ok: false, errors: { _form: `Exclua primeiro as faturas vazias: máximo de ${MAX_CARD_DELETE_INVOICES} por vez.` } };
  }
  const ops = [
    ...invoices.map((i) => ({ type: 'delete', collection: INVOICES, docId: i.id, before: i })),
    { type: 'delete', collection: CARDS, docId: cardId, before: card },
  ];
  await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, removedInvoices: invoices.length };
}

/**
 * Exclui DEFINITIVAMENTE uma fatura sem compras (VF-2-03t): cancelada, ou aberta vazia (R$ 0,00). Fechada/paga
 * não é apagada (é histórico/movimento da conta). Com compras vinculadas, bloqueia. Fail-closed na leitura;
 * remoção + auditoria no mesmo lote. Liberar a fatura cancelada também libera o mês para novas compras.
 */
export async function deleteInvoice(uid, invoiceId, io = {}) {
  const invoice = await (io.getById ?? getById)(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (!['cancelled', 'open'].includes(invoice.status)) {
    return { ok: false, errors: { _form: 'Faturas fechadas ou pagas são histórico e não podem ser excluídas.' } };
  }
  let linked;
  try {
    linked = await (io.count ?? count)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
  } catch (error) {
    console.error('[creditCards] falha ao verificar compras da fatura', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar as compras da fatura. A exclusão foi interrompida por segurança.' } };
  }
  if (linked > 0) return { ok: false, errors: { _form: `A fatura possui ${linked} parcela(s) de compras e não pode ser excluída.` } };
  await (io.commitAtomic ?? commitAtomic)(uid, [{ type: 'delete', collection: INVOICES, docId: invoiceId, before: invoice }], io);
  return { ok: true };
}

const CARD_ACTIONS = Object.freeze({ blocked: 'block', active: 'unblock', cancelled: 'cancel' });
const CARD_TRANSITIONS = Object.freeze({ active: ['blocked', 'cancelled'], blocked: ['active', 'cancelled'], cancelled: [] });

/** Bloqueia/desbloqueia/cancela (terminal; só sem limite utilizado). */
export async function setCardStatus(uid, cardId, status, io = {}) {
  if (!CARD_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!current) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (!(CARD_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para este cartão.' } };
  }
  if (status === 'cancelled') {
    const { usedCents } = await usageOf(uid, current, io);
    if (usedCents > 0) {
      return { ok: false, errors: { _form: `O cartão possui ${formatCents(usedCents)} em faturas não pagas; quite-as antes de cancelar.` } };
    }
  }
  await updateAudited(uid, CARDS, cardId, { status }, io, CARD_ACTIONS[status]);
  return { ok: true };
}
export const blockCard = (uid, id, io) => setCardStatus(uid, id, 'blocked', io);
export const unblockCard = (uid, id, io) => setCardStatus(uid, id, 'active', io);
export const cancelCard = (uid, id, io) => setCardStatus(uid, id, 'cancelled', io);

/** Resumo derivado do cartão: { usedCents, availableCents }. */
export async function getCardLimitUsage(uid, cardId, io = {}) {
  const card = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!card) return null;
  const { usedCents, availableCents } = await usageOf(uid, card, io);
  return { usedCents, availableCents };
}

/** Como `getCardLimitUsage`, mais as faturas e compras lidas (a tela de Cartões deriva a fatura do mês sem reler). */
export async function getCardUsageDetails(uid, card, io = {}) {
  const { usedCents, availableCents, invoices, purchases } = await usageOf(uid, card, io);
  return { usedCents, availableCents, invoices, purchases };
}

/**
 * Lança compra (parcelada ou não) em cartão ATIVO. `rawData`: { description, amountCents (TOTAL),
 * purchaseDate, installmentsTotal (padrão 1), categoryId?, notes? }.
 * Retorna { ok, ids, invoiceMonths, errors }. Parcelas em um único lote atômico (faturas novas, em lote anterior).
 */
export async function registerCardPurchase(uid, cardId, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const card = await fetch(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (card.status !== 'active') return { ok: false, errors: { _form: 'Só é possível lançar compras em cartões ativos.' } };

  const total = rawData?.installmentsTotal === undefined || rawData.installmentsTotal === '' ? 1 : rawData.installmentsTotal;
  const probe = buildEntity('cardPurchases', { ...rawData, cardId, installmentsTotal: total, installmentNumber: 1 });
  if (!probe.ok) return { ok: false, errors: probe.errors };
  const n = probe.data.installmentsTotal;
  const parts = splitInstallments(probe.data.amountCents, n);
  if (!parts) return { ok: false, errors: { amountCents: 'O valor deve ser de ao menos 1 centavo por parcela.' } };

  if (probe.data.categoryId) {
    const category = await fetch(uid, COLLECTIONS.categories, probe.data.categoryId);
    const check = checkCategoryForMovement(category, PURCHASE_CATEGORY_KINDS);
    if (!check.ok) return check;
  }

  // Compra feita para um devedor (VF-2-03i): devedor em aberto ou quitado; o valor soma ao emprestado dele.
  let debtor = null;
  if (probe.data.debtorId) {
    debtor = await fetch(uid, COLLECTIONS.debtors, probe.data.debtorId);
    if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
    // Quitado (`paid`) também recebe compras: a compra o reabre no mesmo lote. Cancelado precisa ser reaberto antes.
    if (!['open', 'paid'].includes(debtor.status)) return { ok: false, errors: { debtorId: 'Reabra o devedor cancelado antes de vincular compras.' } };
  }

  const { invoices, availableCents } = await usageOf(uid, card, io);
  if (probe.data.amountCents > availableCents) {
    return { ok: false, errors: { amountCents: `O valor excede o limite disponível (${formatCents(availableCents)}).` } };
  }

  const byMonth = new Map(invoices.map((i) => [i.referenceMonth, i]));
  const planned = new Map();
  const invoiceOps = [];
  const purchaseOps = [];
  const base = invoiceMonthForPurchase(card, probe.data.purchaseDate);
  let previous = null;
  for (let number = 1; number <= n; number += 1) {
    let month = addMonths(base, number - 1);
    if (previous && month <= previous) month = addMonths(previous, 1);
    while (byMonth.has(month) && byMonth.get(month).status !== 'open') month = addMonths(month, 1);
    previous = month;
    const invoiceId = byMonth.get(month)?.id ?? `${cardId}_${month}`;
    if (!byMonth.has(month) && !planned.has(month)) {
      planned.set(month, invoiceId);
      invoiceOps.push({
        type: 'create', collection: INVOICES, docId: invoiceId,
        data: { cardId, referenceMonth: month, ...invoiceDatesFor(card, month), status: 'open' },
      });
    }
    const part = buildEntity('cardPurchases', {
      ...rawData, cardId, installmentsTotal: n, installmentNumber: number, invoiceId,
      amountCents: centsToMoneyString(parts[number - 1]),
    });
    if (!part.ok) return { ok: false, errors: part.errors };
    // `io.purchaseDocIds[n-1]`: id determinístico (ex.: assinatura × data) — regravar o mesmo id é um UPDATE, negado pelas Rules
    // (compra lançada é imutável), então um lote repetido/concorrente falha inteiro e NÃO duplica a compra nem soma no devedor.
    purchaseOps.push({ type: 'create', collection: PURCHASES, ...(io.purchaseDocIds?.[number - 1] ? { docId: io.purchaseDocIds[number - 1] } : {}), data: part.data });
  }

  // As Rules validam `invoiceId` com exists() (estado ANTERIOR ao lote): uma parcela não pode
  // referenciar fatura criada no mesmo lote. Por isso são dois lotes: 1) faturas novas, 2) parcelas
  // (todas atômicas entre si). Falha no 2º deixa faturas abertas vazias, reaproveitadas depois.
  const commit = io.commitAtomic ?? commitAtomic;
  if (invoiceOps.length) await commit(uid, invoiceOps, io);
  // `io.extraOps` (ex.: avançar a próxima cobrança da assinatura) entra no MESMO lote das parcelas.
  if (io.extraOps?.length) purchaseOps.push(...io.extraOps);
  // O devedor é atualizado no MESMO lote das parcelas (atômico): lentCents += total da compra.
  if (debtor) {
    purchaseOps.push({
      type: 'update', collection: COLLECTIONS.debtors, docId: probe.data.debtorId, action: 'card-purchase',
      data: debtor.status === 'paid' ? { status: 'open' } : {}, increments: { lentCents: probe.data.amountCents },
    });
  }
  const ids = await commit(uid, purchaseOps, io);
  return { ok: true, ids, invoiceMonths: [...new Set(purchaseOps.filter((o) => o.collection === PURCHASES).map((o) => o.data.invoiceId))] };
}

/** Exclui parcela de compra só se a fatura estiver aberta (ou sem fatura). */
export async function deleteCardPurchase(uid, purchaseId, io = {}) {
  const fetch = io.getById ?? getById;
  const purchase = await fetch(uid, PURCHASES, purchaseId);
  if (!purchase) return { ok: false, errors: { _form: 'Compra não encontrada.' } };
  if (purchase.debtorId) {
    // Excluir exigiria estornar o emprestado do devedor (possivelmente já recebido): bloqueado.
    return { ok: false, errors: { _form: 'Esta compra está vinculada a um devedor e não pode ser excluída.' } };
  }
  if (purchase.invoiceId) {
    const invoice = await fetch(uid, INVOICES, purchase.invoiceId);
    if (invoice && invoice.status !== 'open') {
      return { ok: false, errors: { _form: 'A fatura desta compra já está fechada ou paga.' } };
    }
  }
  await removeAudited(uid, PURCHASES, purchaseId, purchase, io);
  return { ok: true };
}

/**
 * Corrige uma parcela de compra. A compra lançada é imutável nas Rules (não há `update`), então a correção é uma TROCA ATÔMICA:
 * a parcela é excluída e outra, com os dados corrigidos, é criada no MESMO lote (tudo ou nada; auditoria de exclusão + criação).
 * Editáveis: descrição, categoria e, só em compra à vista (1/1), a data — que pode mudar a fatura (faturas novas são criadas
 * antes, como no lançamento). Valor, parcelas, cartão e devedor não mudam (exclua e lance de novo). Exige fatura aberta, compra sem
 * devedor e que não seja de assinatura. `rawData`: { description, purchaseDate, categoryId?, notes? }.
 * Retorna { ok, id, invoiceMonth, errors }.
 */
export async function updateCardPurchase(uid, purchaseId, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const purchase = await fetch(uid, PURCHASES, purchaseId);
  if (!purchase) return { ok: false, errors: { _form: 'Compra não encontrada.' } };
  if (purchase.debtorId) return { ok: false, errors: { _form: 'Esta compra está vinculada a um devedor e não pode ser alterada.' } };
  if (purchase.notes === 'Assinatura') return { ok: false, errors: { _form: 'Compra gerada por assinatura: altere a assinatura em Assinaturas.' } };
  const current = purchase.invoiceId ? await fetch(uid, INVOICES, purchase.invoiceId) : null;
  if (current && current.status !== 'open') return { ok: false, errors: { _form: 'A fatura desta compra já está fechada ou paga.' } };
  const card = await fetch(uid, CARDS, purchase.cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };

  const single = purchase.installmentsTotal === 1;
  const purchaseDate = rawData.purchaseDate || purchase.purchaseDate;
  const dateChanged = purchaseDate !== purchase.purchaseDate;
  if (dateChanged && !single) {
    return { ok: false, errors: { purchaseDate: 'Compra parcelada: a data não pode ser alterada. Exclua as parcelas e lance a compra de novo.' } };
  }
  const categoryId = 'categoryId' in rawData ? rawData.categoryId : purchase.categoryId;
  const notes = 'notes' in rawData ? rawData.notes : purchase.notes;

  let invoiceId = purchase.invoiceId;
  const invoiceOps = [];
  let invoiceMonth = current?.referenceMonth ?? null;
  if (dateChanged) {
    const invoices = await (io.list ?? list)(uid, INVOICES, byCard(card.id));
    const byMonth = new Map(invoices.map((i) => [i.referenceMonth, i]));
    let month = invoiceMonthForPurchase(card, purchaseDate);
    if (!month) return { ok: false, errors: { purchaseDate: 'Data inválida.' } };
    while (byMonth.has(month) && byMonth.get(month).status !== 'open') month = addMonths(month, 1);
    invoiceMonth = month;
    invoiceId = byMonth.get(month)?.id ?? `${card.id}_${month}`;
    if (!byMonth.has(month)) {
      invoiceOps.push({ type: 'create', collection: INVOICES, docId: invoiceId, data: { cardId: card.id, referenceMonth: month, ...invoiceDatesFor(card, month), status: 'open' } });
    }
  }

  const part = buildEntity('cardPurchases', {
    cardId: purchase.cardId, description: rawData.description ?? purchase.description, amountCents: centsToMoneyString(purchase.amountCents),
    purchaseDate, installmentsTotal: purchase.installmentsTotal, installmentNumber: purchase.installmentNumber,
    ...(invoiceId ? { invoiceId } : {}), ...(categoryId ? { categoryId } : {}), ...(notes ? { notes } : {}),
  });
  if (!part.ok) return { ok: false, errors: part.errors };
  if (part.data.categoryId) {
    const check = checkCategoryForMovement(await fetch(uid, COLLECTIONS.categories, part.data.categoryId), PURCHASE_CATEGORY_KINDS);
    if (!check.ok) return check;
  }

  const commit = io.commitAtomic ?? commitAtomic;
  // As Rules validam `invoiceId` com exists() no estado ANTERIOR ao lote: a fatura nova precisa existir antes da troca.
  if (invoiceOps.length) await commit(uid, invoiceOps, io);
  const ids = await commit(uid, [
    { type: 'delete', collection: PURCHASES, docId: purchase.id ?? purchaseId, before: purchase },
    { type: 'create', collection: PURCHASES, data: part.data },
  ], io);
  return { ok: true, id: ids[1], invoiceMonth };
}

const todayIso = (io) => todayInAppZone(io.now ? io.now() : new Date());

/**
 * Fecha a fatura: só a partir do dia de fechamento; grava `totalCents` (soma das parcelas
 * vinculadas) e status `closed`; auditoria `close`. Retorna { ok, totalCents, errors }.
 */
export async function closeInvoice(uid, invoiceId, io = {}) {
  const invoice = await (io.getById ?? getById)(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (invoice.status !== 'open') return { ok: false, errors: { _form: 'Só é possível fechar faturas abertas.' } };
  if (invoice.closingDate && todayIso(io) < invoice.closingDate) {
    return { ok: false, errors: { _form: 'A fatura só pode ser fechada a partir da data de fechamento.' } };
  }
  const purchases = await (io.list ?? list)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
  const totalCents = invoiceTotalCents(purchases);
  await updateAudited(uid, INVOICES, invoiceId, { status: 'closed', totalCents }, io, 'close');
  return { ok: true, totalCents };
}

/**
 * Lançamento CONSOLIDADO de fatura (VF-2-03r): uma única parcela (1x) que representa gastos do mês sem cadastrar
 * compra a compra. `rawData`: { referenceMonth "YYYY-MM", amountCents (string pt-BR), description? }.
 * Cai na fatura de `referenceMonth` (data = dia de fechamento daquele mês). A fatura precisa estar ABERTA ou ainda
 * não existir: fechada/paga/cancelada NÃO é alterada (o valor liquidado fica intacto). Respeita o limite do cartão.
 * Compras de devedores e assinaturas continuam lançadas à parte (rastreáveis); o consolidado cobre só o restante
 * (ver `consolidationDeltaCents`). Retorna o mesmo formato de `registerCardPurchase`.
 */
export async function registerInvoiceConsolidation(uid, cardId, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const card = await fetch(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  const month = String(rawData.referenceMonth ?? '');
  const purchaseDate = clampDayInMonth(month, Number(card.closingDay));
  if (!purchaseDate) return { ok: false, errors: { referenceMonth: 'Mês inválido (use MM/AAAA).' } };
  const invoices = await (io.list ?? list)(uid, INVOICES, byCard(cardId));
  const existing = invoices.find((i) => i.referenceMonth === month);
  if (existing && existing.status !== 'open') {
    return { ok: false, errors: { referenceMonth: `A fatura de ${month.slice(5)}/${month.slice(0, 4)} já está ${existing.status === 'paid' ? 'paga' : existing.status === 'closed' ? 'fechada' : 'cancelada'} e não é alterada.` } };
  }
  const description = String(rawData.description ?? '').trim() || `Consolidado da fatura ${month.slice(5)}/${month.slice(0, 4)}`;
  return registerCardPurchase(uid, cardId, {
    description, amountCents: rawData.amountCents, purchaseDate, installmentsTotal: 1, notes: 'Lançamento consolidado da fatura',
  }, io);
}

/**
 * Paga a fatura (`closed` ou `open` → `paid`) NO SERVIDOR (VF-ARQ-02): pagamento único, conta ativa, saldo e total
 * recalculados na transação, idempotente e seguro sob concorrência. `rawData`: { accountId, date?, operationId? }.
 * O saldo da conta continua DERIVADO (faturas pagas) e o limite do cartão é liberado. Compras no cartão não reduzem o
 * saldo bancário. Fatura zerada não é paga: cancele-a. Retorna { ok, paidCents, errors, code }.
 */
export async function payInvoice(uid, invoiceId, rawData = {}, io = {}) {
  const date = rawData.date ? String(rawData.date) : undefined;
  if (date && !isValidIsoDate(date)) return { ok: false, errors: { date: 'Data inválida (use DD/MM/AAAA).' } };
  if (!rawData.accountId) return { ok: false, errors: { accountId: 'Selecione a conta que pagou a fatura.' } };
  const r = await (io.finance ?? financeResult)('invoice.pay', {
    invoiceId, accountId: String(rawData.accountId), ...(date ? { date } : {}),
  }, { operationId: rawData.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, paidCents: r.paidCents, result: r } : r;
}

/**
 * Cancela fatura ABERTA sem compras vinculadas (ex.: fatura R$ 0,00 remanescente de compra que falhou).
 * Com compras, bloqueia (exclua as compras ou pague). Leitura fail-closed. Retorna { ok, errors }.
 */
export async function cancelInvoice(uid, invoiceId, io = {}) {
  const invoice = await (io.getById ?? getById)(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (invoice.status !== 'open') return { ok: false, errors: { _form: 'Só é possível cancelar faturas abertas.' } };
  let linked;
  try {
    linked = await (io.count ?? count)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
  } catch (error) {
    console.error('[creditCards] falha ao verificar compras da fatura', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar as compras da fatura. O cancelamento foi interrompido por segurança.' } };
  }
  if (linked > 0) return { ok: false, errors: { _form: `A fatura possui ${linked} parcela(s) de compras e não pode ser cancelada.` } };
  await updateAudited(uid, INVOICES, invoiceId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

export const getCardStatusOptions = () => CARD_STATUSES.map((s) => ({ value: s.value, label: s.label }));
export const getInvoiceStatusOptions = () => INVOICE_STATUSES.map((s) => ({ value: s.value, label: s.label }));

export { consolidationDeltaCents, cardLimitUsage, invoiceTotalCents, formatCents, parseMoneyToCents };
