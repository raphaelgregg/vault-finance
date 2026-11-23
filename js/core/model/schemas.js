/**
 * Schemas das entidades — espelham EXATAMENTE as Security Rules (firestore.rules). Toda mudança aqui exige conferir as Rules e `tests/rules/`.
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */
import { ACCOUNT_TYPES, RECURRENCES, SUBSCRIPTION_PERIODICITIES, SUBSCRIPTION_STATUSES, DEBTOR_STATUSES, DEBT_STATUSES, GOAL_STATUSES, GOAL_TRANSACTION_TYPES, CARD_STATUSES, INVOICE_STATUSES } from '../../utils/constants.js';

const text = (max, required = true) => ({ kind: 'text', max, required });
const date = (required = true) => ({ kind: 'date', required });
const optionalDate = () => ({ kind: 'date', required: false });
const refField = (required = true, kindCompat = null) => ({
  kind: 'ref',
  max: 128,
  required,
  ...(kindCompat ? { kindCompat } : {}),
});
const money = () => ({ kind: 'cents', required: true, positive: true });
const cents0 = () => ({ kind: 'cents', required: true, positive: false });
const centsNonNegative = () => ({ kind: 'cents', required: true, positive: false, nonNegative: true });
const intRange = (min, max) => ({ kind: 'int', required: true, min, max });
const monthKey = () => ({ kind: 'month', required: true });
const optionalCentsNonNegative = () => ({ kind: 'cents', required: false, positive: false, nonNegative: true });
const optionalText = (max) => ({ kind: 'text', max, required: false });

export const SCHEMAS = Object.freeze({
  accounts: {
    dateFields: ['openingDate'],
    fields: {
      institution: text(80),
      name: optionalText(80), // opcional: conta sem nome específico = só a instituição
      type: { kind: 'enum', required: true, values: ACCOUNT_TYPES.map((t) => t.value) },
      initialBalanceCents: cents0(), // SALDO DE ABERTURA: dinheiro que a conta tinha em `openingDate` (ou ao começar a usar o sistema)
      openingDate: optionalDate(), // opcional: só movimentos a partir dela entram no saldo; ausente = todos (contas antigas)
      color: text(32),
      status: { kind: 'enum', required: true, values: ['active', 'inactive', 'archived'] },
    },
  },
  categories: {
    dateFields: [],
    fields: {
      name: text(60),
      kind: { kind: 'enum', required: true, values: ['income', 'expense', 'both'] },
      color: text(32),
    },
  },
  incomes: {
    dateFields: ['expectedDate', 'receivedDate'],
    fields: {
      description: text(120),
      // Receitas só aceitam categoria de receita ou "ambos".
      categoryId: refField(true, ['income', 'both']),
      amountCents: money(),
      expectedDate: date(),
      receivedDate: optionalDate(),
      accountId: refField(),
      status: { kind: 'enum', required: true, values: ['pending', 'received', 'cancelled'] },
      recurrence: { kind: 'enum', required: true, values: RECURRENCES.map((r) => r.value) },
      notes: optionalText(500),
    },
  },
  expenses: {
    dateFields: ['purchaseDate', 'dueDate', 'paidDate'],
    fields: {
      description: text(120),
      // Despesas só aceitam categoria de despesa ou "ambos".
      categoryId: refField(true, ['expense', 'both']),
      amountCents: money(),
      accountId: refField(),
      purchaseDate: date(),
      dueDate: date(),
      paidDate: optionalDate(),
      status: { kind: 'enum', required: true, values: ['pending', 'paid', 'cancelled'] },
      recurrence: { kind: 'enum', required: true, values: RECURRENCES.map((r) => r.value) },
      notes: optionalText(500),
      installmentGroupId: optionalText(128),
    },
  },
  transfers: {
    dateFields: ['date'],
    fields: {
      fromAccountId: refField(),
      toAccountId: refField(),
      amountCents: money(),
      date: date(),
      reason: text(120),
      notes: optionalText(500),
      status: { kind: 'enum', required: true, values: ['pending', 'confirmed', 'cancelled'] },
    },
  },
  subscriptions: {
    dateFields: ['nextChargeDate'],
    fields: {
      name: text(80),
      amountCents: money(),
      periodicity: { kind: 'enum', required: true, values: SUBSCRIPTION_PERIODICITIES.map((p) => p.value) },
      nextChargeDate: date(),
      accountId: refField(),
      // Cobrada no cartão (VF-2-03r): a cobrança vira parcela única na FATURA (não é débito direto na conta).
      cardId: refField(false),
      // Assinaturas são cobradas como despesa: categoria de despesa ou "ambos".
      categoryId: refField(true, ['expense', 'both']),
      status: { kind: 'enum', required: true, values: SUBSCRIPTION_STATUSES.map((s) => s.value) },
      notes: optionalText(500),
    },
  },
  debtors: {
    dateFields: ['loanDate'],
    fields: {
      name: text(80),
      loanDate: date(),
      // Pode ser 0 (VF-2-03l): devedor sem empréstimo inicial, ex.: só compras no cartão (que somam aqui).
      lentCents: centsNonNegative(),
      // Gravado pelo service (começa em 0); a Rule exige 0 <= receivedCents <= lentCents.
      receivedCents: centsNonNegative(),
      status: { kind: 'enum', required: true, values: DEBTOR_STATUSES.map((s) => s.value) },
      notes: optionalText(500),
    },
  },
  // Parcelas de devedores (VF-2-03b2) — espelha firestore.rules `debts`.
  debts: {
    dateFields: ['dueDate'],
    fields: {
      debtorId: refField(),
      description: text(120),
      principalCents: money(),
      dueDate: date(),
      installmentNumber: intRange(1, 360),
      // Dívida à vista (1) ou parcelada (N) e agrupamento das parcelas (VF-2-03m); ausentes em parcelas legadas.
      installmentsTotal: { kind: 'int', required: false, min: 1, max: 360 },
      debtGroupId: optionalText(128),
      status: { kind: 'enum', required: true, values: DEBT_STATUSES.map((s) => s.value) },
    },
  },
  // Metas (VF-2-03c) — espelha firestore.rules `goals`. Valor guardado é derivado.
  goals: {
    dateFields: ['deadline'],
    fields: {
      name: text(80),
      description: optionalText(300),
      targetCents: money(),
      deadline: optionalDate(),
      accountId: refField(false),
      status: { kind: 'enum', required: true, values: GOAL_STATUSES.map((s) => s.value) },
    },
  },
  // Movimentações de metas — espelha firestore.rules `goalTransactions`.
  goalTransactions: {
    dateFields: ['date'],
    fields: {
      goalId: refField(),
      type: { kind: 'enum', required: true, values: GOAL_TRANSACTION_TYPES.map((t) => t.value) },
      amountCents: money(),
      date: date(),
      accountId: refField(),
      notes: optionalText(300),
    },
  },
  // Orçamentos (VF-2-03e) — espelha firestore.rules `budgets`. Gasto/restante são derivados.
  budgets: {
    dateFields: [],
    fields: {
      categoryId: refField(true, ['expense', 'both']),
      month: monthKey(),
      limitCents: money(),
    },
  },
  // Cartões (VF-2-03d) — espelha firestore.rules `creditCards`.
  creditCards: {
    dateFields: [],
    fields: {
      name: text(80),
      brand: text(40),
      limitCents: money(),
      closingDay: intRange(1, 31),
      dueDay: intRange(1, 31),
      accountId: refField(false),
      color: optionalText(32),
      status: { kind: 'enum', required: true, values: CARD_STATUSES.map((s) => s.value) },
    },
  },
  // Compras no cartão (cada parcela é um documento) — espelha `cardPurchases`.
  cardPurchases: {
    dateFields: ['purchaseDate'],
    fields: {
      cardId: refField(),
      description: text(120),
      amountCents: money(),
      purchaseDate: date(),
      installmentsTotal: intRange(1, 48),
      installmentNumber: intRange(1, 48),
      categoryId: refField(false, ['expense', 'both']),
      invoiceId: refField(false),
      // Compra de cartão feita para um devedor (VF-2-03i): soma ao valor emprestado dele.
      debtorId: refField(false),
      notes: optionalText(300),
    },
  },
  // Faturas — espelha `invoices`. totalCents/paidCents só são gravados no fechamento/pagamento.
  invoices: {
    dateFields: ['closingDate', 'dueDate', 'paidAt'],
    fields: {
      cardId: refField(),
      referenceMonth: monthKey(),
      closingDate: optionalDate(),
      dueDate: date(),
      totalCents: optionalCentsNonNegative(),
      paidCents: optionalCentsNonNegative(),
      // Pagamento (VF-2-03p): conta bancária debitada e data; o saldo da conta segue DERIVADO (accountBalances).
      accountId: refField(false),
      paidAt: optionalDate(),
      status: { kind: 'enum', required: true, values: INVOICE_STATUSES.map((s) => s.value) },
    },
  },
  // Recebimentos — espelha firestore.rules `debtPayments`.
  debtPayments: {
    dateFields: ['date'],
    fields: {
      // Recebimento de UMA parcela: de uma dívida (`debtId`) OU de uma parcela de compra no cartão vinculada ao
      // devedor (`purchaseId`) — exatamente um dos dois (validado abaixo e nas Rules). Registros antigos têm `debtId`.
      debtId: refField(false),
      purchaseId: refField(false),
      debtorId: refField(),
      amountCents: money(),
      date: date(),
      accountId: refField(),
      // Chave de idempotência da operação (UUID gerado ao abrir o formulário): retry/duplo clique não duplica.
      operationId: optionalText(64),
      notes: optionalText(500),
    },
  },
});

/** Campos de referência por schema (IDs de docs da própria árvore). */
export const REF_FIELDS = Object.freeze({
  accounts: [],
  categories: [],
  incomes: ['categoryId', 'accountId'],
  expenses: ['categoryId', 'accountId'],
  transfers: ['fromAccountId', 'toAccountId'],
  subscriptions: ['accountId', 'categoryId', 'cardId'],
  debtors: [],
  budgets: ['categoryId'],
  creditCards: ['accountId'],
  cardPurchases: ['cardId', 'categoryId', 'invoiceId', 'debtorId'],
  invoices: ['cardId', 'accountId'],
  goals: ['accountId'],
  goalTransactions: ['goalId', 'accountId'],
  debts: ['debtorId'],
  debtPayments: ['debtId', 'purchaseId', 'debtorId', 'accountId'],
});
