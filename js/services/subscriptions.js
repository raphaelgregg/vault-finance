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
import { createDebtPlan } from './debtPayments.js';
import {
  buildEntity,
  checkCategoryForMovement,
  SCHEMAS,
  SUBSCRIPTION_PERIODICITIES,
  SUBSCRIPTION_STATUSES,
  advanceChargeDate,
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
  const { ok, data, errors } = buildEntity('subscriptions', rawData);
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

/** Retorna { ok, id, errors }. `deps` (lookupCategory, create, writeAudit) é injetável. */
export async function createSubscription(uid, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  const id = await createAudited(uid, COLLECTION, checked.data, deps);
  // Com devedor, o vínculo GERA o valor a receber: lança a cobrança da próxima fatura (não as futuras nem as passadas).
  const charge = checked.data.debtorId && checked.data.status === 'active'
    ? await chargeAfterSave(uid, { id, ...checked.data }, deps) : null;
  return { ok: true, id, ...(charge ? { charge } : {}) };
}

/** Retorna { ok, errors }. */
export async function updateSubscription(uid, subscriptionId, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  // Só um vínculo NOVO com devedor (nenhum → algum, ou trocado) lança a cobrança; editar outros campos não relança nada.
  const previous = checked.data.debtorId ? await (deps.getById ?? getById)(uid, COLLECTION, subscriptionId) : null;
  // Vínculos OPCIONAIS (conta, cartão, devedor): ausente no formulário remove o campo (null → deleteField em `update`).
  await updateAudited(uid, COLLECTION, subscriptionId, {
    ...checked.data,
    accountId: checked.data.accountId ?? null,
    cardId: checked.data.cardId ?? null,
    debtorId: checked.data.debtorId ?? null,
  }, deps);
  const newLink = checked.data.debtorId && checked.data.debtorId !== previous?.debtorId && checked.data.status === 'active';
  const charge = newLink ? await chargeAfterSave(uid, { id: subscriptionId, ...checked.data }, deps) : null;
  return { ok: true, ...(charge ? { charge } : {}) };
}

export async function deleteSubscription(uid, subscriptionId, io = {}) {
  const subscription = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!subscription) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  await removeAudited(uid, COLLECTION, subscriptionId, subscription, io);
  return { ok: true };
}

/**
 * Pausa, retoma ou cancela. Lê o estado atual e valida a transição (fail-closed:
 * sem update nem auditoria quando rejeitada). Leitura+escrita não atômica.
 */
export async function setSubscriptionStatus(uid, subscriptionId, status, io = {}) {
  if (!STATUS_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!current) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para esta assinatura.' } };
  }
  await updateAudited(uid, COLLECTION, subscriptionId, { status }, io, STATUS_ACTIONS[status]);
  return { ok: true };
}

export const pauseSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'paused', io);
export const resumeSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'active', io);
export const cancelSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'cancelled', io);

/** Id determinístico da cobrança (assinatura × data): no máximo UM lançamento por assinatura e data, mesmo sob cliques repetidos. */
export const chargeDocId = (subscriptionId, chargeDate) => `sub_${subscriptionId}_${chargeDate}`;

/**
 * Lança a cobrança de `current` (assinatura ATIVA) em `current.nextChargeDate` e avança a data um período (auditoria `charge`).
 * Lança SÓ essa cobrança — a da próxima fatura —, nunca cobranças futuras nem retroativas: a recorrência pode ser pausada ou
 * cancelada, então não se gera nada que ainda não é conhecido. Destinos:
 *  - Com `cardId` (VF-2-03r): UMA parcela (1x) na fatura aberta do período; fatura fechada/paga NUNCA é alterada (vai para
 *    a próxima aberta); a data avança no MESMO lote atômico. Não gera despesa em conta (o débito é ao pagar a fatura).
 *    Com `debtorId` (VF-COR-07), a parcela nasce VINCULADA ao devedor (a receber; o recebimento cai na conta escolhida ao
 *    receber e a fatura é paga à parte — fluxos independentes).
 *  - Sem `cardId` e com `debtorId` (VF-COR-07): UMA dívida à vista (vencimento = data da cobrança), no MESMO lote atômico.
 *  - Sem cartão e sem devedor: só avança a data; NÃO gera despesa nem altera saldo (lance em Despesas se quiser refletir).
 * Anti-duplicação: o documento de cobrança usa id determinístico (`chargeDocId`). Se já existe, a cobrança é recusada; e se
 * duas chamadas concorrentes passarem pela checagem, a segunda falha no lote (regravar o id = update, negado pelas Rules).
 * Retorna { ok, nextChargeDate, via: 'card'|'debtor'|'account'|'none', invoiceIds?, debtGroupId?, errors }.
 */
async function chargeSubscription(uid, current, io = {}) {
  if (current.status !== 'active') {
    return { ok: false, errors: { _form: 'Só é possível registrar cobrança de assinaturas ativas.' } };
  }
  const nextChargeDate = advanceChargeDate(current.nextChargeDate, current.periodicity);
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
    if (current.debtorId) {
      if (await exists(COLLECTIONS.debts)) return duplicate;
      const r = await createDebtPlan(uid, {
        debtorId: current.debtorId, description: current.name, totalCents: centsToMoneyString(current.amountCents),
        installments: 1, firstDueDate: current.nextChargeDate,
      }, { ...io, extraOps: advance, debtDocIds: [docId] });
      if (!r.ok) return r;
      return { ok: true, nextChargeDate, via: 'debtor', debtorId: current.debtorId, debtGroupId: r.groupId, generatedExpense: false };
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
