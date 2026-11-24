/**
 * Serviço de Assinaturas (VF-2-03a): CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/subscriptions. Contrato = firestore.rules.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import { registerCardPurchase } from './creditCards.js';
import {
  chargeDocId,
  usesDebtCharge,
  ensureCurrentDebt,
  cancelCurrentDebt,
  rescheduleCurrentDebt,
} from './subscriptionDebts.js';
import {
  buildEntity,
  checkCategoryForMovement,
  SCHEMAS,
  SUBSCRIPTION_PERIODICITIES,
  SUBSCRIPTION_STATUSES,
  advanceChargeDate,
  chargeAnchorDay,
  centsToMoneyString,
  summarizeSubscriptions,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.subscriptions;
const CATEGORY_COLLECTION = COLLECTIONS.categories;
const ALLOWED_CATEGORY_KINDS = SCHEMAS.subscriptions.fields.categoryId.kindCompat;

/** Ação de auditoria por status de destino. */
const STATUS_ACTIONS = Object.freeze({ active: 'resume', paused: 'pause', cancelled: 'cancel' });

/** Cancelada é terminal; ativa ⇄ pausada; mesmo status é rejeitado. */
const STATUS_TRANSITIONS = Object.freeze({
  active: ['paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  cancelled: [],
});

async function fetchCategory(uid, categoryId) {
  return getById(uid, CATEGORY_COLLECTION, categoryId);
}

/** Lista assinaturas por próxima cobrança. */
export async function listSubscriptions(uid, options = {}) {
  const constraints = { orderBy: ['nextChargeDate', 'asc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

export async function getSubscription(uid, subscriptionId) {
  return getById(uid, COLLECTION, subscriptionId);
}

/** Modelo → categoria real no Firestore → compatibilidade de tipo. */
async function validate(uid, rawData, deps) {
  // `chargeDay` nunca vem do formulário: é derivado da data escolhida (só dias 29–31, que o fim do mês pode apagar).
  const { chargeDay: _ignored, ...input } = rawData ?? {};
  const anchor = chargeAnchorDay(input.nextChargeDate);
  const { ok, data, errors } = buildEntity('subscriptions', anchor ? { ...input, chargeDay: anchor } : input);
  if (!ok) return { ok: false, errors };
  if (data.cardId) {
    // Cobrada no cartão: o cartão precisa existir e não estar cancelado (VF-2-03r).
    const card = await (deps.lookupCard ?? ((u, id) => getById(u, COLLECTIONS.creditCards, id)))(uid, data.cardId);
    if (!card) return { ok: false, errors: { cardId: 'Cartão não encontrado.' } };
    if (card.status === 'cancelled') return { ok: false, errors: { cardId: 'O cartão está cancelado.' } };
  }
  if (data.debtorId) {
    // Devedor que paga a assinatura (VF-COR-07): precisa existir e não estar cancelado (quitado reabre ao receber nova dívida).
    const debtor = await (deps.lookupDebtor ?? ((u, id) => getById(u, COLLECTIONS.debtors, id)))(uid, data.debtorId);
    if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
    if (!['open', 'paid'].includes(debtor.status)) return { ok: false, errors: { debtorId: 'Reabra o devedor cancelado antes de vinculá-lo.' } };
  }
  const category = await (deps.lookupCategory ?? fetchCategory)(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;
  return { ok: true, data };
}

/** Resultado de uma operação na dívida da assinatura → formato `charge` devolvido à tela. */
const debtCharge = (r, debtorId) => (r.ok ? { ok: true, via: 'debtor', debtorId, action: r.action, date: r.date, reason: r.reason } : r);

/** A assinatura JÁ foi salva/alterada: uma falha ao mexer na dívida vira resultado (não exceção) para a tela explicar. */
async function safely(fn) {
  try {
    return await fn();
  } catch (error) {
    // Corrida: outra chamada gravou o MESMO id antes (regravar = update, negado pelas Rules) — nada foi duplicado nem somado.
    if (error?.code === 'permission-denied') return { ok: false, errors: { _form: 'Essa cobrança já foi lançada (ou foi recusada pelas regras de acesso); nada foi duplicado.' } };
    return { ok: false, errors: { _form: error?.message ?? 'Falha ao ajustar a dívida da assinatura.' } };
  }
}

/** Retorna { ok, id, charge?, errors }. `deps` (lookupCategory, create, writeAudit) é injetável. */
export async function createSubscription(uid, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  const id = await createAudited(uid, COLLECTION, checked.data, deps);
  const created = { id, ...checked.data };
  let charge = null;
  if (checked.data.status === 'active' && usesDebtCharge(created)) {
    // Devedor (sem cartão): o vínculo GERA a dívida da próxima fatura (data atual da assinatura) — só ela, sem avançar a data.
    charge = debtCharge(await safely(() => ensureCurrentDebt(uid, created, created.nextChargeDate, deps)), created.debtorId);
  } else if (checked.data.status === 'active' && checked.data.debtorId && checked.data.cardId) {
    // Cartão + devedor: a parcela na fatura é imutável, então lança a cobrança e avança a data (VF-COR-08).
    charge = await chargeAfterSave(uid, created, deps);
  }
  return { ok: true, id, ...(charge ? { charge } : {}) };
}

/**
 * Antes de salvar uma edição, faz a dívida do devedor (caminho sem cartão) acompanhar a assinatura — ver `subscriptionDebts.js`.
 * Roda ANTES da gravação: se a dívida não puder acompanhar (ex.: já tem recebimentos), a edição é abortada e nada muda.
 * Retorna { ok, charge? } ou { ok:false, errors }.
 */
async function reconcileDebtOnEdit(uid, previous, next, deps) {
  const wasDebt = Boolean(previous) && previous.status === 'active' && usesDebtCharge(previous);
  const isDebt = next.status === 'active' && usesDebtCharge(next);
  let charge = null;
  if (wasDebt && (!isDebt || next.debtorId !== previous.debtorId)) {
    // desvinculou, trocou de devedor, pausou ou cancelou: a dívida pendente do vínculo antigo sai (se não tiver recebimentos)
    const r = await ensureOk(await safely(() => cancelCurrentDebt(uid, previous, previous.nextChargeDate, deps)));
    if (!r.ok) return r;
    charge = debtCharge(r, previous.debtorId);
  }
  if (isDebt) {
    const sameLink = wasDebt && next.debtorId === previous.debtorId;
    const r = await ensureOk(await safely(() => (sameLink
      ? rescheduleCurrentDebt(uid, next, previous.nextChargeDate, deps)
      : ensureCurrentDebt(uid, next, next.nextChargeDate, deps))));
    if (!r.ok) return r;
    if (r.action !== 'exists' || !charge) charge = debtCharge(r, next.debtorId);
  }
  return { ok: true, ...(charge ? { charge } : {}) };
}
const ensureOk = (r) => (r.ok ? r : { ok: false, errors: r.errors ?? { _form: 'Não foi possível ajustar a dívida do devedor.' } });

/** Retorna { ok, charge?, errors }. */
export async function updateSubscription(uid, subscriptionId, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  const previous = await (deps.getById ?? getById)(uid, COLLECTION, subscriptionId);
  const next = { id: subscriptionId, ...checked.data };
  const reconciled = await reconcileDebtOnEdit(uid, previous, next, deps);
  if (!reconciled.ok) return { ok: false, errors: reconciled.errors };
  // Vínculos OPCIONAIS (conta, cartão, devedor): ausente no formulário remove o campo (null → deleteField em `update`).
  await updateAudited(uid, COLLECTION, subscriptionId, {
    ...checked.data,
    accountId: checked.data.accountId ?? null,
    cardId: checked.data.cardId ?? null,
    debtorId: checked.data.debtorId ?? null,
    chargeDay: checked.data.chargeDay ?? null,
  }, deps);
  let charge = reconciled.charge ?? null;
  const cardLink = checked.data.status === 'active' && checked.data.debtorId && checked.data.cardId
    && (checked.data.debtorId !== previous?.debtorId || !previous?.cardId);
  if (cardLink) charge = await chargeAfterSave(uid, next, deps); // cartão + devedor NOVO vínculo: parcela imutável (VF-COR-08)
  return { ok: true, ...(charge ? { charge } : {}) };
}

export async function deleteSubscription(uid, subscriptionId, io = {}) {
  const subscription = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!subscription) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  let charge = null;
  if (subscription.status === 'active' && usesDebtCharge(subscription)) {
    // Excluir encerra a recorrência: a dívida pendente da próxima fatura sai (com recebimentos ela é mantida).
    const r = await safely(() => cancelCurrentDebt(uid, subscription, subscription.nextChargeDate, io));
    if (!r.ok) return { ok: false, errors: r.errors };
    charge = debtCharge(r, subscription.debtorId);
  }
  await removeAudited(uid, COLLECTION, subscriptionId, subscription, io);
  return { ok: true, ...(charge ? { charge } : {}) };
}

/**
 * Pausa, retoma ou cancela. Lê o estado atual e valida a transição (fail-closed:
 * sem update nem auditoria quando rejeitada). Leitura+escrita não atômica.
 * Com devedor (sem cartão): pausar/cancelar tira a dívida pendente da próxima fatura (se sem recebimentos); retomar a lança de novo.
 */
export async function setSubscriptionStatus(uid, subscriptionId, status, io = {}) {
  if (!STATUS_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!current) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para esta assinatura.' } };
  }
  let charge = null;
  if (usesDebtCharge(current) && status !== 'active' && current.status === 'active') {
    const r = await safely(() => cancelCurrentDebt(uid, current, current.nextChargeDate, io));
    if (!r.ok) return { ok: false, errors: r.errors };
    charge = debtCharge(r, current.debtorId);
  }
  await updateAudited(uid, COLLECTION, subscriptionId, { status }, io, STATUS_ACTIONS[status]);
  if (usesDebtCharge(current) && status === 'active') {
    charge = debtCharge(await safely(() => ensureCurrentDebt(uid, { ...current, status }, current.nextChargeDate, io)), current.debtorId);
  }
  return { ok: true, ...(charge ? { charge } : {}) };
}

export const pauseSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'paused', io);
export const resumeSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'active', io);
export const cancelSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'cancelled', io);

export { chargeDocId };

/**
 * Lança a cobrança de `current` (assinatura ATIVA) em `current.nextChargeDate` e avança a data um período (auditoria `charge`).
 * Lança SÓ essa cobrança — a da próxima fatura —, nunca cobranças futuras nem retroativas: a recorrência pode ser pausada ou
 * cancelada, então não se gera nada que ainda não é conhecido. Destinos:
 *  - Com `cardId` (VF-2-03r): UMA parcela (1x) na fatura aberta do período; fatura fechada/paga NUNCA é alterada (vai para
 *    a próxima aberta); a data avança no MESMO lote atômico. Não gera despesa em conta (o débito é ao pagar a fatura).
 *    Com `debtorId` (VF-COR-07), a parcela nasce VINCULADA ao devedor (a receber; o recebimento cai na conta escolhida ao
 *    receber e a fatura é paga à parte — fluxos independentes).
 *  - Sem `cardId` e com `debtorId` (VF-COR-10): fecha o ciclo — garante a dívida desta data e lança a da PRÓXIMA fatura,
 *    avançando a data no MESMO lote (ver `subscriptionDebts.js`: a dívida acompanha a assinatura).
 *  - Sem cartão e sem devedor: só avança a data; NÃO gera despesa nem altera saldo (lance em Despesas se quiser refletir).
 * Anti-duplicação: o documento de cobrança usa id determinístico (`chargeDocId`). Se já existe, a cobrança é recusada; e se
 * duas chamadas concorrentes passarem pela checagem, a segunda falha no lote (regravar o id = update, negado pelas Rules).
 * Retorna { ok, nextChargeDate, via: 'card'|'debtor'|'account'|'none', invoiceIds?, debtGroupId?, errors }.
 */
async function chargeSubscription(uid, current, io = {}) {
  if (current.status !== 'active') {
    return { ok: false, errors: { _form: 'Só é possível registrar cobrança de assinaturas ativas.' } };
  }
  const nextChargeDate = advanceChargeDate(current.nextChargeDate, current.periodicity, current.chargeDay);
  if (!nextChargeDate) {
    return { ok: false, errors: { _form: 'Data ou periodicidade da assinatura inválida.' } };
  }
  const docId = chargeDocId(current.id, current.nextChargeDate);
  const duplicate = { ok: false, errors: { _form: `A cobrança de ${current.nextChargeDate.split('-').reverse().join('/')} desta assinatura já foi lançada.` } };
  const exists = async (collection) => Boolean(await (io.getById ?? getById)(uid, collection, docId));
  const advance = [{ type: 'update', collection: COLLECTION, docId: current.id, data: { nextChargeDate }, action: 'charge' }];

  try {
    if (current.cardId) {
      if (await exists(COLLECTIONS.cardPurchases)) return duplicate;
      const r = await registerCardPurchase(uid, current.cardId, {
        description: current.name, amountCents: centsToMoneyString(current.amountCents), purchaseDate: current.nextChargeDate,
        installmentsTotal: 1, categoryId: current.categoryId, notes: 'Assinatura',
        ...(current.debtorId ? { debtorId: current.debtorId } : {}),
      }, { ...io, extraOps: advance, purchaseDocIds: [docId] });
      if (!r.ok) return r;
      return { ok: true, nextChargeDate, via: 'card', invoiceIds: r.invoiceMonths, ...(current.debtorId ? { debtorId: current.debtorId } : {}) };
    }
    if (usesDebtCharge(current)) {
      // Fecha o ciclo: garante a dívida desta data (se faltar) e lança a da PRÓXIMA fatura, avançando a data no MESMO lote.
      const thisCycle = await ensureCurrentDebt(uid, current, current.nextChargeDate, io);
      if (!thisCycle.ok) return thisCycle;
      const next = await ensureCurrentDebt(uid, current, nextChargeDate, io, advance);
      if (!next.ok) return next;
      return { ok: true, nextChargeDate, via: 'debtor', debtorId: current.debtorId, launched: next.action === 'launched', generatedExpense: false };
    }
    await updateAudited(uid, COLLECTION, current.id, { nextChargeDate }, io, 'charge');
    return { ok: true, nextChargeDate, via: current.accountId ? 'account' : 'none', generatedExpense: false };
  } catch (error) {
    // Corrida: outra chamada gravou o MESMO id antes (regravar = update, negado pelas Rules) — nada foi duplicado nem somado.
    if (error?.code === 'permission-denied' && (current.cardId || current.debtorId)) return duplicate;
    throw error;
  }
}

/** Lançamento automático ao vincular o devedor: a assinatura JÁ foi salva, então uma falha vira resultado (não exceção). */
async function chargeAfterSave(uid, current, io) {
  try {
    return await chargeSubscription(uid, current, io);
  } catch (error) {
    return { ok: false, errors: { _form: error?.message ?? 'Falha ao lançar a cobrança.' } };
  }
}

/** Registra a cobrança de uma assinatura (lê o estado atual): ver `chargeSubscription`. */
export async function registerSubscriptionCharge(uid, subscriptionId, io = {}) {
  const current = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!current) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  return chargeSubscription(uid, current, io);
}

export function getPeriodicityOptions() {
  return SUBSCRIPTION_PERIODICITIES.map((p) => ({ value: p.value, label: p.label }));
}

export function getSubscriptionStatusOptions() {
  return SUBSCRIPTION_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { summarizeSubscriptions, formatCents, parseMoneyToCents };
