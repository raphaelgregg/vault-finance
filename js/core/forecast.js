/**
 * Previsão financeira mensal — PURO (sem DOM, sem rede). Nada é gravado: tudo é derivado dos documentos recebidos.
 *
 * Pergunta respondida: "quanto vou gastar neste mês e quanto deve sobrar no fim dele?"
 *
 * FÓRMULA (centavos inteiros):
 *   saldo projetado = saldo atual das contas ativas
 *                   + receitas PENDENTES com data prevista até o fim do mês
 *                   − despesas PENDENTES com vencimento até o fim do mês (inclui vencidas de meses anteriores)
 *                   − faturas de cartão NÃO pagas (abertas/fechadas) com vencimento até o fim do mês
 *                   − assinaturas diretas (sem cartão) com cobrança prevista no mês, exceto as já lançadas como despesa
 *                   − assinaturas no cartão AINDA NÃO LANÇADAS cuja fatura projetada vence até o fim do mês
 *                   [+ a receber de devedores no mês, só se `includeDebtors`]
 *
 * SEM DUPLA CONTAGEM:
 *  - o saldo atual já contém tudo que está pago/recebido/confirmado → só PENDENTES entram na projeção;
 *  - compra de cartão é compromisso, NÃO saída de caixa: o caixa só sai quando a FATURA é paga, então a
 *    projeção soma faturas (não compras); o "comprometido em cartões" (compras não quitadas) é só informativo;
 *  - fatura aberta = soma das suas compras; fechada = `totalCents`; paga/cancelada nunca entram;
 *  - ASSINATURA NO CARTÃO: dois conceitos separados.
 *      · comprometimento = MÊS DA COBRANÇA (data da cobrança);
 *      · saída de caixa  = MÊS DE VENCIMENTO da fatura que a receberá (fechamento/vencimento do cartão).
 *    Ainda NÃO lançada: compromisso previsto (mostra o mês da cobrança) e, no caixa, só quando a fatura
 *    projetada vence. Ao ser lançada, a cobrança vira compra: passa a compor a fatura e o comprometido do
 *    cartão, e a data da assinatura avança — então ela some da lista de previstas (nunca soma duas vezes). Se a
 *    compra já existe no cartão (mesma descrição/valor/data) a ocorrência é descartada e sinalizada;
 *  - assinatura direta que já existe como despesa do mês (mesmo nome e valor) é descartada e sinalizada;
 *  - o mês de uma fatura no caixa é o do VENCIMENTO (`dueDate`), não o `referenceMonth`.
 */
import { monthBounds } from '../utils/dates.js';
import { normalizeName } from '../utils/csv.js';
import {
  addMonths, advanceChargeDate, cardLimitUsage, invoiceDatesFor, invoiceMonthForPurchase, invoiceTotalCents, summarizeSubscriptions,
} from './model.js';

const cents = (v) => (Number.isInteger(v) ? v : Number(v) || 0);
const isoMonth = (d) => (typeof d === 'string' ? d.slice(0, 7) : null);
const sum = (rows, pick = (r) => r.amountCents) => rows.reduce((t, r) => t + cents(pick(r)), 0);

/** Total de uma fatura NÃO paga: aberta = soma das compras vinculadas; fechada = totalCents. Paga/cancelada = 0. */
export function unpaidInvoiceCents(invoice, purchases = []) {
  if (invoice?.status === 'open') return invoiceTotalCents(purchases.filter((p) => p.invoiceId === invoice.id));
  if (invoice?.status === 'closed') return cents(invoice.totalCents);
  return 0;
}

/**
 * Cobranças de uma assinatura dentro de [start, end] (ISO), a partir de `nextChargeDate`, avançando pela
 * periodicidade (semanal pode cair várias vezes no mês). Máx. 60 passos. Datas inválidas → [].
 */
export function subscriptionOccurrences(subscription, start, end) {
  const out = [];
  let date = subscription?.nextChargeDate;
  for (let i = 0; i < 60 && typeof date === 'string' && date <= end; i += 1) {
    if (date >= start) out.push(date);
    date = advanceChargeDate(date, subscription.periodicity, subscription.chargeDay);
  }
  return out;
}

/** Assinatura direta já lançada como despesa no mês (mesmo nome normalizado e valor) → duplicidade provável. */
function matchingExpense(subscription, expenses) {
  const name = normalizeName(subscription.name);
  return expenses.find((e) => normalizeName(e.description) === name && cents(e.amountCents) === cents(subscription.amountCents)) ?? null;
}

/** Cobrança de assinatura já existente como compra no cartão (mesmo cartão, descrição, valor e data). */
function matchingPurchase(subscription, date, purchases) {
  const name = normalizeName(subscription.name);
  return purchases.find((p) => p.cardId === subscription.cardId && p.purchaseDate === date
    && normalizeName(p.description) === name && cents(p.amountCents) === cents(subscription.amountCents)) ?? null;
}

/**
 * Fatura que receberia uma cobrança futura no cartão: a do mês pelo fechamento (`invoiceMonthForPurchase`); fatura
 * fechada/paga/cancelada nunca recebe compra nova (vai para a próxima, como em `registerCardPurchase`). O vencimento é
 * o da fatura existente ou, se ainda não existe, o calculado pelas regras do cartão. Cartão desconhecido → null.
 */
export function projectedInvoiceForCharge(card, chargeDate, invoices = []) {
  if (!card) return null;
  let reference = invoiceMonthForPurchase(card, chargeDate);
  for (let i = 0; i < 12 && reference; i += 1) {
    const existing = invoices.find((inv) => inv.cardId === card.id && inv.referenceMonth === reference);
    if (existing && existing.status !== 'open') { reference = addMonths(reference, 1); continue; }
    const dueDate = existing?.dueDate ?? invoiceDatesFor(card, reference)?.dueDate;
    return dueDate ? { referenceMonth: reference, dueDate } : null;
  }
  return null;
}

/**
 * @param {object} input
 *  month           "YYYY-MM" analisado
 *  today           "YYYY-MM-DD" (vencida = pendente com vencimento < today)
 *  balanceCents    saldo atual das contas ativas (derivado; já inclui pagos/recebidos)
 *  expenses        despesas com vencimento no mês (qualquer status) + pendentes anteriores (a função filtra)
 *  pendingIncomes  receitas pendentes com data prevista até o fim do mês
 *  cards, invoices, purchases   cartões, faturas e compras (compromissos)
 *  subscriptions   assinaturas ativas
 *  debtorsReceivableCents  a receber de devedores no mês (informativo; entra na projeção só com includeDebtors)
 *  includeDebtors  inclui o a receber de devedores no saldo projetado
 *  futureMonths    quantos meses seguintes detalhar (padrão 3)
 */
export function monthlyForecast({
  month, today, balanceCents = 0, expenses = [], pendingIncomes = [], cards = [], invoices = [], purchases = [],
  subscriptions = [], debtorsReceivableCents = 0, includeDebtors = false, futureMonths = 3,
} = {}) {
  const bounds = monthBounds(month);
  if (!bounds) throw new RangeError('Mês inválido (use AAAA-MM).');
  const { start, end } = bounds;
  const live = expenses.filter((e) => e?.status !== 'cancelled');

  // A. Despesas ---------------------------------------------------------------------------------------------
  const inMonth = live.filter((e) => e.dueDate >= start && e.dueDate <= end);
  const pendingThroughEnd = live.filter((e) => e.status === 'pending' && e.dueDate <= end);
  const overdue = pendingThroughEnd.filter((e) => e.dueDate < today);
  const expensesBlock = {
    plannedCents: sum(inMonth),
    paidCents: sum(inMonth.filter((e) => e.status === 'paid')),
    pendingCents: sum(inMonth.filter((e) => e.status === 'pending')),
    overdueCents: sum(overdue),
    overduePreviousCents: sum(pendingThroughEnd.filter((e) => e.dueDate < start)),
    upcomingCents: sum(pendingThroughEnd.filter((e) => e.dueDate >= today)),
    // Tudo o que ainda vai sair da conta por despesa até o fim do mês (vencidas incluídas).
    toPayCents: sum(pendingThroughEnd),
    recurringPlannedCents: sum(inMonth.filter((e) => e.recurrence && e.recurrence !== 'none')),
  };

  // Receitas pendentes até o fim do mês.
  const incomes = pendingIncomes.filter((i) => i?.status === 'pending' && i.expectedDate <= end);
  const incomesBlock = { pendingCents: sum(incomes), overdueCents: sum(incomes.filter((i) => i.expectedDate < today)) };

  // B. Cartões ----------------------------------------------------------------------------------------------
  const purchasesByInvoice = new Map();
  for (const p of purchases) {
    if (!p.invoiceId) continue;
    if (!purchasesByInvoice.has(p.invoiceId)) purchasesByInvoice.set(p.invoiceId, []);
    purchasesByInvoice.get(p.invoiceId).push(p);
  }
  const unpaid = invoices
    .filter((i) => i.status === 'open' || i.status === 'closed')
    .map((i) => ({ ...i, unpaidCents: unpaidInvoiceCents(i, purchasesByInvoice.get(i.id) ?? []) }));
  const due = unpaid.filter((i) => i.dueDate <= end);
  const cardsBlock = {
    // Compromisso: tudo que foi comprado e ainda não quitado (inclui parcelas de meses futuros). NÃO é saída de caixa.
    committedCents: cards.filter((c) => c.status === 'active')
      .reduce((t, c) => t + cardLimitUsage(c, purchases.filter((p) => p.cardId === c.id), invoices.filter((i) => i.cardId === c.id)).usedCents, 0),
    purchasesInMonthCents: sum(purchases.filter((p) => isoMonth(p.purchaseDate) === month)),
    openInvoicesCents: sum(due.filter((i) => i.status === 'open'), (i) => i.unpaidCents),
    closedInvoicesCents: sum(due.filter((i) => i.status === 'closed'), (i) => i.unpaidCents),
    invoicesToPayCents: sum(due, (i) => i.unpaidCents),
    invoicesDueInMonthCents: sum(due.filter((i) => i.dueDate >= start), (i) => i.unpaidCents),
    invoicesOverdueCents: sum(due.filter((i) => i.dueDate < today), (i) => i.unpaidCents),
  };

  // C. Assinaturas ------------------------------------------------------------------------------------------
  const active = subscriptions.filter((s) => s?.status === 'active');
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const horizonEnd = monthBounds(addMonths(month, futureMonths) ?? month).end;
  const lookbackStart = `${addMonths(month, -1)}-01`; // cobranças não lançadas do mês anterior ainda podem vencer neste mês
  const duplicates = [];
  const directItems = []; // saem da conta na própria data
  const cardCharges = []; // ainda NÃO lançadas no cartão
  for (const s of active) {
    if (!s.cardId && !s.accountId) continue; // sem conta nem cartão (só devedor ou só acompanhamento): não sai do SEU caixa
    if (!s.cardId) {
      for (const date of subscriptionOccurrences(s, start, end)) {
        const twin = matchingExpense(s, inMonth);
        if (twin) { duplicates.push({ subscriptionId: s.id, name: s.name, expenseId: twin.id, date, amountCents: cents(s.amountCents), via: 'expense' }); continue; }
        directItems.push({ id: s.id, name: s.name, date, amountCents: cents(s.amountCents), viaCard: false });
      }
      continue;
    }
    for (const date of subscriptionOccurrences(s, lookbackStart, horizonEnd)) {
      const twin = matchingPurchase(s, date, purchases);
      if (twin) { duplicates.push({ subscriptionId: s.id, name: s.name, purchaseId: twin.id, date, amountCents: cents(s.amountCents), via: 'purchase' }); continue; }
      const projected = projectedInvoiceForCharge(cardById.get(s.cardId), date, invoices);
      cardCharges.push({
        id: s.id, name: s.name, cardId: s.cardId, date, chargeMonth: isoMonth(date), amountCents: cents(s.amountCents), viaCard: true,
        referenceMonth: projected?.referenceMonth ?? null,
        // Sem cartão conhecido não há fatura para projetar: cai no caixa na própria data (conservador).
        dueDate: projected?.dueDate ?? date,
      });
    }
  }
  const nextCharges = active
    .filter((s) => s.nextChargeDate)
    .map((s) => ({ id: s.id, name: s.name, date: s.nextChargeDate, amountCents: cents(s.amountCents), viaCard: Boolean(s.cardId) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Já lançadas no cartão: estão em `cardLimitUsage`/faturas (comprometido e caixa pelo vencimento) — informativo, NÃO somado.
  const openOrClosedInvoiceIds = new Set(invoices.filter((i) => i.status === 'open' || i.status === 'closed').map((i) => i.id));
  const launchedInCardsCents = sum(purchases.filter((p) => p.notes === 'Assinatura' && (!p.invoiceId || openOrClosedInvoiceIds.has(p.invoiceId))));
  const cardInMonth = cardCharges.filter((c) => c.chargeMonth === month);
  const cardCashThroughEnd = cardCharges.filter((c) => c.dueDate <= end);
  const subscriptionsBlock = {
    monthlyCents: summarizeSubscriptions(active).monthlyCents, // valor mensal consolidado (todas as ativas)
    directCents: sum(directItems),
    // COMPROMETIMENTO: cobranças previstas (não lançadas) no mês em que são cobradas.
    cardCommitmentCents: sum(cardInMonth),
    plannedInMonthCents: sum(directItems) + sum(cardInMonth),
    // SAÍDA DE CAIXA: cobranças no cartão não lançadas cuja fatura projetada vence até o fim do mês.
    cardCashCents: sum(cardCashThroughEnd),
    launchedInCardsCents,
    items: [...directItems, ...cardInMonth],
    cardCharges,
    duplicates,
    nextCharges,
  };

  // D. A receber de devedores (parcelas e dívidas deles; informativo por padrão) ---------------------------------
  const debtorsBlock = { receivableCents: cents(debtorsReceivableCents), included: Boolean(includeDebtors) };

  // Saldo projetado ---------------------------------------------------------------------------------------------
  const components = [
    { key: 'incomes', label: 'Receitas pendentes', cents: incomesBlock.pendingCents },
    { key: 'expenses', label: 'Despesas pendentes e vencidas', cents: -expensesBlock.toPayCents },
    { key: 'invoices', label: 'Faturas de cartão a pagar', cents: -cardsBlock.invoicesToPayCents },
    { key: 'subscriptionsDirect', label: 'Assinaturas previstas (conta)', cents: -subscriptionsBlock.directCents },
    { key: 'subscriptionsCard', label: 'Assinaturas no cartão não lançadas (fatura vence no mês)', cents: -subscriptionsBlock.cardCashCents },
    ...(debtorsBlock.included ? [{ key: 'debtors', label: 'A receber de devedores', cents: debtorsBlock.receivableCents }] : []),
  ];
  const projectedBalanceCents = cents(balanceCents) + components.reduce((t, c) => t + c.cents, 0);

  // Meses seguintes ---------------------------------------------------------------------------------------------
  const next = [];
  for (let i = 1; i <= futureMonths; i += 1) {
    const m = addMonths(month, i);
    const b = monthBounds(m);
    const monthExpenses = sum(live.filter((e) => e.status === 'pending' && e.dueDate >= b.start && e.dueDate <= b.end));
    const monthInvoices = sum(unpaid.filter((inv) => inv.dueDate >= b.start && inv.dueDate <= b.end), (inv) => inv.unpaidCents);
    // Saída de caixa: assinaturas diretas na data + assinaturas no cartão não lançadas pelo vencimento da fatura projetada.
    const monthSubs = sum(active.filter((s) => !s.cardId && s.accountId).flatMap((s) => subscriptionOccurrences(s, b.start, b.end).map(() => s)), (s) => s.amountCents)
      + sum(cardCharges.filter((c) => c.dueDate >= b.start && c.dueDate <= b.end));
    // Comprometimento (informativo, fora do total de caixa): cobranças previstas no cartão pelo MÊS DA COBRANÇA.
    const cardChargesCommitted = sum(cardCharges.filter((c) => c.chargeMonth === m));
    next.push({
      month: m, expensesCents: monthExpenses, invoicesCents: monthInvoices, subscriptionsCents: monthSubs,
      cardSubscriptionChargesCents: cardChargesCommitted, commitmentsCents: monthExpenses + monthInvoices + monthSubs,
    });
  }

  return {
    month, start, end,
    balanceCents: cents(balanceCents),
    expenses: expensesBlock,
    incomes: incomesBlock,
    cards: cardsBlock,
    subscriptions: subscriptionsBlock,
    debtors: debtorsBlock,
    components,
    projectedBalanceCents,
    nextMonths: next,
  };
}
