/**
 * Serviço de Parcelas (debts) e Recebimentos (debtPayments) de devedores (VF-2-03b2).
 * VF-ARQ-02: recebimentos, quitações e cancelamento de parcela são feitos pelo SERVIDOR (transação, idempotência,
 * limite por parcela/dívida). Aqui ficam só a criação de dívidas (sem movimentar conta), leituras e a prévia.
 *
 * Recebimentos entram em accountBalances (saldo da conta aumenta); o saldo continua derivado.
 * Recebimento é imutável: correção = estorno (lançamento compensatório, `reversal.create`).
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  commitAtomic,
} from './firestore.js';
import { loadDebtorStatements } from './debtors.js';
import { financeResult } from './financeApi.js';
import {
  buildEntity,
  pendingInstallmentsOfMonth,
  receivedByInstallment,
  addMonths,
  isValidIsoDate,
  clampDayInMonth,
  splitInstallments,
  centsToMoneyString,
  DEBT_STATUSES,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const DEBTS = COLLECTIONS.debts;
const PAYMENTS = COLLECTIONS.debtPayments;
const DEBTORS = COLLECTIONS.debtors;
const MAX_INSTALLMENT = 360;
const MAX_PLAN_INSTALLMENTS = 120; // 2 escritas por parcela (+ devedor) no mesmo lote (limite de 500)

export async function listDebts(uid, debtorId, io = {}) {
  return (io.list ?? list)(uid, DEBTS, { where: [['debtorId', '==', debtorId]] });
}

export async function listDebtPayments(uid, options = {}) {
  const constraints = {};
  if (options.where) constraints.where = options.where;
  return list(uid, PAYMENTS, constraints);
}

/** Cria parcela (status sempre `pending`). Devedor precisa existir e estar em aberto (para dívida nova use `createDebtPlan`). */
export async function createDebt(uid, rawData, deps = {}) {
  const fetch = deps.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') {
    return { ok: false, errors: { _form: 'Só é possível criar parcelas para devedor em aberto.' } };
  }
  let installmentNumber = rawData.installmentNumber;
  if (installmentNumber === undefined || installmentNumber === null || installmentNumber === '') {
    const existing = await (deps.list ?? list)(uid, DEBTS, { where: [['debtorId', '==', debtor.id ?? rawData.debtorId]] });
    installmentNumber = existing.reduce((max, d) => Math.max(max, Number(d.installmentNumber) || 0), 0) + 1;
    if (installmentNumber > MAX_INSTALLMENT) {
      return { ok: false, errors: { installmentNumber: `Máximo de ${MAX_INSTALLMENT} parcelas.` } };
    }
  }
  const { ok, data, errors } = buildEntity('debts', { ...rawData, installmentNumber, status: 'pending' });
  if (!ok) return { ok: false, errors };
  const id = await createAudited(uid, DEBTS, data, deps);
  return { ok: true, id };
}

/**
 * Cria uma dívida do devedor, à vista (`installments` 1) ou parcelada (N), em UM lote atômico (VF-2-03m).
 * `rawData`: { debtorId, description, totalCents (string pt-BR), installments (padrão 1), firstDueDate }.
 * Parcelas mensais no mesmo dia (com clamp ao fim do mês), valores em centavos inteiros (a 1ª leva o
 * resto da divisão), todas com `installmentsTotal` e o mesmo `debtGroupId`. O total soma ao `lentCents`
 * do devedor (agregado mantido pelo service; o pendente continua `lentCents − receivedCents`).
 * Devedor precisa existir e estar em aberto ou quitado (quitado é reaberto no mesmo lote). `io`: getById, commitAtomic, groupId() injetáveis.
 */
export async function createDebtPlan(uid, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  // Devedor QUITADO (`paid`) pode receber nova dívida: ela o reabre no mesmo lote. Só o cancelado fica de fora.
  if (!['open', 'paid'].includes(debtor.status)) return { ok: false, errors: { _form: 'Reabra o devedor cancelado antes de criar dívidas.' } };

  const rawN = rawData.installments === undefined || rawData.installments === '' ? 1 : Number(rawData.installments);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_PLAN_INSTALLMENTS) {
    return { ok: false, errors: { installments: `Informe de 1 a ${MAX_PLAN_INSTALLMENTS} parcelas.` } };
  }
  const total = parseMoneyToCents(rawData.totalCents);
  if (!Number.isInteger(total) || total <= 0) return { ok: false, errors: { totalCents: 'Informe um valor maior que zero.' } };
  const parts = splitInstallments(total, rawN);
  if (!parts) return { ok: false, errors: { totalCents: 'O valor deve ser de ao menos 1 centavo por parcela.' } };
  const first = /^(\d{4}-\d{2})-(\d{2})$/.exec(rawData.firstDueDate ?? '');
  if (!first || !isValidIsoDate(rawData.firstDueDate)) return { ok: false, errors: { firstDueDate: 'Data inválida (use DD/MM/AAAA).' } };
  const day = Number(first[2]);

  const groupId = io.groupId ? io.groupId() : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ops = [];
  for (let n = 1; n <= rawN; n += 1) {
    const month = addMonths(first[1], n - 1);
    const built = buildEntity('debts', {
      debtorId: debtor.id ?? rawData.debtorId, description: rawData.description, principalCents: centsToMoneyString(parts[n - 1]),
      dueDate: clampDayInMonth(month, day), installmentNumber: n, installmentsTotal: rawN, debtGroupId: groupId, status: 'pending',
    });
    if (!built.ok) return { ok: false, errors: built.errors };
    // `io.debtDocIds[n-1]`: id determinístico (ex.: assinatura × data). Regravar o mesmo id é UPDATE (negado nas Rules de `debts`):
    // lote repetido/concorrente falha inteiro e NÃO duplica a dívida nem soma de novo no devedor.
    ops.push({ type: 'create', collection: DEBTS, ...(io.debtDocIds?.[n - 1] ? { docId: io.debtDocIds[n - 1] } : {}), data: built.data });
  }
  // Soma por `increment` (não valor absoluto de leitura velha); devedor quitado volta a `open` no mesmo lote.
  ops.push({
    type: 'update', collection: DEBTORS, docId: debtor.id ?? rawData.debtorId, action: 'debt-plan',
    data: debtor.status === 'paid' ? { status: 'open' } : {}, increments: { lentCents: total },
  });
  if (Array.isArray(io.extraOps)) ops.push(...io.extraOps); // ex.: avanço da próxima cobrança de uma assinatura (mesmo lote atômico)
  const ids = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, ids, groupId, installments: rawN, totalCents: total };
}

// ---------------------------------------------------------------------------------------------------------------
// Recebimentos (VF-ARQ-02): TODO recebimento nasce no SERVIDOR. O cliente só valida o formulário, envia a intenção
// (com `operationId`) e mostra o resultado confirmado — nunca grava debtPayments nem altera o devedor/parcela.
// ---------------------------------------------------------------------------------------------------------------

const finance = (io) => io.finance ?? financeResult;

/** Chave de idempotência de UMA operação do usuário (gerada ao abrir o formulário; retry/duplo clique reutilizam). */
export const newOperationId = () => globalThis.crypto.randomUUID();

/**
 * Razão do devedor lido do Firestore: dívidas, compras de cartão vinculadas, faturas, recebimentos e estornos (uma
 * leitura por coleção). Retorna { debts, payments, reversals, purchases, invoicesById } — insumo de `debtorObligations`
 * (somente para EXIBIÇÃO/prévia: quem decide o que é recebível é o servidor, dentro da transação).
 */
export async function loadDebtorLedger(uid, debtor, io = {}) {
  const map = await loadDebtorStatements(uid, [debtor], '2000-01', { list: io.list, includeAll: true });
  const st = map.get(debtor.id);
  return { debts: st?.debts ?? [], payments: st?.payments ?? [], reversals: st?.reversals ?? [], purchases: st?.purchases ?? [], invoicesById: st?.invoicesById ?? new Map() };
}

function ledgerInput(debtor, ledger) {
  const { byDebt, byPurchase } = receivedByInstallment(ledger.payments, ledger.reversals ?? []);
  return { debtor, debts: ledger.debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById };
}

/** Valida data/conta/observações no formulário (feedback imediato; o servidor revalida tudo). */
function probeReceipt(rawData, idField, debtorId) {
  const probe = buildEntity('debtPayments', { date: rawData.date, accountId: rawData.accountId, notes: rawData.notes, amountCents: '0,01', ...idField, debtorId });
  return probe.ok ? { ok: true, data: probe.data } : { ok: false, errors: probe.errors };
}

/**
 * QUITA UMA parcela (ou recebe parcialmente): `target` = { debtId } | { purchaseId }. O servidor valida devedor, parcela,
 * conta ativa, restante e idempotência numa transação; recebimento acima do restante é recusado (`EXCEEDS_REMAINING`).
 * `rawData`: { date, accountId, amountCents? (pt-BR; padrão = restante), notes?, operationId? }.
 * Retorna { ok, id, settled, amountCents, remainingCents, debtorPaid, anticipated, errors, code }.
 */
export async function settleInstallment(uid, debtorId, target = {}, rawData = {}, io = {}) {
  const installmentId = target.debtId ?? target.purchaseId;
  if (!installmentId || (target.debtId && target.purchaseId)) return { ok: false, errors: { _form: 'Informe a parcela a quitar.' } };
  const idField = target.debtId ? { debtId: installmentId } : { purchaseId: installmentId };
  const probe = probeReceipt(rawData, idField, debtorId);
  if (!probe.ok) return probe;
  let amountCents;
  if (rawData.amountCents !== undefined && rawData.amountCents !== '') {
    amountCents = parseMoneyToCents(rawData.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, errors: { amountCents: 'Informe um valor maior que zero.' } };
  }
  const r = await finance(io)('debt.receive', {
    ...idField, ...(amountCents !== undefined ? { amountCents } : {}), date: probe.data.date, accountId: probe.data.accountId,
    ...(probe.data.notes ? { notes: probe.data.notes } : {}),
  }, { operationId: rawData.operationId, ...(io.apiOptions ?? {}) });
  if (!r.ok) return r.code === 'EXCEEDS_REMAINING' ? { ...r, errors: { ...r.errors, amountCents: r.errors._form } } : r;
  const dueDate = io.dueDate ?? null;
  const anticipated = typeof dueDate === 'string' && probe.data.date < dueDate;
  return {
    ok: true, id: r.paymentId, settled: r.settled, amountCents: r.amountCents, remainingCents: r.remainingCents,
    debtorPaid: r.debtorStatus === 'paid', anticipated, idempotent: Boolean(r.idempotent), result: r,
  };
}

/** Recebimento de uma parcela de dívida (atalho de `settleInstallment`). `rawData.amountCents` (pt-BR) obrigatório. */
export async function registerDebtPayment(uid, debtId, rawData, io = {}) {
  const debt = await (io.getById ?? getById)(uid, DEBTS, debtId);
  if (!debt) return { ok: false, errors: { _form: 'Parcela não encontrada.' } };
  const r = await settleInstallment(uid, debt.debtorId, { debtId }, rawData, { ...io, dueDate: debt.dueDate });
  return r.ok ? { ...r, debtPaid: r.settled } : r;
}

/** Máximo de parcelas por quitação em lote (o servidor impõe o mesmo teto). */
export const MAX_MONTH_SETTLE_ITEMS = 200;
const MAX_BATCH_CALLS = 40;

/**
 * Executa um lote NO SERVIDOR (`debt.settleBatch`): o servidor cria o estado persistido do lote (itens, status) e processa
 * até N parcelas por chamada, cada uma em SUA transação idempotente; o cliente repete a chamada (mesmo `operationId`)
 * até o lote concluir. NÃO há atomicidade global: cada parcela é consistente e o estado do lote diz o que foi feito.
 * Falha no meio ⇒ `partial: true` + `batchId`: repetir a operação com o mesmo `operationId` continua de onde parou.
 */
async function runBatch(uid, debtorId, scope, rawData, io, { month = null } = {}) {
  const probe = probeReceipt(rawData, {}, debtorId);
  // a sonda não tem debtId/purchaseId: ignora só esse erro (o servidor define as parcelas)
  if (!probe.ok && Object.keys(probe.errors).some((k) => !['debtId', 'purchaseId'].includes(k))) return probe;
  const operationId = rawData.operationId ?? newOperationId();
  const params = {
    debtorId, accountId: rawData.accountId, date: rawData.date, ...(rawData.notes ? { notes: rawData.notes } : {}), scope,
  };
  let last = null;
  for (let call = 0; call < MAX_BATCH_CALLS; call += 1) {
    last = await finance(io)('debt.settleBatch', params, { operationId, ...(io.apiOptions ?? {}) });
    if (!last.ok) {
      const progressed = call > 0;
      return progressed ? { ...last, partial: true, batchId: operationId, operationId } : { ...last, operationId };
    }
    if (last.status !== 'running') break;
  }
  if (last.status === 'running') return { ok: false, partial: true, batchId: operationId, operationId, errors: { _form: 'Quitação ainda em andamento: repita a operação para concluir.' } };
  const debtor = await (io.getById ?? getById)(uid, DEBTORS, debtorId).catch(() => null);
  const base = { month, batchId: operationId, operationId, count: last.done, skipped: last.skipped, failed: last.failed, totalCents: last.receivedCents, debtorPaid: debtor?.status === 'paid', items: last.items, result: last };
  if (last.status === 'partial_failed') {
    return { ...base, ok: false, partial: last.done > 0, errors: { _form: `Quitação concluída em parte: ${last.done} de ${last.total} parcela(s) gravada(s) e consistentes; ${last.failed} falharam. Repita a operação para tentar as restantes.` } };
  }
  if (last.done === 0 && last.skipped === last.total) return { ...base, ok: false, errors: { _form: 'Não há parcelas pendentes para quitar.' } };
  return { ...base, ok: true };
}

/**
 * Quita (dá baixa no restante de) as parcelas de dívida pendentes de um devedor: de uma dívida (`scope.groupId`) ou todas.
 * Compras de cartão não são tocadas. `rawData`: { date, accountId, notes?, operationId? }.
 * Retorna { ok, count, totalCents, debtorPaid, errors, partial?, batchId? }.
 */
export async function settleDebts(uid, debtorId, scope = {}, rawData = {}, io = {}) {
  return runBatch(uid, debtorId, scope.groupId ? { groupId: scope.groupId } : { all: true }, rawData, io);
}

/**
 * Parcelas pendentes de um mês de referência (prévia para a confirmação da tela). Puro sobre o razão já lido.
 * Retorna { items, count, totalCents } — o mesmo conjunto que o servidor recalcula ao quitar o mês.
 */
export function previewMonthSettlement({ debtor, ledger, month }) {
  return pendingInstallmentsOfMonth({ month, ...ledgerInput(debtor, ledger) });
}

/** Quita, em lote retomável, as parcelas pendentes de um mês ("AAAA-MM"): dívidas pelo vencimento e cartão pela fatura. */
export async function settleMonthInstallments(uid, debtorId, month, rawData = {}, io = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) return { ok: false, errors: { _form: 'Mês de referência inválido (use MM/AAAA).' } };
  return runBatch(uid, debtorId, { month }, rawData, io, { month });
}

/** Cancela parcela pendente/atrasada sem recebimentos (no servidor). `paid` só nasce de recebimentos. */
export async function cancelDebt(uid, debtId, io = {}) {
  const r = await finance(io)('debt.cancel', { debtId }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, result: r } : r;
}

/**
 * Reagenda e/ou reajusta o valor de UMA parcela pendente/atrasada sem recebimentos (no servidor, `debt.reschedule`): a data,
 * o valor e o emprestado do devedor mudam na mesma transação. `changes`: { dueDate?: 'AAAA-MM-DD', principalCents?: inteiro }.
 */
export async function rescheduleDebt(uid, debtId, changes = {}, io = {}) {
  const params = {
    debtId,
    ...(changes.dueDate ? { dueDate: changes.dueDate } : {}),
    ...(changes.principalCents !== undefined ? { principalCents: changes.principalCents } : {}),
  };
  const r = await finance(io)('debt.reschedule', params, { operationId: io.operationId ?? newOperationId(), ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, result: r } : r;
}

/** Teto de parcelas por cancelamento múltiplo (o mesmo do servidor: `CANCEL_MANY_MAX` em server/finance/ops.mjs). */
export const CANCEL_MANY_MAX = 100;

/**
 * Cancela VÁRIAS parcelas (uma dívida inteira ou uma seleção) em UMA requisição ao servidor (`debt.cancelMany`):
 * uma transação, tudo ou nada. O servidor revalida cada parcela (pendente/atrasada e sem recebimentos); se alguma
 * não puder ser cancelada, nenhuma é alterada. Idempotente: repetir com a MESMA `io.operationId` devolve o resultado.
 * Retorna { ok, count, operationId } ou { ok:false, errors, code }.
 */
export async function cancelDebts(uid, debtIds, io = {}) {
  const ids = [...new Set(Array.isArray(debtIds) ? debtIds : [])];
  if (!ids.length) return { ok: false, errors: { _form: 'Selecione ao menos uma parcela para cancelar.' } };
  if (ids.length > CANCEL_MANY_MAX) return { ok: false, errors: { _form: `Cancele no máximo ${CANCEL_MANY_MAX} parcelas por vez.` } };
  const operationId = io.operationId ?? newOperationId();
  const r = await finance(io)('debt.cancelMany', { debtIds: ids }, { operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, count: r.count ?? ids.length, operationId } : { ...r, operationId };
}

export function getDebtStatusOptions() {
  return DEBT_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { formatCents, parseMoneyToCents };
