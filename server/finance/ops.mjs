/**
 * Operações financeiras do servidor (VF-ARQ-02). Cada operação valida os parâmetros, LÊ o estado no Firestore dentro da
 * transação, aplica as regras de negócio e grava de forma atômica junto do registro de idempotência.
 * Registro: ver `defineOp` em core.mjs. Contrato de requisição: { op, operationId, params } (POST /api/finance).
 */
import { FinanceError, FieldValue, defineOp, executeOnce, makeCtx, plain, requestHash, stamps, toTs, v, HISTORY_LIMIT } from './core.mjs';
import {
  applyGoalTransaction, isAccountLinkedGoal, goalSavedCents, applyPaymentToDebtor, debtorObligations, pendingInstallmentsOfMonth,
  receivedByInstallment, accountBalances, accountLabel, formatCents, DEBTOR_STATUSES,
} from '../../js/core/model.js';
import { todayInAppZone } from '../../js/utils/dates.js';

const RECURRENCES = ['none', 'monthly', 'weekly', 'yearly'];
const today = (ctx) => todayInAppZone(ctx.now());
/** Saldo insuficiente com a conta e os valores reais (mensagem mostrada ao usuário; detalhes em centavos para a tela). */
const insufficient = (available, requested, account) => new FinanceError(409, 'INSUFFICIENT_BALANCE',
  `Saldo insuficiente${account ? ` em ${accountLabel(account)}` : ' na conta'}: disponível ${formatCents(available)}, necessário ${formatCents(requested)}.`,
  { availableCents: available, requestedCents: requested, ...(account ? { accountId: account.id } : {}) });
const invalidState = (message, details) => new FinanceError(409, 'INVALID_STATE', message, details);

async function checkCategory(ctx, categoryId, kinds) {
  const category = await ctx.get('categories', categoryId);
  if (!category) throw new FinanceError(404, 'CATEGORY_NOT_FOUND', 'Categoria não encontrada.', { categoryId });
  if (!kinds.includes(category.kind) && category.kind !== 'both') throw new FinanceError(400, 'CATEGORY_KIND_MISMATCH', 'Categoria incompatível com este tipo de lançamento.');
  return category;
}

// ===============================================================================================================
// FASE 1 — Transferências
// ===============================================================================================================

defineOp('transfer.create', {
  allowParams: ['status'], // intenção de criação (pending|confirmed): o servidor decide e valida
  validate: (p) => ({
    fromAccountId: v.id(p.fromAccountId, 'fromAccountId'), toAccountId: v.id(p.toAccountId, 'toAccountId'),
    amountCents: v.cents(p.amountCents), date: v.date(p.date), reason: v.text(p.reason, 'reason', { min: 1, max: 120 }),
    notes: v.text(p.notes, 'notes', { max: 500 }), status: v.enum(p.status ?? 'confirmed', 'status', ['pending', 'confirmed']),
  }),
  async prepare(ctx, p, operationId) {
    if (p.fromAccountId === p.toAccountId) throw new FinanceError(400, 'SAME_ACCOUNT', 'A conta de destino deve ser diferente da conta de origem.');
    const from = await ctx.account(p.fromAccountId);
    await ctx.account(p.toAccountId);
    let balanceAfterCents;
    if (p.status === 'confirmed') {
      const balance = await ctx.balanceOf(from);
      if (balance < p.amountCents) throw insufficient(balance, p.amountCents, from);
      balanceAfterCents = balance - p.amountCents;
    }
    const id = ctx.col('transfers').doc().id;
    return {
      result: { transferId: id, status: p.status, ...(balanceAfterCents !== undefined ? { fromBalanceAfterCents: balanceAfterCents } : {}) },
      apply(c) {
        c.tx.create(c.ref('transfers', id), {
          fromAccountId: p.fromAccountId, toAccountId: p.toAccountId, amountCents: p.amountCents, date: toTs(p.date),
          reason: p.reason, ...(p.notes ? { notes: p.notes } : {}), status: p.status, operationId, ...stamps(true),
        });
        if (p.status === 'confirmed') { c.touchAccount(p.fromAccountId); c.touchAccount(p.toAccountId); }
      },
    };
  },
});

defineOp('transfer.confirm', {
  validate: (p) => ({ transferId: v.id(p.transferId, 'transferId') }),
  async prepare(ctx, p) {
    const t = await ctx.get('transfers', p.transferId);
    if (!t) throw new FinanceError(404, 'NOT_FOUND', 'Transferência não encontrada.');
    if (t.status !== 'pending') throw invalidState(`Transferência já está ${t.status === 'confirmed' ? 'confirmada' : 'cancelada'}; não é possível confirmá-la.`, { status: t.status });
    // Transferência ESTORNADA é histórico: não pode ser reaberta e confirmada de novo (ficaria confirmada com estorno registrado).
    if ((await ctx.tx.get(ctx.ref('reversals', `transfers_${p.transferId}`))).exists) {
      throw invalidState('Esta transferência foi estornada e não pode ser confirmada de novo; lance uma nova transferência.', { status: t.status });
    }
    const from = await ctx.account(t.fromAccountId);
    await ctx.account(t.toAccountId);
    const balance = await ctx.balanceOf(from);
    if (balance < t.amountCents) throw insufficient(balance, t.amountCents, from);
    return {
      result: { transferId: t.id, status: 'confirmed', fromBalanceAfterCents: balance - t.amountCents },
      apply(c) {
        c.tx.update(c.ref('transfers', t.id), { status: 'confirmed', ...stamps() });
        c.touchAccount(t.fromAccountId); c.touchAccount(t.toAccountId);
      },
    };
  },
});

// ===============================================================================================================
// FASE 3 — Receitas e despesas (liquidação)
// ===============================================================================================================

const movementValidate = (kind, settled) => (p) => ({
  description: v.text(p.description, 'description', { min: 1, max: 120 }), categoryId: v.id(p.categoryId, 'categoryId'),
  amountCents: v.cents(p.amountCents), accountId: v.id(p.accountId, 'accountId'),
  ...(kind === 'income'
    ? { expectedDate: v.date(p.expectedDate, 'expectedDate'), receivedDate: p.receivedDate ? v.date(p.receivedDate, 'receivedDate') : undefined }
    : { purchaseDate: v.date(p.purchaseDate, 'purchaseDate'), dueDate: v.date(p.dueDate, 'dueDate'), paidDate: p.paidDate ? v.date(p.paidDate, 'paidDate') : undefined, installmentGroupId: v.text(p.installmentGroupId, 'installmentGroupId', { max: 80 }) }),
  status: v.enum(p.status ?? 'pending', 'status', ['pending', settled, 'cancelled']),
  recurrence: v.enum(p.recurrence ?? 'none', 'recurrence', RECURRENCES), notes: v.text(p.notes, 'notes', { max: 500 }),
});

function defineMovement(kind) {
  const isIncome = kind === 'income';
  const coll = isIncome ? 'incomes' : 'expenses';
  const settled = isIncome ? 'received' : 'paid';
  const dateField = isIncome ? 'receivedDate' : 'paidDate';
  const dateFields = isIncome ? ['expectedDate', 'receivedDate'] : ['purchaseDate', 'dueDate', 'paidDate'];

  defineOp(`${kind}.create`, {
    allowParams: ['status'],
    validate: movementValidate(kind, settled),
    async prepare(ctx, p, operationId) {
      await checkCategory(ctx, p.categoryId, isIncome ? ['income'] : ['expense']);
      const account = await ctx.account(p.accountId);
      const settle = p.status === settled;
      let balanceAfterCents;
      if (settle) {
        const balance = await ctx.balanceOf(account);
        if (!isIncome && balance < p.amountCents) throw insufficient(balance, p.amountCents, account);
        balanceAfterCents = isIncome ? balance + p.amountCents : balance - p.amountCents;
      }
      const date = settle ? (p[dateField] ?? today(ctx)) : undefined;
      const id = ctx.col(coll).doc().id;
      const data = {};
      for (const [key, value] of Object.entries({ ...p, [dateField]: date })) {
        if (value === undefined) continue;
        data[key] = dateFields.includes(key) ? toTs(value) : value;
      }
      return {
        result: { id, status: p.status, ...(balanceAfterCents !== undefined ? { balanceAfterCents } : {}) },
        apply(c) {
          c.tx.create(c.ref(coll, id), { ...data, operationId, ...stamps(true) });
          if (settle) c.touchAccount(p.accountId);
        },
      };
    },
  });

  defineOp(`${kind}.${isIncome ? 'receive' : 'pay'}`, {
    validate: (p) => ({ id: v.id(p.id, 'id'), date: p.date ? v.date(p.date) : undefined }),
    async prepare(ctx, p) {
      const doc = await ctx.get(coll, p.id);
      if (!doc) throw new FinanceError(404, 'NOT_FOUND', isIncome ? 'Receita não encontrada.' : 'Despesa não encontrada.');
      if (doc.status !== 'pending') throw invalidState(isIncome ? 'Só é possível marcar como recebida uma receita prevista.' : 'Só é possível marcar como paga uma despesa pendente.', { status: doc.status });
      const account = await ctx.account(doc.accountId);
      const balance = await ctx.balanceOf(account);
      if (!isIncome && balance < doc.amountCents) throw insufficient(balance, doc.amountCents, account);
      const date = p.date ?? today(ctx);
      return {
        result: { id: doc.id, status: settled, [dateField]: date, balanceAfterCents: isIncome ? balance + doc.amountCents : balance - doc.amountCents },
        apply(c) {
          c.tx.update(c.ref(coll, doc.id), { status: settled, [dateField]: toTs(date), ...stamps() });
          c.touchAccount(doc.accountId);
        },
      };
    },
  });
}
defineMovement('income');
defineMovement('expense');

// ===============================================================================================================
// FASE 4 — Pagamento de fatura de cartão
// ===============================================================================================================

defineOp('invoice.pay', {
  validate: (p) => ({ invoiceId: v.id(p.invoiceId, 'invoiceId'), accountId: v.id(p.accountId, 'accountId'), date: p.date ? v.date(p.date) : undefined }),
  async prepare(ctx, p) {
    const invoice = await ctx.get('invoices', p.invoiceId);
    if (!invoice) throw new FinanceError(404, 'NOT_FOUND', 'Fatura não encontrada.');
    if (!['open', 'closed'].includes(invoice.status)) throw invalidState(invoice.status === 'paid' ? 'Esta fatura já foi paga.' : 'Só é possível pagar faturas abertas ou fechadas.', { status: invoice.status });
    const account = await ctx.account(p.accountId);
    // O total é SEMPRE recalculado das compras lidas na transação (aberta ou fechada): o `totalCents` gravado na fatura
    // fechada é editável pelo cliente e nunca é confiável para decidir quanto debitar.
    const purchases = await ctx.query('cardPurchases', ['invoiceId', '==', invoice.id]);
    const total = purchases.reduce((t, x) => t + (Number(x.amountCents) || 0), 0);
    if (total <= 0) throw invalidState('Fatura zerada: não há o que pagar. Cancele a fatura.');
    const balance = await ctx.balanceOf(account);
    if (balance < total) throw insufficient(balance, total, account);
    const date = p.date ?? today(ctx);
    return {
      result: { invoiceId: invoice.id, status: 'paid', paidCents: total, accountId: account.id, paidAt: date, balanceAfterCents: balance - total },
      apply(c) {
        c.tx.update(c.ref('invoices', invoice.id), { status: 'paid', totalCents: total, paidCents: total, accountId: account.id, paidAt: toTs(date), ...stamps() });
        c.touchAccount(account.id);
      },
    };
  },
});

// ===============================================================================================================
// FASE 5 — Aportes e resgates de metas
// ===============================================================================================================

async function goalSaved(ctx, goalId) {
  const [txs, reversals] = await Promise.all([ctx.query('goalTransactions', ['goalId', '==', goalId]), ctx.query('reversals', ['goalId', '==', goalId])]);
  const reversed = new Set(reversals.filter((r) => r.targetCollection === 'goalTransactions').map((r) => r.targetId));
  const live = txs.filter((t) => !reversed.has(t.id));
  return { saved: goalSavedCents(live), count: txs.length, live };
}

for (const type of ['deposit', 'withdraw']) {
  defineOp(`goal.${type}`, {
    validate: (p) => ({ goalId: v.id(p.goalId, 'goalId'), amountCents: v.cents(p.amountCents), date: v.date(p.date), accountId: v.id(p.accountId, 'accountId'), notes: v.text(p.notes, 'notes', { max: 300 }) }),
    async prepare(ctx, p, operationId) {
      const goal = await ctx.get('goals', p.goalId);
      if (!goal) throw new FinanceError(404, 'NOT_FOUND', 'Meta não encontrada.');
      const account = await ctx.account(p.accountId);
      const { saved, count } = await goalSaved(ctx, goal.id);
      if (isAccountLinkedGoal(goal, count)) throw invalidState('Meta vinculada a uma conta: o progresso segue o saldo dessa conta; transfira para ela.');
      const applied = applyGoalTransaction(goal, saved, type, p.amountCents);
      if (!applied.ok) throw invalidState(applied.error);
      const balance = await ctx.balanceOf(account);
      if (type === 'deposit' && balance < p.amountCents) throw insufficient(balance, p.amountCents, account);
      const id = ctx.col('goalTransactions').doc().id;
      return {
        result: { transactionId: id, goalId: goal.id, type, savedCents: applied.savedCents, goalStatus: applied.status, balanceAfterCents: type === 'deposit' ? balance - p.amountCents : balance + p.amountCents },
        apply(c) {
          c.tx.create(c.ref('goalTransactions', id), { goalId: goal.id, type, amountCents: p.amountCents, date: toTs(p.date), accountId: account.id, ...(p.notes ? { notes: p.notes } : {}), operationId, ...stamps(true) });
          if (applied.status !== goal.status) c.tx.update(c.ref('goals', goal.id), { status: applied.status, ...stamps() });
          c.touchAccount(account.id);
        },
      };
    },
  });
}

// ===============================================================================================================
// FASE 2 — Recebimentos de devedores (parcela de dívida ou de compra no cartão)
// ===============================================================================================================

/** Recebido líquido de uma parcela (recebimentos − estornos), lido na transação. */
async function installmentReceived(ctx, kind, id) {
  const field = kind === 'debt' ? 'debtId' : 'purchaseId';
  const [payments, reversals] = await Promise.all([ctx.query('debtPayments', [field, '==', id]), ctx.query('reversals', [field, '==', id])]);
  const reversed = new Set(reversals.filter((r) => r.targetCollection === 'debtPayments').map((r) => r.targetId));
  return { received: payments.filter((p) => !reversed.has(p.id)).reduce((t, p) => t + (Number(p.amountCents) || 0), 0), count: payments.length };
}

/** Núcleo do recebimento: lê (devedor, parcela, recebimentos, conta) e devolve { result, apply }. Usado por recebimento e lote. */
export async function prepareReceive(ctx, p, operationId) {
  const kind = p.debtId ? 'debt' : 'purchase';
  const parcelId = p.debtId ?? p.purchaseId;
  const parcel = await ctx.get(kind === 'debt' ? 'debts' : 'cardPurchases', parcelId);
  if (!parcel) throw new FinanceError(404, 'NOT_FOUND', 'Parcela não encontrada.');
  if (!parcel.debtorId) throw invalidState('Esta parcela não está vinculada a um devedor.');
  const debtor = await ctx.get('debtors', parcel.debtorId);
  if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor não encontrado.');
  if (debtor.status === 'cancelled') throw invalidState('Devedor cancelado: reabra-o antes de receber.');
  if (debtor.archived) throw invalidState('Devedor arquivado: desarquive-o antes de receber.');
  if (kind === 'debt' && !['pending', 'late'].includes(parcel.status)) throw invalidState(parcel.status === 'paid' ? 'Esta parcela já foi quitada.' : 'Esta parcela não aceita recebimentos.', { status: parcel.status });
  if (kind === 'purchase') {
    const invoice = parcel.invoiceId ? await ctx.get('invoices', parcel.invoiceId) : null;
    if (invoice?.status === 'cancelled') throw invalidState('A fatura desta parcela foi cancelada.');
  }
  const account = await ctx.account(p.accountId);
  const total = Number(kind === 'debt' ? parcel.principalCents : parcel.amountCents) || 0;
  const { received } = await installmentReceived(ctx, kind, parcelId);
  const remaining = total - received;
  if (remaining <= 0) throw invalidState('Esta parcela já foi quitada.', { remainingCents: 0 });
  const amount = p.amountCents ?? remaining;
  if (amount > remaining) throw new FinanceError(409, 'EXCEEDS_REMAINING', 'O valor excede o restante da parcela.', { remainingCents: remaining, requestedCents: amount });
  const debtorApplied = applyPaymentToDebtor(debtor.status === 'paid' ? { ...debtor, status: 'open' } : debtor, amount);
  if (!debtorApplied.ok) throw new FinanceError(409, 'EXCEEDS_DEBT', debtorApplied.error, { requestedCents: amount });
  const settled = amount === remaining;
  const id = ctx.col('debtPayments').doc().id;
  return {
    result: { paymentId: id, [kind === 'debt' ? 'debtId' : 'purchaseId']: parcelId, debtorId: debtor.id, amountCents: amount, settled, remainingCents: remaining - amount, debtorStatus: debtorApplied.status, debtorReceivedCents: debtorApplied.receivedCents, accountId: account.id },
    apply(c) {
      c.tx.create(c.ref('debtPayments', id), {
        [kind === 'debt' ? 'debtId' : 'purchaseId']: parcelId, debtorId: debtor.id, amountCents: amount, date: toTs(p.date), accountId: account.id,
        ...(p.notes ? { notes: p.notes } : {}), operationId, ...stamps(true),
      });
      // A parcela de dívida é SEMPRE escrita (mesmo no recebimento parcial): serializa com `debt.cancel`/estorno, que a leem.
      if (kind === 'debt') c.tx.update(c.ref('debts', parcelId), { ...(settled ? { status: 'paid' } : {}), ...stamps() });
      c.tx.update(c.ref('debtors', debtor.id), { receivedCents: debtorApplied.receivedCents, status: debtorApplied.status, ...stamps() });
      c.touchAccount(account.id);
    },
  };
}

defineOp('debt.receive', {
  validate: (p) => {
    if (Boolean(p.debtId) === Boolean(p.purchaseId)) throw new FinanceError(400, 'INVALID_PARAM', 'Informe exatamente uma parcela: debtId ou purchaseId.');
    return {
      ...(p.debtId ? { debtId: v.id(p.debtId, 'debtId') } : { purchaseId: v.id(p.purchaseId, 'purchaseId') }),
      amountCents: p.amountCents === undefined ? undefined : v.cents(p.amountCents), date: v.date(p.date), accountId: v.id(p.accountId, 'accountId'), notes: v.text(p.notes, 'notes', { max: 500 }),
    };
  },
  prepare: (ctx, p, operationId) => prepareReceive(ctx, p, operationId),
});

/**
 * Devedor da parcela, validado para REMOVER `removedCents` do emprestado: cancelar/reagendar para menos precisa devolver o valor
 * ao `lentCents` (senão o total em aberto continua cobrando o que foi cancelado). O emprestado nunca pode ficar abaixo do já recebido.
 */
async function debtorForLentChange(ctx, debtorId, deltaCents) {
  const debtor = await ctx.get('debtors', debtorId);
  if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor da parcela não encontrado.');
  if ((Number(debtor.lentCents) || 0) + deltaCents < (Number(debtor.receivedCents) || 0)) {
    throw invalidState('O valor emprestado do devedor ficaria abaixo do já recebido; estorne recebimentos antes.', { debtorId });
  }
  return debtor;
}

const lentIncrement = (c, debtorId, deltaCents) => c.tx.update(c.ref('debtors', debtorId), { lentCents: FieldValue.increment(deltaCents), ...stamps() });

defineOp('debt.cancel', {
  validate: (p) => ({ debtId: v.id(p.debtId, 'debtId') }),
  async prepare(ctx, p) {
    const debt = await ctx.get('debts', p.debtId);
    if (!debt) throw new FinanceError(404, 'NOT_FOUND', 'Parcela não encontrada.');
    if (!['pending', 'late'].includes(debt.status)) throw invalidState('Só é possível cancelar parcelas pendentes ou atrasadas.', { status: debt.status });
    const { count } = await installmentReceived(ctx, 'debt', debt.id);
    if (count > 0) throw invalidState('A parcela já possui recebimentos e não pode ser cancelada (estorne-os antes).');
    const principal = Number(debt.principalCents) || 0;
    await debtorForLentChange(ctx, debt.debtorId, -principal);
    return {
      result: { debtId: debt.id, status: 'cancelled' },
      apply: (c) => { c.tx.update(c.ref('debts', debt.id), { status: 'cancelled', ...stamps() }); lentIncrement(c, debt.debtorId, -principal); },
    };
  },
});

/** Máximo de parcelas por cancelamento múltiplo (uma transação: limite de escritas do Firestore e tempo da função). */
export const CANCEL_MANY_MAX = 100;

/**
 * Cancela VÁRIAS parcelas em UMA requisição e UMA transação (tudo ou nada): cada parcela precisa estar pendente/atrasada e
 * sem recebimentos — as mesmas regras de `debt.cancel`. Se qualquer uma não puder ser cancelada (ex.: ganhou um recebimento
 * entre a seleção e a confirmação), NENHUMA é alterada. Idempotente por `operationId` (como as demais operações).
 */
defineOp('debt.cancelMany', {
  validate: (p) => {
    if (!Array.isArray(p.debtIds) || !p.debtIds.length) throw new FinanceError(400, 'INVALID_PARAM', 'Informe as parcelas a cancelar (debtIds).');
    if (p.debtIds.length > CANCEL_MANY_MAX) throw new FinanceError(400, 'INVALID_PARAM', `Cancele no máximo ${CANCEL_MANY_MAX} parcelas por vez.`);
    return { debtIds: [...new Set(p.debtIds.map((id) => v.id(id, 'debtIds')))].sort() }; // ordem estável ⇒ mesmo hash na repetição
  },
  async prepare(ctx, p) {
    const debts = [];
    for (const id of p.debtIds) {
      const debt = await ctx.get('debts', id);
      if (!debt) throw new FinanceError(404, 'NOT_FOUND', 'Parcela não encontrada.', { debtId: id });
      if (!['pending', 'late'].includes(debt.status)) throw invalidState('Só é possível cancelar parcelas pendentes ou atrasadas.', { debtId: id, status: debt.status });
      const { count } = await installmentReceived(ctx, 'debt', id);
      if (count > 0) throw invalidState('Há parcela selecionada com recebimentos: ela não pode ser cancelada (estorne-os antes). Nada foi cancelado.', { debtId: id });
      debts.push(debt);
    }
    // Devolve ao emprestado, POR devedor, a soma das parcelas canceladas (uma escrita por devedor, no mesmo lote).
    const byDebtor = new Map();
    for (const debt of debts) byDebtor.set(debt.debtorId, (byDebtor.get(debt.debtorId) ?? 0) + (Number(debt.principalCents) || 0));
    for (const [debtorId, cents] of byDebtor) await debtorForLentChange(ctx, debtorId, -cents);
    return {
      result: { debtIds: p.debtIds, count: debts.length, status: 'cancelled' },
      apply: (c) => {
        for (const debt of debts) c.tx.update(c.ref('debts', debt.id), { status: 'cancelled', ...stamps() });
        for (const [debtorId, cents] of byDebtor) lentIncrement(c, debtorId, -cents);
      },
    };
  },
});

/**
 * Reagenda e/ou reajusta o valor de UMA parcela pendente/atrasada SEM recebimentos, na mesma transação do emprestado do devedor
 * (`lentCents += novo − antigo`). Usado quando a assinatura vinculada a um devedor muda de data/valor: a dívida já lançada acompanha.
 * Parcela com recebimentos não é alterada (estorne antes). Idempotente por `operationId`.
 */
defineOp('debt.reschedule', {
  validate: (p) => {
    if (p.dueDate === undefined && p.principalCents === undefined) throw new FinanceError(400, 'INVALID_PARAM', 'Informe dueDate e/ou principalCents.');
    return {
      debtId: v.id(p.debtId, 'debtId'),
      ...(p.dueDate !== undefined ? { dueDate: v.date(p.dueDate, 'dueDate') } : {}),
      ...(p.principalCents !== undefined ? { principalCents: v.cents(p.principalCents, 'principalCents') } : {}),
    };
  },
  async prepare(ctx, p) {
    const debt = await ctx.get('debts', p.debtId);
    if (!debt) throw new FinanceError(404, 'NOT_FOUND', 'Parcela não encontrada.');
    if (!['pending', 'late'].includes(debt.status)) throw invalidState('Só é possível reagendar parcelas pendentes ou atrasadas.', { status: debt.status });
    const { count } = await installmentReceived(ctx, 'debt', debt.id);
    if (count > 0) throw invalidState('A parcela já possui recebimentos e não pode ser alterada (estorne-os antes).');
    const principal = p.principalCents ?? (Number(debt.principalCents) || 0);
    const delta = principal - (Number(debt.principalCents) || 0);
    await debtorForLentChange(ctx, debt.debtorId, delta);
    return {
      result: { debtId: debt.id, ...(p.dueDate ? { dueDate: p.dueDate } : {}), principalCents: principal, deltaCents: delta },
      apply: (c) => {
        c.tx.update(c.ref('debts', debt.id), { ...(p.dueDate ? { dueDate: toTs(p.dueDate) } : {}), principalCents: principal, ...stamps() });
        if (delta !== 0) lentIncrement(c, debt.debtorId, delta);
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Quitação em LOTE retomável (por mês, por dívida ou todas) — consistência POR PARCELA, estado explícito do lote
// ---------------------------------------------------------------------------------------------------------------

export const BATCH_ITEMS_PER_CALL = 15;
const MAX_BATCH_ITEMS = 500;

/** Razão do devedor lido fora de transação (só para PLANEJAR; cada parcela é revalidada na sua transação). */
async function readLedger(db, uid, debtorId) {
  const col = (n) => db.collection(`users/${uid}/${n}`);
  const [debts, purchases, payments, reversals] = await Promise.all([
    col('debts').where('debtorId', '==', debtorId).get(), col('cardPurchases').where('debtorId', '==', debtorId).get(),
    col('debtPayments').where('debtorId', '==', debtorId).get(), col('reversals').where('debtorId', '==', debtorId).get(),
  ]);
  const cardIds = [...new Set(purchases.docs.map((d) => d.data().invoiceId).filter(Boolean))];
  const invoices = (await Promise.all(cardIds.map((id) => db.doc(`users/${uid}/invoices/${id}`).get()))).filter((s) => s.exists).map(plain);
  const reversed = new Set(reversals.docs.map(plain).filter((r) => r.targetCollection === 'debtPayments').map((r) => r.targetId));
  const livePayments = payments.docs.map(plain).filter((p) => !reversed.has(p.id));
  return { debts: debts.docs.map(plain), purchases: purchases.docs.map(plain), payments: livePayments, invoicesById: new Map(invoices.map((i) => [i.id, i])) };
}

export function planItems(debtor, ledger, scope) {
  const { byDebt, byPurchase } = receivedByInstallment(ledger.payments);
  const input = { debtor, debts: ledger.debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById };
  let items;
  if (scope.month) items = pendingInstallmentsOfMonth({ month: scope.month, ...input }).items;
  else items = debtorObligations(input).items.filter((i) => i.source === 'debt' && i.status === 'pending' && i.remainingCents > 0 && (scope.groupId ? i.groupId === scope.groupId : true));
  return items.map((i) => ({ key: `${i.source === 'debt' ? 'd' : 'c'}-${i.id}`, source: i.source, id: i.id }));
}

defineOp('debt.settleBatch', {
  validate: (p) => {
    const scope = p.scope ?? {};
    const hasMonth = Boolean(scope.month);
    if (hasMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.month)) throw new FinanceError(400, 'INVALID_PARAM', 'scope.month deve ser AAAA-MM.');
    if (!hasMonth && !scope.groupId && scope.all !== true) throw new FinanceError(400, 'INVALID_PARAM', 'Informe scope.month, scope.groupId ou scope.all.');
    return {
      debtorId: v.id(p.debtorId, 'debtorId'), accountId: v.id(p.accountId, 'accountId'), date: v.date(p.date), notes: v.text(p.notes, 'notes', { max: 500 }),
      scope: hasMonth ? { month: scope.month } : scope.groupId ? { groupId: v.id(scope.groupId, 'scope.groupId') } : { all: true },
    };
  },
  async run({ db, uid, op, operationId, params, deps }) {
    const batchRef = db.doc(`users/${uid}/batches/${operationId}`);
    const hash = requestHash(op, params);
    let snap = await batchRef.get();
    if (snap.exists && snap.data().requestHash !== hash) throw new FinanceError(409, 'OPERATION_ID_REUSED', 'Este operationId já foi usado em outra operação ou com outros parâmetros.');
    if (!snap.exists) {
      const debtor = plain(await db.doc(`users/${uid}/debtors/${params.debtorId}`).get().then((s) => { if (!s.exists) throw new FinanceError(404, 'NOT_FOUND', 'Devedor não encontrado.'); return s; }));
      if (debtor.status === 'cancelled') throw invalidState('Devedor cancelado: reabra-o antes de receber.');
      if (debtor.archived) throw invalidState('Devedor arquivado: desarquive-o antes de receber.');
      const items = planItems(debtor, await readLedger(db, uid, params.debtorId), params.scope);
      if (!items.length) throw invalidState('Não há parcelas pendentes para quitar.');
      if (items.length > MAX_BATCH_ITEMS) throw invalidState(`Lote acima de ${MAX_BATCH_ITEMS} parcelas: quite em partes.`);
      try {
        await batchRef.create({ op, requestHash: hash, debtorId: params.debtorId, params, status: 'running', total: items.length, items: items.map((i) => ({ ...i, status: 'pending' })), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      } catch (error) { if (error?.code !== 6) throw error; } // ALREADY_EXISTS: outra chamada concorrente criou o mesmo lote
      snap = await batchRef.get();
      // O lote vencedor pode ter OUTROS parâmetros (mesma chave, payload diferente): reverifica antes de processar qualquer item.
      if (snap.data().requestHash !== hash) throw new FinanceError(409, 'OPERATION_ID_REUSED', 'Este operationId já foi usado em outra operação ou com outros parâmetros.');
    }
    // processa até BATCH_ITEMS_PER_CALL parcelas pendentes/falhas, cada uma em SUA transação idempotente
    let processed = 0;
    for (const item of snap.data().items) {
      if (processed >= BATCH_ITEMS_PER_CALL) break;
      if (!['pending', 'failed'].includes(item.status)) continue;
      processed += 1;
      await processBatchItem({ db, uid, operationId, params: snap.data().params, item, deps, batchRef }); // sempre os parâmetros GRAVADOS do lote
    }
    const final = (await batchRef.get()).data();
    const count = (s) => final.items.filter((i) => i.status === s).length;
    const pending = count('pending');
    const status = pending > 0 ? 'running' : count('failed') > 0 ? 'partial_failed' : 'completed';
    if (status !== final.status) await batchRef.update({ status, updatedAt: FieldValue.serverTimestamp() });
    return {
      batchId: operationId, status, total: final.total, done: count('done'), skipped: count('skipped'), failed: count('failed'), pending,
      receivedCents: final.items.filter((i) => i.status === 'done').reduce((t, i) => t + (i.amountCents ?? 0), 0),
      items: final.items.map(({ key, status: s, amountCents, error }) => ({ key, status: s, ...(amountCents !== undefined ? { amountCents } : {}), ...(error ? { error } : {}) })),
      idempotent: false,
    };
  },
});

/** Uma parcela do lote: recebimento + estado do item no MESMO transação (item concluído ⇔ recebimento existe). */
async function processBatchItem({ db, uid, operationId, params, item, deps, batchRef }) {
  const itemOpId = `${operationId}~${item.key}`;
  const setItem = (tx, items, patch) => tx.update(batchRef, { items: items.map((i) => (i.key === item.key ? { ...i, ...patch } : i)), updatedAt: FieldValue.serverTimestamp() });
  try {
    await db.runTransaction(async (tx) => {
      const batchSnap = await tx.get(batchRef);
      const items = batchSnap.data().items;
      if (['done', 'skipped'].includes(items.find((i) => i.key === item.key)?.status)) return;
      const opRef = db.doc(`users/${uid}/operations/${itemOpId}`);
      if ((await tx.get(opRef)).exists) { setItem(tx, items, { status: 'done' }); return; }
      const ctx = makeCtx(db, tx, uid, deps);
      const target = item.source === 'debt' ? { debtId: item.id } : { purchaseId: item.id };
      const { result, apply } = await prepareReceive(ctx, { ...target, date: params.date, accountId: params.accountId, notes: params.notes }, itemOpId);
      await apply(ctx);
      tx.create(opRef, { op: 'debt.receive', requestHash: requestHash('debt.receive', { ...target, ...params }), status: 'completed', result, batchId: operationId, createdAt: FieldValue.serverTimestamp() });
      ctx.audit({ action: 'debt.receive', entity: 'operations', entityId: itemOpId, after: { amountCents: result.amountCents } });
      setItem(tx, items, { status: 'done', amountCents: result.amountCents, paymentId: result.paymentId });
    });
  } catch (error) {
    if (!(error instanceof FinanceError)) throw error; // falha de infraestrutura: propaga (o cliente repete com a MESMA chave)
    const skipped = error.code === 'INVALID_STATE' && /quitada/.test(error.message);
    await db.runTransaction(async (tx) => {
      const items = (await tx.get(batchRef)).data().items;
      setItem(tx, items, skipped ? { status: 'skipped' } : { status: 'failed', error: error.code });
    });
  }
}

// ===============================================================================================================
// ESTORNOS — lançamento compensatório (o documento original é preservado; o estorno é uma NOVA operação)
// ===============================================================================================================

const REVERSIBLE = {
  income: { coll: 'incomes', status: 'received' },
  expense: { coll: 'expenses', status: 'paid' },
  transfer: { coll: 'transfers', status: 'confirmed' },
  invoice: { coll: 'invoices', status: 'paid' },
  debtPayment: { coll: 'debtPayments', status: null },
  goalTransaction: { coll: 'goalTransactions', status: null },
};

defineOp('reversal.create', {
  validate: (p) => ({ kind: v.enum(p.kind, 'kind', Object.keys(REVERSIBLE)), targetId: v.id(p.targetId, 'targetId'), reason: v.text(p.reason, 'reason', { min: 3, max: 300, required: true }), date: p.date ? v.date(p.date) : undefined }),
  async prepare(ctx, p, operationId) {
    const spec = REVERSIBLE[p.kind];
    let revId = `${spec.coll}_${p.targetId}`;
    if ((await ctx.tx.get(ctx.ref('reversals', revId))).exists) {
      // Estorno anterior existe. Se o lançamento VOLTOU a ser estornável depois dele (receita recebida de novo, transferência
      // confirmada de novo por uma versão antiga da tela), é uma nova realização: novo estorno com sufixo (`..._2`, `..._3`…).
      // Sem isso o lançamento ficaria preso (confirmado e impossível de estornar). Lançamento já estornado e no estado
      // resultante do estorno continua sendo ALREADY_REVERSED (duplicata); recebimento/movimento de meta não têm status e nunca reabrem.
      const again = spec.status ? await ctx.get(spec.coll, p.targetId) : null;
      if (!again || again.status !== spec.status) throw new FinanceError(409, 'ALREADY_REVERSED', 'Este lançamento já foi estornado.');
      let n = 2;
      while ((await ctx.tx.get(ctx.ref('reversals', `${revId}_${n}`))).exists) n += 1;
      revId = `${revId}_${n}`;
    }
    const target = await ctx.get(spec.coll, p.targetId);
    if (!target) throw new FinanceError(404, 'NOT_FOUND', 'Lançamento não encontrado.');
    if (spec.status && target.status !== spec.status) throw invalidState(`Só é possível estornar lançamento ${spec.status === 'received' ? 'recebido' : spec.status === 'paid' ? 'pago' : 'confirmado'}.`, { status: target.status });
    const date = p.date ?? today(ctx);
    const amount = p.kind === 'invoice' ? Number(target.paidCents) || 0 : Number(target.amountCents) || 0;
    const rev = { kind: p.kind, targetCollection: spec.coll, targetId: target.id, amountCents: amount, reason: p.reason, date: toTs(date), operationId, original: {}, ...stamps(true) };
    const touches = [];
    const writes = [];
    const requireBalance = async (accountId, needed) => {
      const account = await ctx.account(accountId, { allowInactive: true });
      const balance = await ctx.balanceOf(account);
      if (balance < needed) throw insufficient(balance, needed, account);
    };
    const snapshot = (keys) => Object.fromEntries(keys.filter((k) => target[k] !== undefined).map((k) => [k, target[k]]));
    if (p.kind === 'income') {
      await requireBalance(target.accountId, amount);
      Object.assign(rev, { accountId: target.accountId, originalDate: target.receivedDate, original: snapshot(['status', 'receivedDate', 'amountCents', 'accountId']) });
      writes.push((c) => c.tx.update(c.ref('incomes', target.id), { status: 'pending', receivedDate: FieldValue.delete(), ...stamps() }));
      touches.push(target.accountId);
    } else if (p.kind === 'expense') {
      await ctx.account(target.accountId, { allowInactive: true });
      Object.assign(rev, { accountId: target.accountId, originalDate: target.paidDate, original: snapshot(['status', 'paidDate', 'amountCents', 'accountId']) });
      writes.push((c) => c.tx.update(c.ref('expenses', target.id), { status: 'pending', paidDate: FieldValue.delete(), ...stamps() }));
      touches.push(target.accountId);
    } else if (p.kind === 'transfer') {
      await requireBalance(target.toAccountId, amount); // o destino devolve o valor
      await ctx.account(target.fromAccountId, { allowInactive: true });
      Object.assign(rev, { fromAccountId: target.fromAccountId, toAccountId: target.toAccountId, originalDate: target.date, original: snapshot(['status', 'date', 'amountCents', 'fromAccountId', 'toAccountId']) });
      writes.push((c) => c.tx.update(c.ref('transfers', target.id), { status: 'cancelled', ...stamps() }));
      touches.push(target.fromAccountId, target.toAccountId);
    } else if (p.kind === 'invoice') {
      await ctx.account(target.accountId, { allowInactive: true });
      Object.assign(rev, { accountId: target.accountId, originalDate: target.paidAt, original: snapshot(['status', 'paidCents', 'totalCents', 'accountId', 'paidAt']) });
      writes.push((c) => c.tx.update(c.ref('invoices', target.id), { status: 'closed', paidCents: FieldValue.delete(), accountId: FieldValue.delete(), paidAt: FieldValue.delete(), ...stamps() }));
      touches.push(target.accountId);
    } else if (p.kind === 'debtPayment') {
      const debtor = await ctx.get('debtors', target.debtorId);
      if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor do recebimento não encontrado.');
      await requireBalance(target.accountId, amount); // o dinheiro recebido sai da conta
      Object.assign(rev, { accountId: target.accountId, debtorId: target.debtorId, ...(target.debtId ? { debtId: target.debtId } : { purchaseId: target.purchaseId }), originalDate: target.date, original: snapshot(['debtId', 'purchaseId', 'debtorId', 'amountCents', 'date', 'accountId']) });
      const parcelColl = target.debtId ? 'debts' : null;
      const parcel = parcelColl ? await ctx.get('debts', target.debtId) : null;
      const newReceived = Math.max(0, (Number(debtor.receivedCents) || 0) - amount);
      writes.push((c) => c.tx.update(c.ref('debtors', debtor.id), { receivedCents: newReceived, ...(debtor.status === 'paid' ? { status: 'open' } : {}), ...stamps() }));
      if (parcel && parcel.status === 'paid') writes.push((c) => c.tx.update(c.ref('debts', parcel.id), { status: 'pending', ...stamps() }));
      touches.push(target.accountId);
    } else if (p.kind === 'goalTransaction') {
      const goal = await ctx.get('goals', target.goalId);
      if (!goal) throw new FinanceError(404, 'NOT_FOUND', 'Meta não encontrada.');
      const { saved } = await goalSaved(ctx, goal.id);
      const deposit = target.type === 'deposit';
      if (deposit && saved < amount) throw invalidState('O valor guardado na meta é menor que o aporte: estorne antes os resgates posteriores.', { savedCents: saved });
      if (!deposit) await requireBalance(target.accountId, amount); else await ctx.account(target.accountId, { allowInactive: true });
      Object.assign(rev, { accountId: target.accountId, goalId: goal.id, originalDate: target.date, original: snapshot(['goalId', 'type', 'amountCents', 'date', 'accountId']) });
      const nextSaved = deposit ? saved - amount : saved + amount;
      const nextStatus = nextSaved >= goal.targetCents ? 'completed' : goal.status === 'completed' ? 'active' : goal.status;
      if (nextStatus !== goal.status && goal.status !== 'cancelled') writes.push((c) => c.tx.update(c.ref('goals', goal.id), { status: nextStatus, ...stamps() }));
      touches.push(target.accountId);
    }
    if (rev.originalDate) rev.originalDate = toTs(rev.originalDate);
    for (const k of Object.keys(rev.original)) if (typeof rev.original[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rev.original[k])) rev.original[k] = toTs(rev.original[k]);
    return {
      result: { reversalId: revId, kind: p.kind, targetId: target.id, amountCents: amount },
      apply(c) {
        c.tx.create(c.ref('reversals', revId), rev);
        for (const w of writes) w(c);
        for (const id of new Set(touches)) c.touchAccount(id);
      },
    };
  },
});

// ===============================================================================================================
// CONTAS E DEVEDORES — ajuste de abertura, arquivamento lógico e exclusão só sem histórico
// ===============================================================================================================

defineOp('account.adjustOpening', {
  validate: (p) => ({ accountId: v.id(p.accountId, 'accountId'), realBalanceCents: Number.isInteger(p.realBalanceCents) && p.realBalanceCents >= 0 ? p.realBalanceCents : (() => { throw new FinanceError(400, 'INVALID_AMOUNT', '"realBalanceCents" deve ser um inteiro >= 0.'); })(), openingDate: p.openingDate ? v.date(p.openingDate, 'openingDate') : undefined }),
  async prepare(ctx, p) {
    const account = await ctx.account(p.accountId, { allowInactive: true });
    const probe = { ...account, ...(p.openingDate ? { openingDate: p.openingDate } : {}) };
    const current = await ctx.balanceOf(probe);
    const movements = current - (Number(account.initialBalanceCents) || 0);
    const newInitial = p.realBalanceCents - movements;
    if (newInitial < 0) throw invalidState('Os lançamentos já somam mais que o saldo informado; defina uma data de abertura para ignorar movimentos anteriores.', { movementsCents: movements });
    return {
      result: { accountId: account.id, previousInitialCents: Number(account.initialBalanceCents) || 0, newInitialCents: newInitial, movementsCents: movements },
      apply(c) { c.tx.update(c.ref('accounts', account.id), { initialBalanceCents: newInitial, ...(p.openingDate ? { openingDate: toTs(p.openingDate) } : {}), ledgerSeq: FieldValue.increment(1), ...stamps() }); },
    };
  },
});

for (const [name, status] of [['archive', 'archived'], ['unarchive', 'active']]) {
  defineOp(`account.${name}`, {
    validate: (p) => ({ accountId: v.id(p.accountId, 'accountId') }),
    async prepare(ctx, p) {
      const account = await ctx.account(p.accountId, { allowInactive: true });
      if (status === 'archived' && account.status === 'archived') throw invalidState('A conta já está arquivada.');
      if (status === 'active' && account.status !== 'archived') throw invalidState('Só contas arquivadas podem ser desarquivadas.');
      return { result: { accountId: account.id, status }, apply(c) { c.tx.update(c.ref('accounts', account.id), { status, ledgerSeq: FieldValue.increment(1), ...stamps() }); } };
    },
  });
}

/** Referências a uma conta (qualquer coleção): existência de 1 documento basta para bloquear a exclusão. */
async function accountHasHistory(ctx, id) {
  const probes = [['incomes', 'accountId'], ['expenses', 'accountId'], ['transfers', 'fromAccountId'], ['transfers', 'toAccountId'], ['subscriptions', 'accountId'],
    ['debtPayments', 'accountId'], ['creditCards', 'accountId'], ['goals', 'accountId'], ['goalTransactions', 'accountId'], ['invoices', 'accountId'], ['reversals', 'accountId']];
  for (const [coll, field] of probes) {
    const snap = await ctx.tx.get(ctx.col(coll).where(field, '==', id).limit(1));
    if (!snap.empty) return coll;
  }
  return null;
}

defineOp('account.delete', {
  validate: (p) => ({ accountId: v.id(p.accountId, 'accountId') }),
  async prepare(ctx, p) {
    const account = await ctx.account(p.accountId, { allowInactive: true });
    const used = await accountHasHistory(ctx, account.id);
    if (used) throw new FinanceError(409, 'HAS_HISTORY', 'A conta possui histórico financeiro e não pode ser apagada; arquive-a para preservá-lo.', { collection: used });
    if ((Number(account.initialBalanceCents) || 0) > 0) throw new FinanceError(409, 'HAS_HISTORY', 'A conta possui saldo de abertura; arquive-a em vez de apagar.');
    return { result: { accountId: account.id, deleted: true }, apply(c) { c.tx.delete(c.ref('accounts', account.id)); } };
  },
});

for (const [name, archived] of [['archive', true], ['unarchive', false]]) {
  defineOp(`debtor.${name}`, {
    validate: (p) => ({ debtorId: v.id(p.debtorId, 'debtorId') }),
    async prepare(ctx, p) {
      const debtor = await ctx.get('debtors', p.debtorId);
      if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor não encontrado.');
      if (archived && debtor.status === 'open') throw invalidState('Devedor em aberto: quite ou cancele antes de arquivar.');
      if (archived && debtor.archived) throw invalidState('O devedor já está arquivado.');
      if (!archived && !debtor.archived) throw invalidState('O devedor não está arquivado.');
      return { result: { debtorId: debtor.id, archived }, apply(c) { c.tx.update(c.ref('debtors', debtor.id), archived ? { archived: true, ...stamps() } : { archived: FieldValue.delete(), ...stamps() }); } };
    },
  });
}

defineOp('debtor.delete', {
  validate: (p) => ({ debtorId: v.id(p.debtorId, 'debtorId') }),
  async prepare(ctx, p) {
    const debtor = await ctx.get('debtors', p.debtorId);
    if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor não encontrado.');
    for (const coll of ['debts', 'debtPayments', 'cardPurchases', 'reversals', 'subscriptions']) {
      const snap = await ctx.tx.get(ctx.col(coll).where('debtorId', '==', debtor.id).limit(1));
      if (!snap.empty) throw new FinanceError(409, 'HAS_HISTORY', 'O devedor possui dívidas, compras, assinaturas ou recebimentos e não pode ser apagado; arquive-o para preservar o histórico.', { collection: coll });
    }
    return { result: { debtorId: debtor.id, deleted: true }, apply(c) { c.tx.delete(c.ref('debtors', debtor.id)); } };
  },
});

// ===============================================================================================================
// OPERAÇÃO ADMINISTRATIVA — limpeza dos PRÓPRIOS dados (substitui as exclusões diretas, agora bloqueadas nas Rules)
// ===============================================================================================================

export const CLEAR_ORDER = ['goalTransactions', 'goals', 'debtors', 'creditCards', 'debtPayments', 'debts', 'cardPurchases', 'invoices', 'subscriptions', 'budgets', 'reversals', 'batches', 'transfers', 'expenses', 'incomes', 'categories', 'accounts'];
export const CLEAR_PHRASE = 'APAGAR MEUS DADOS';

defineOp('data.clearOwn', {
  recentLogin: true, // VF-SEC-01: exige login recente
  validate: (p) => {
    if (p.confirm !== CLEAR_PHRASE) throw new FinanceError(400, 'CONFIRMATION_REQUIRED', `Digite a frase de confirmação: ${CLEAR_PHRASE}.`);
    return { confirm: CLEAR_PHRASE };
  },
  async run({ db, uid, op, operationId, params }) {
    const opRef = db.doc(`users/${uid}/operations/${operationId}`);
    const hash = requestHash(op, params);
    const existing = await opRef.get();
    if (existing.exists) {
      if (existing.data().requestHash !== hash) throw new FinanceError(409, 'OPERATION_ID_REUSED', 'Este operationId já foi usado em outra operação.');
      return { ...existing.data().result, operationId, idempotent: true };
    }
    const deleted = {};
    for (const coll of CLEAR_ORDER) {
      let total = 0;
      for (;;) {
        const snap = await db.collection(`users/${uid}/${coll}`).limit(400).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        total += snap.size;
        if (snap.size < 400) break;
      }
      deleted[coll] = total;
    }
    const result = { deleted };
    await opRef.create({ op, requestHash: hash, status: 'completed', result, createdAt: FieldValue.serverTimestamp() });
    await db.collection(`users/${uid}/auditLog`).add({ action: op, entity: 'users', entityId: uid, actorUid: uid, createdAt: FieldValue.serverTimestamp() });
    return { ...result, operationId, idempotent: false };
  },
});

export { HISTORY_LIMIT, DEBTOR_STATUSES, accountBalances, executeOnce };
