/**
 * Dívida a receber de uma assinatura vinculada a um devedor SEM cartão (VF-COR-10).
 *
 * Invariante: enquanto a assinatura está ATIVA e vinculada a um devedor (sem cartão), existe UMA dívida lançada por ela
 * com vencimento = `nextChargeDate` — a PRÓXIMA fatura. Nada retroativo nem futuro: a recorrência pode ser pausada ou
 * cancelada, então não se lança o que ainda não é conhecido. A dívida ACOMPANHA a assinatura:
 *  - criar/vincular/reativar → lança a da data atual (se ainda não existe);
 *  - editar data ou valor    → reagenda a MESMA dívida (servidor, `debt.reschedule`; antes de ter recebimentos);
 *  - pausar/cancelar/excluir/desvincular → cancela a dívida pendente (servidor, `debt.cancel`; devolve o emprestado).
 * Dívida com recebimentos nunca é alterada nem cancelada por aqui (estorne antes): a assinatura segue e a dívida é mantida.
 *
 * Identificação: o id do documento começa com `sub_<assinatura>_` (a data fica em `dueDate`, que pode mudar ao reagendar).
 * Anti-duplicação: o id nasce de assinatura × data (+ revisão se esse id já foi usado/cancelado); regravar o mesmo id é UPDATE,
 * negado pelas Rules — um lote repetido/concorrente falha inteiro e não duplica nem soma de novo no devedor.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { getById, commitAtomic } from './firestore.js';
import { createDebtPlan, listDebts, cancelDebt, rescheduleDebt } from './debtPayments.js';
import { centsToMoneyString } from '../core/model.js';

/** Id determinístico base da cobrança (assinatura × data). */
export const chargeDocId = (subscriptionId, chargeDate) => `sub_${subscriptionId}_${chargeDate}`;

/** Esta assinatura gera dívida (devedor, sem cartão — no cartão a cobrança é uma compra na fatura)? */
export const usesDebtCharge = (subscription) => Boolean(subscription?.debtorId) && !subscription?.cardId;

const OPEN = ['pending', 'late'];
const formatDay = (iso) => String(iso).split('-').reverse().join('/');

/** Dívidas já lançadas por esta assinatura (do devedor dela). */
async function launchedDebts(uid, subscription, io) {
  const all = await listDebts(uid, subscription.debtorId, io);
  return all.filter((d) => d.id.startsWith(`sub_${subscription.id}_`));
}

/** Primeiro id livre para (assinatura × data): base, depois `_r2`, `_r3`… (o id base pode ter sido cancelado/usado). */
async function freeChargeId(uid, subscriptionId, date, io) {
  const get = io.getById ?? getById;
  const base = chargeDocId(subscriptionId, date);
  for (let revision = 1; revision <= 20; revision += 1) {
    const id = revision === 1 ? base : `${base}_r${revision}`;
    if (!(await get(uid, COLLECTIONS.debts, id))) return id;
  }
  throw new Error('Não foi possível reservar um identificador para a cobrança da assinatura.');
}

/**
 * Garante a dívida de `date` (cria se não houver uma NÃO cancelada). `extraOps` (ex.: avanço da data da assinatura) entram no
 * MESMO lote da criação — e, se a dívida já existia, são gravados sozinhos. Retorna { ok, action: 'launched'|'exists', date }.
 */
export async function ensureCurrentDebt(uid, subscription, date, io = {}, extraOps = []) {
  const existing = (await launchedDebts(uid, subscription, io)).find((d) => d.dueDate === date && d.status !== 'cancelled');
  if (existing) {
    if (extraOps.length) await (io.commitAtomic ?? commitAtomic)(uid, extraOps, io);
    return { ok: true, action: 'exists', date, debtId: existing.id };
  }
  const id = await freeChargeId(uid, subscription.id, date, io);
  const r = await createDebtPlan(uid, {
    debtorId: subscription.debtorId, description: subscription.name, totalCents: centsToMoneyString(subscription.amountCents),
    installments: 1, firstDueDate: date,
  }, { ...io, debtDocIds: [id], ...(extraOps.length ? { extraOps } : {}) });
  return r.ok ? { ok: true, action: 'launched', date, debtId: id } : r;
}

/** Cancela a dívida PENDENTE de `date` (se houver). Com recebimentos ela é mantida (`action: 'kept'`). */
export async function cancelCurrentDebt(uid, subscription, date, io = {}) {
  const current = (await launchedDebts(uid, subscription, io)).find((d) => d.dueDate === date && OPEN.includes(d.status));
  if (!current) return { ok: true, action: 'none', date };
  const r = await cancelDebt(uid, current.id, io);
  if (r.ok) return { ok: true, action: 'cancelled', date, debtId: current.id };
  if (r.code === 'INVALID_STATE') return { ok: true, action: 'kept', date, debtId: current.id, reason: r.errors?._form };
  return r;
}

/**
 * Faz a dívida atual acompanhar a assinatura: move `previousDate` → `subscription.nextChargeDate` e ajusta o valor.
 * Sem dívida a mover, lança a nova. Recusa (nada muda) se já existe OUTRA dívida lançada na nova data, ou se a atual tem
 * recebimentos (o servidor recusa) — o chamador deve abortar a edição.
 */
export async function rescheduleCurrentDebt(uid, subscription, previousDate, io = {}) {
  const date = subscription.nextChargeDate;
  const launched = await launchedDebts(uid, subscription, io);
  const current = launched.find((d) => d.dueDate === previousDate && OPEN.includes(d.status));
  if (!current) return ensureCurrentDebt(uid, subscription, date, io);
  const clash = launched.find((d) => d.id !== current.id && d.dueDate === date && d.status !== 'cancelled');
  if (clash) return { ok: false, errors: { _form: `Já existe uma cobrança desta assinatura lançada para ${formatDay(date)}.` } };
  const dueChanged = current.dueDate !== date;
  const amountChanged = Number(current.principalCents) !== Number(subscription.amountCents);
  if (!dueChanged && !amountChanged) return { ok: true, action: 'exists', date, debtId: current.id };
  const r = await rescheduleDebt(uid, current.id, {
    ...(dueChanged ? { dueDate: date } : {}), ...(amountChanged ? { principalCents: Number(subscription.amountCents) } : {}),
  }, io);
  return r.ok ? { ok: true, action: 'rescheduled', date, debtId: current.id } : r;
}
