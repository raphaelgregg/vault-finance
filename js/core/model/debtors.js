/**
 * Devedores, parcelas e recebimentos — cálculos puros (pendente, obrigações, extrato do mês, estado das parcelas).
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */
import { cardLimitUsage, invoiceTotalCents } from './cards.js';

/** Saldo pendente de um devedor (emprestado − recebido), nunca negativo. Não é gravado. */
export function debtorPendingCents(debtor) {
  const lent = Number(debtor?.lentCents);
  const received = Number(debtor?.receivedCents) || 0;
  if (!Number.isInteger(lent)) return 0;
  return Math.max(0, lent - received);
}

/**
 * Visão consolidada de um devedor por origem (VF-2-03i). `lentCents` já inclui as compras de
 * cartão vinculadas (o service soma ao lançar); aqui só se separa: cartão = soma das parcelas
 * vinculadas (limitada ao emprestado), empréstimo = restante. O recebido não é atribuído por origem.
 * Retorna { lentCents, receivedCents, pendingCents, cardCents, loanCents, cardCount }.
 */
export function debtorOverview(debtor, cardPurchases = []) {
  const lentCents = Number(debtor?.lentCents) || 0;
  const receivedCents = Number(debtor?.receivedCents) || 0;
  let cardCents = 0;
  for (const p of cardPurchases) cardCents += Number(p?.amountCents) || 0;
  cardCents = Math.min(cardCents, lentCents);
  return {
    lentCents,
    receivedCents,
    pendingCents: debtorPendingCents(debtor),
    cardCents,
    loanCents: lentCents - cardCents,
    cardCount: cardPurchases.length,
  };
}

/**
 * Fechamento do mês de um devedor (VF-2-03j) — puro. Soma, para `month` ("YYYY-MM"):
 *  - parcelas de compras no cartão vinculadas (`cardPurchases.debtorId`) cuja FATURA (`invoices.referenceMonth`,
 *    ou o mês da compra se ainda sem fatura) é o mês;
 *  - parcelas de empréstimo (`debts`) pendentes com vencimento no mês, pelo restante (principal − recebido).
 * Sem dupla contagem: `lentCents` já inclui o cartão, mas aqui cada origem vem da SUA coleção e o total do
 * mês é limitado ao pendente do devedor (nunca cobra mais do que ele deve). Devedor não aberto → 0.
 * Retorna { month, card: itens, loan: itens, cardCents, loanCents, rawCents, totalCents, capped }.
 */
export function debtorMonthStatement({ debtor, month, purchases = [], invoicesById = new Map(), debts = [], receivedByDebt = new Map(), receivedByPurchase = new Map() } = {}) {
  const card = [];
  for (const p of purchases) {
    const invoice = p.invoiceId ? invoicesById.get(p.invoiceId) : null;
    const referenceMonth = invoice?.referenceMonth ?? (typeof p.purchaseDate === 'string' ? p.purchaseDate.slice(0, 7) : null);
    if (referenceMonth !== month) continue;
    // Parcela de cartão já recebida do devedor (`debtPayments.purchaseId`) deixa de ser "a receber".
    const remainingCents = Math.max(0, (Number(p.amountCents) || 0) - (receivedByPurchase.get(p.id) ?? 0));
    if (remainingCents <= 0) continue;
    card.push({ ...p, referenceMonth, invoiceStatus: invoice?.status ?? null, remainingCents });
  }
  const loan = [];
  for (const d of debts) {
    if (d.status === 'cancelled') continue;
    if (d.status === 'paid' || typeof d.dueDate !== 'string' || d.dueDate.slice(0, 7) !== month) continue;
    const remainingCents = (Number(d.principalCents) || 0) - (receivedByDebt.get(d.id) ?? 0);
    if (remainingCents > 0) loan.push({ ...d, remainingCents });
  }
  const cardCents = card.reduce((t, p) => t + p.remainingCents, 0);
  const loanCents = loan.reduce((t, d) => t + d.remainingCents, 0);
  const rawCents = cardCents + loanCents;
  const open = debtor?.status === 'open';
  const pending = debtorPendingCents(debtor);
  const totalCents = open ? Math.min(rawCents, pending) : 0;
  return {
    month, card, loan, cardCents, loanCents, rawCents, totalCents,
    capped: open && rawCents > pending,
  };
}

/**
 * Recebimentos por parcela: { byDebt: Map(debtId → centavos), byPurchase: Map(purchaseId → centavos) }. Puro.
 * Cada recebimento aponta para UMA parcela (dívida ou compra no cartão); somados uma única vez.
 */
export function receivedByInstallment(payments = [], reversals = []) {
  const byDebt = new Map();
  const byPurchase = new Map();
  const reversed = new Set(reversals.filter((r) => r.targetCollection === 'debtPayments').map((r) => r.targetId));
  for (const p of payments) {
    if (reversed.has(p?.id)) continue; // recebimento estornado não conta (o documento original é preservado)
    const amount = Number(p?.amountCents) || 0;
    if (p?.debtId) byDebt.set(p.debtId, (byDebt.get(p.debtId) ?? 0) + amount);
    else if (p?.purchaseId) byPurchase.set(p.purchaseId, (byPurchase.get(p.purchaseId) ?? 0) + amount);
  }
  return { byDebt, byPurchase };
}

/**
 * Parcelas PENDENTES de um mês de referência (puro) — base da quitação em lote e do resumo da tela. São as
 * obrigações do devedor (dívidas por vencimento; compras no cartão pelo mês da fatura) com restante > 0 e não
 * pagas/canceladas; parcelas pagas e de outros meses ficam de fora. Retorna { items, count, totalCents }.
 */
export function pendingInstallmentsOfMonth({ month, ...input } = {}) {
  const items = debtorObligations(input).items
    .filter((i) => i.referenceMonth === month && i.status === 'pending' && i.remainingCents > 0);
  return { items, count: items.length, totalCents: items.reduce((t, i) => t + i.remainingCents, 0) };
}

/**
 * Valor a lançar num consolidado de fatura (VF-2-03r) — puro. Dado o total que consta no extrato do cartão e o
 * total já lançado na fatura (itens avulsos, de devedores, assinaturas), o consolidado cobre só a diferença.
 * Retorna centavos inteiros > 0, ou null quando o extrato não excede o já lançado/entrada inválida.
 */
export function consolidationDeltaCents(currentCents, statementCents) {
  if (!Number.isInteger(currentCents) || !Number.isInteger(statementCents)) return null;
  const delta = statementCents - currentCents;
  return delta > 0 ? delta : null;
}

/**
 * Faturas de cartão do mês e limite (VF-2-03q) — puro. `month` = referenceMonth da fatura; canceladas fora.
 * Total da fatura: aberta = soma das parcelas vinculadas; fechada/paga = `totalCents` gravado.
 * `dueCents` = abertas + fechadas (ainda a pagar); `paidCents` = pagas. Limite/usado/disponível: só cartões
 * ativos, com `cardLimitUsage` (compras de faturas pagas/canceladas já liberam o limite).
 * Retorna { count, openCents, closedCents, paidCents, dueCents, limitCents, usedCents, availableCents }.
 */
export function cardInvoicesSummary({ cards = [], invoices = [], purchases = [], month } = {}) {
  const out = { count: 0, openCents: 0, closedCents: 0, paidCents: 0, dueCents: 0, limitCents: 0, usedCents: 0, availableCents: 0 };
  for (const invoice of invoices) {
    if (invoice.referenceMonth !== month || invoice.status === 'cancelled') continue;
    const total = invoice.status === 'open'
      ? invoiceTotalCents(purchases.filter((p) => p.invoiceId === invoice.id))
      : Number(invoice.status === 'paid' ? (invoice.paidCents ?? invoice.totalCents) : invoice.totalCents) || 0;
    out.count += 1;
    if (invoice.status === 'open') out.openCents += total;
    else if (invoice.status === 'closed') out.closedCents += total;
    else if (invoice.status === 'paid') out.paidCents += total;
  }
  out.dueCents = out.openCents + out.closedCents;
  for (const card of cards) {
    if (card.status !== 'active') continue;
    const usage = cardLimitUsage(card, purchases.filter((p) => p.cardId === card.id), invoices.filter((i) => i.cardId === card.id));
    out.limitCents += Number(card.limitCents) || 0;
    out.usedCents += usage.usedCents;
    out.availableCents += usage.availableCents;
  }
  return out;
}

/**
 * Estado de recebimento de UMA parcela, derivado da SOMA dos recebimentos associados (nunca gravado):
 * `pending` = nada recebido; `partial` = recebido menor que o valor; `paid` = recebido igual (ou parcela já
 * marcada paga). Puro.
 */
export function installmentPaymentState(amountCents, receivedCents, debtStatus = null) {
  if (debtStatus === 'cancelled') return 'cancelled';
  const received = Number(receivedCents) || 0;
  if (debtStatus === 'paid' || received >= (Number(amountCents) || 0)) return 'paid';
  return received > 0 ? 'partial' : 'pending';
}

/**
 * Dívidas do devedor em lista única (VF-2-03m) — puro. Cada obrigação é independente:
 *  - `cash`: dívida à vista (`debts` com installmentsTotal 1);
 *  - `installment`: dívida parcelada (`debts` com installmentsTotal N, agrupadas por `debtGroupId`);
 *  - `legacy`: parcela antiga de empréstimo (sem installmentsTotal);
 *  - `card`: parcela de compra no cartão (`cardPurchases.debtorId`), com cartão, fatura e status da fatura.
 * Totais: `openCents` = pendente do devedor (valor emprestado − recebido, mantido pelos services; é o que
 * os recebimentos abatem); `listedCents` = restante das obrigações listadas, limitado a `openCents`;
 * `unlistedCents` = parte em aberto sem obrigação detalhada (ex.: valor inicial informado sem parcelas) —
 * informativo, nunca alerta. Não há mais teste de "duplicidade": várias obrigações legítimas coexistem.
 */
export function debtorObligations({ debtor, debts = [], receivedByDebt = new Map(), receivedByPurchase = new Map(), purchases = [], invoicesById = new Map(), cardsById = new Map() } = {}) {
  const items = [];
  for (const d of debts) {
    if (d.status === 'cancelled') continue;
    const received = receivedByDebt.get(d.id) ?? 0;
    const total = Number(d.installmentsTotal) || null;
    items.push({
      source: 'debt', id: d.id, groupId: d.debtGroupId ?? d.id,
      kind: total === 1 ? 'cash' : total ? 'installment' : 'legacy',
      description: d.description, installmentNumber: d.installmentNumber, installmentsTotal: total,
      amountCents: Number(d.principalCents) || 0, receivedCents: received,
      remainingCents: d.status === 'paid' ? 0 : Math.max(0, (Number(d.principalCents) || 0) - received),
      dueDate: d.dueDate, referenceMonth: typeof d.dueDate === 'string' ? d.dueDate.slice(0, 7) : null,
      status: d.status === 'paid' || (Number(d.principalCents) || 0) - received <= 0 ? 'paid' : 'pending',
      paymentState: installmentPaymentState(Number(d.principalCents) || 0, received, d.status),
    });
  }
  for (const p of purchases) {
    const invoice = p.invoiceId ? invoicesById.get(p.invoiceId) : null;
    const amount = Number(p.amountCents) || 0;
    const received = Math.min(amount, receivedByPurchase.get(p.id) ?? 0);
    items.push({
      source: 'card', id: p.id, groupId: p.purchaseGroup ?? `${p.cardId}:${p.description}:${p.purchaseDate}`, kind: 'card',
      description: p.description, cardName: cardsById.get(p.cardId) ?? null,
      installmentNumber: p.installmentNumber, installmentsTotal: p.installmentsTotal,
      amountCents: amount, receivedCents: received, remainingCents: invoice?.status === 'cancelled' ? 0 : amount - received,
      dueDate: invoice?.dueDate ?? null,
      referenceMonth: invoice?.referenceMonth ?? (typeof p.purchaseDate === 'string' ? p.purchaseDate.slice(0, 7) : null),
      invoiceStatus: invoice?.status ?? null,
      // `paid` = o DEVEDOR pagou esta parcela (recebimento registrado); a situação da fatura do cartão é `invoiceStatus`.
      status: received >= amount ? 'paid' : invoice?.status === 'cancelled' ? 'cancelled' : 'pending',
      paymentState: invoice?.status === 'cancelled' && received < amount ? 'cancelled' : installmentPaymentState(amount, received),
    });
  }
  items.sort((a, b) => String(a.referenceMonth).localeCompare(String(b.referenceMonth))
    || String(a.description).localeCompare(String(b.description)) || (a.installmentNumber - b.installmentNumber));
  const openCents = debtorPendingCents(debtor);
  const listedCents = Math.min(openCents, items.reduce((t, i) => t + i.remainingCents, 0));
  return { items, openCents, listedCents, unlistedCents: openCents - listedCents };
}

/**
 * Totais dos devedores EM ABERTO (cancelados e quitados não entram em "a receber").
 * Retorna { openCount, pendingCents, receivedCents }; recebido soma os não cancelados.
 */
export function summarizeDebtors(items = []) {
  let openCount = 0;
  let pendingCents = 0;
  let receivedCents = 0;
  for (const item of items) {
    if (item?.status === 'cancelled') continue;
    receivedCents += Number(item?.receivedCents) || 0;
    if (item?.status !== 'open') continue;
    openCount += 1;
    pendingCents += debtorPendingCents(item);
  }
  return { openCount, pendingCents, receivedCents };
}

// ---------------------------------------------------------------------------
// Parcelas e recebimentos (VF-2-03b2) — puros
// ---------------------------------------------------------------------------

/**
 * Aplica um recebimento ao devedor. Retorna { ok, receivedCents, status, error }.
 * Rejeita devedor não aberto, valor inválido e valor acima do pendente; quita
 * (status paid) quando o pendente zera. Nada é gravado aqui.
 */
export function applyPaymentToDebtor(debtor, amountCents) {
  if (debtor?.status !== 'open') return { ok: false, error: 'Só é possível registrar recebimento de devedor em aberto.' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'O valor deve ser maior que zero.' };
  const pending = debtorPendingCents(debtor);
  if (amountCents > pending) return { ok: false, error: 'O valor excede o saldo pendente do devedor.' };
  const receivedCents = (Number(debtor.receivedCents) || 0) + amountCents;
  return { ok: true, receivedCents, status: receivedCents >= debtor.lentCents ? 'paid' : 'open' };
}
