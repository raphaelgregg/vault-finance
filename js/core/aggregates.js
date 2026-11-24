/**
 * Agregações puras (sem DOM, sem rede) para orçamentos, dashboard e relatórios
 * (VF-2-03e/f/g). Dinheiro SEMPRE em centavos inteiros; nada aqui é gravado — todo
 * valor é derivado dos documentos recebidos.
 * Convenção: "realizado" = receita `received` (por receivedDate) e despesa `paid` (por paidDate).
 */
import { monthsBetween } from '../utils/dates.js';

const cents = (value) => (Number.isInteger(value) ? value : Number(value) || 0);
const monthOf = (isoDate) => (typeof isoDate === 'string' ? isoDate.slice(0, 7) : null);

// ---------------------------------------------------------------------------
// Orçamentos
// ---------------------------------------------------------------------------

/** Gasto de uma categoria no mês: despesas não canceladas com vencimento (`dueDate`) no mês. */
export function budgetSpentCents(expenses = [], categoryId, month) {
  return expenses.reduce((total, e) => (
    e?.categoryId === categoryId && e.status !== 'cancelled' && monthOf(e.dueDate) === month
      ? total + cents(e.amountCents)
      : total
  ), 0);
}

export const BUDGET_WARNING_PERCENT = 80;

/**
 * Progresso do orçamento. `percent` NÃO é limitado a 100 (mostra estouro); `state`:
 * ok (< 80%), warning (80%–100% do limite) e over (gasto > limite).
 */
export function budgetProgress(budget, spentCents) {
  const limit = cents(budget?.limitCents);
  const spent = cents(spentCents);
  const percent = limit > 0 ? Math.floor((spent * 100) / limit) : 0;
  const state = spent > limit ? 'over' : percent >= BUDGET_WARNING_PERCENT ? 'warning' : 'ok';
  return { limitCents: limit, spentCents: spent, remainingCents: limit - spent, percent, state };
}

/** Linhas { ...budget, ...progress } do mês, ordenadas do maior consumo para o menor. */
export function budgetRows(budgets = [], expenses = [], month) {
  return budgets
    .filter((b) => b.month === month)
    .map((b) => ({ ...b, ...budgetProgress(b, budgetSpentCents(expenses, b.categoryId, month)) }))
    .sort((a, b) => b.percent - a.percent);
}

export function summarizeBudgetRows(rows = []) {
  return rows.reduce((acc, r) => ({
    limitCents: acc.limitCents + r.limitCents,
    spentCents: acc.spentCents + r.spentCents,
    overCount: acc.overCount + (r.state === 'over' ? 1 : 0),
    warningCount: acc.warningCount + (r.state === 'warning' ? 1 : 0),
  }), { limitCents: 0, spentCents: 0, overCount: 0, warningCount: 0 });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Receitas recebidas (receivedDate) e despesas pagas (paidDate) no mês. */
export function monthResult(incomes = [], expenses = [], month) {
  const incomeCents = incomes.reduce((t, i) => (
    i?.status === 'received' && monthOf(i.receivedDate) === month ? t + cents(i.amountCents) : t), 0);
  const expenseCents = expenses.reduce((t, e) => (
    e?.status === 'paid' && monthOf(e.paidDate) === month ? t + cents(e.amountCents) : t), 0);
  return { incomeCents, expenseCents, resultCents: incomeCents - expenseCents };
}

/** Saldo total das contas ATIVAS a partir do Map de `accountBalances`. */
export function totalBalanceCents(accounts = [], balances = new Map()) {
  return accounts.reduce((t, a) => (a?.status === 'active' ? t + (balances.get(a.id) ?? 0) : t), 0);
}

/**
 * Próximos vencimentos a partir de `today` (inclusive), por data crescente.
 * Fontes: despesas pendentes, assinaturas ativas e faturas fechadas (com total).
 * Retorna [{ kind, id, label, date, amountCents }].
 */
export function upcomingDue({ expenses = [], subscriptions = [], invoices = [], today, limit = 8 } = {}) {
  const items = [];
  for (const e of expenses) {
    if (e?.status === 'pending' && e.dueDate >= today) {
      items.push({ kind: 'expense', id: e.id, label: e.description, date: e.dueDate, amountCents: cents(e.amountCents) });
    }
  }
  // Assinatura cobrada no cartão já está dentro da fatura (VF-2-03r): listá-la também duplicaria o vencimento.
  for (const s of subscriptions) {
    if (s?.cardId || !s?.accountId) continue; // sem conta (só devedor/acompanhamento) não vence na SUA conta
    if (s?.status === 'active' && s.nextChargeDate >= today) {
      items.push({ kind: 'subscription', id: s.id, label: s.name, date: s.nextChargeDate, amountCents: cents(s.amountCents) });
    }
  }
  for (const i of invoices) {
    if (i?.status === 'closed' && i.dueDate >= today) {
      items.push({ kind: 'invoice', id: i.id, label: `Fatura ${i.referenceMonth}`, date: i.dueDate, amountCents: cents(i.totalCents) });
    }
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------

/**
 * Total por categoria dos itens REALIZADOS no período [fromMonth, toMonth].
 * `kind`: 'expense' (status paid, paidDate) | 'income' (status received, receivedDate).
 * Retorna [{ categoryId, totalCents, count, sharePercent }] por total decrescente;
 * `sharePercent` truncado, sobre o total do período.
 */
export function totalsByCategory(items = [], kind, fromMonth, toMonth) {
  const [status, dateField] = kind === 'income' ? ['received', 'receivedDate'] : ['paid', 'paidDate'];
  const map = new Map();
  let grand = 0;
  for (const item of items) {
    const month = monthOf(item?.[dateField]);
    if (item?.status !== status || !month || month < fromMonth || month > toMonth) continue;
    const row = map.get(item.categoryId) ?? { categoryId: item.categoryId, totalCents: 0, count: 0 };
    row.totalCents += cents(item.amountCents);
    row.count += 1;
    grand += cents(item.amountCents);
    map.set(item.categoryId, row);
  }
  return [...map.values()]
    .sort((a, b) => b.totalCents - a.totalCents || String(a.categoryId).localeCompare(String(b.categoryId)))
    .map((r) => ({ ...r, sharePercent: grand > 0 ? Math.floor((r.totalCents * 100) / grand) : 0 }));
}

/** Série mensal realizada: [{ month, incomeCents, expenseCents, resultCents }] de from a to. */
export function monthlySeries(incomes = [], expenses = [], fromMonth, toMonth) {
  return monthsBetween(fromMonth, toMonth).map((month) => ({ month, ...monthResult(incomes, expenses, month) }));
}

export function sumSeries(series = []) {
  return series.reduce((t, r) => ({
    incomeCents: t.incomeCents + r.incomeCents,
    expenseCents: t.expenseCents + r.expenseCents,
    resultCents: t.resultCents + r.resultCents,
  }), { incomeCents: 0, expenseCents: 0, resultCents: 0 });
}

/**
 * CSV (RFC 4180, separador `;` e CRLF, abre direto no Excel pt-BR) de linhas já formatadas.
 * `columns`: [{ key, label }]. Defesa contra injeção de fórmula: texto iniciado por = + - @ ou
 * tab/CR ganha apóstrofo; números simples (inclusive negativos como "-1,00") não são alterados.
 */
export function toCsv(rows = [], columns = []) {
  const escape = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    const plainNumber = /^-?\d+([.,]\d+)?$/.test(text);
    if (typeof value === 'string' && !plainNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((c) => escape(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c.key])).join(';'));
  return lines.join('\r\n');
}

/**
 * Previsto do mês (VF-2-03q) — puro. `pendingIncomes`/`pendingExpenses`: lançamentos PENDENTES com data prevista
 * dentro do mês (o chamador consulta por intervalo); o realizado vem de `monthResult` (recebidas/pagas no mês).
 * Sem dupla contagem: pendente e realizado são status excludentes do mesmo lançamento.
 * Retorna { incomeCents, expenseCents } do pendente e { forecastResultCents } = realizado + pendente.
 */
export function monthForecast(result = { incomeCents: 0, expenseCents: 0 }, pendingIncomes = [], pendingExpenses = []) {
  const sum = (rows, status) => rows.reduce((t, r) => (r?.status === status ? t + cents(r.amountCents) : t), 0);
  const incomeCents = sum(pendingIncomes, 'pending');
  const expenseCents = sum(pendingExpenses, 'pending');
  return {
    incomeCents,
    expenseCents,
    forecastResultCents: (result.incomeCents + incomeCents) - (result.expenseCents + expenseCents),
  };
}
