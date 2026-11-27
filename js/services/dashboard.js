/**
 * Serviço do Dashboard (VF-2-03f): carrega e agrega, sem gravar nada.
 * Leituras (orçamento de leitura, VF-4-03): contas + movimentos REALIZADOS (receitas received,
 * despesas paid, transferências confirmed, recebimentos de devedores e aportes de metas), cada um
 * limitado a READ_LIMIT; se algum atingir o teto, `truncated` lista as coleções e a UI avisa que o
 * saldo pode estar incompleto. Vencimentos usam os índices (status, data) já declarados.
 * Total por carga ≈ 5 + 3 + 3 + devedores + orçamentos consultas; documentos lidos ≤ ~5×READ_LIMIT + listas curtas.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import {
  summarizeDebtors, formatCents, cardInvoicesSummary, allocateLinkedGoalBalances,
  accountLabel, ACCOUNT_TYPES, cardLimitUsage, debtorPendingCents, summarizeSubscriptions, subscriptionMonthlyCents,
} from '../core/model.js';
import { loadDebtorStatements } from './debtors.js';
import { monthBounds, todayInAppZone, resolvePeriod } from '../utils/dates.js';
import { loadBalances, READ_LIMIT } from './balances.js';
import {
  periodResult,
  periodSeries,
  accountsOverview,
  cardsOverview,
  debtorsOverview,
  subscriptionsOverview,
  monthForecast,
  periodOverview,
  totalBalanceCents,
  upcomingDue,
} from '../core/aggregates.js';
import { getBudgetProgress } from './budgets.js';
import { loadMonthlyForecast } from './forecast.js';

export { READ_LIMIT };
const SHORT_LIMIT = 8;

/** Mês "YYYY-MM" e data "YYYY-MM-DD" de hoje no fuso America/Sao_Paulo (as datas gravadas são só-dia). */
export function todayParts(now = new Date()) {
  const iso = todayInAppZone(now);
  return { today: iso, month: iso.slice(0, 7) };
}

/** Fontes de dados do dashboard; `failed` lista as que falharam (isoladas: uma falha não derruba as demais). */
export const DASHBOARD_SOURCES = Object.freeze([
  'accounts', 'movements', 'pendingExpenses', 'subscriptions', 'invoices', 'debtors', 'budgets',
  'goals', 'monthPending', 'cardInvoices', 'debtorMonth', 'monthlyForecast',
]);

const ACCOUNT_TYPE_LABELS = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.value, t.label]));

/**
 * Retorna { period, totalBalanceCents, month, result, series, upcoming, budgets, debtors, truncated, accountCount, failed, ... }.
 * `io.period` = { mode: 'month'|'semester'|'year'|'all', month, year, semester } (padrão: `io.month`, ou o mês vigente).
 * O PERÍODO governa receitas × despesas (realizado e previsto pendente) e a série mensal. `month` (mês de referência =
 * mês escolhido no modo mês; senão o vigente) governa o que é mensal por natureza: orçamentos, faturas do mês,
 * previsão de caixa e a receber de devedores. Contas, cartões, devedores e assinaturas são a situação ATUAL.
 * Fonte que falha → campo `null` (saldo/resultado/orçamentos/devedores) ou ausente de `upcoming`, e a
 * fonte entra em `failed` (a UI mostra aviso explícito). Coleção vazia não é falha (zeros).
 */
export async function loadDashboard(uid, io = {}) {
  const fetchList = io.list ?? list;
  const { today, month: currentMonth } = todayParts(io.now ? io.now() : new Date());
  const period = resolvePeriod(io.period ?? { mode: 'month', month: io.month }, currentMonth);
  const month = period.month ?? currentMonth; // mês de referência (padrão: vigente)
  const bounds = monthBounds(month);
  const capped = (collection, extra = {}) => fetchList(uid, collection, { limit: READ_LIMIT, ...extra });
  const failed = [];
  const attempt = async (source, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[dashboard] falha na fonte "${source}"`, error);
      failed.push(source);
      return fallback;
    }
  };

  const [accounts, pendingExpenses, subscriptions, invoices, debtors, budgets, goals, monthPending, cardInvoices] = await Promise.all([
    attempt('accounts', () => fetchList(uid, COLLECTIONS.accounts, {}), null),
    attempt('pendingExpenses', () => fetchList(uid, COLLECTIONS.expenses, {
      where: [['status', '==', 'pending'], ['dueDate', '>=', today]], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }), []),
    attempt('subscriptions', () => capped(COLLECTIONS.subscriptions, {
      where: [['status', '==', 'active']], orderBy: ['nextChargeDate', 'asc'],
    }), null),
    attempt('invoices', () => fetchList(uid, COLLECTIONS.invoices, {
      where: [['status', '==', 'closed']], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }), []),
    attempt('debtors', () => capped(COLLECTIONS.debtors), null),
    attempt('budgets', () => getBudgetProgress(uid, month, { list: fetchList }), null),
    attempt('goals', () => capped(COLLECTIONS.goals), null),
    // Previsto do período: pendentes com data prevista no intervalo (índices status+data já declarados; "todo o período" = todos os pendentes).
    attempt('monthPending', async () => {
      const range = (field) => [['status', '==', 'pending'], ...(period.start ? [[field, '>=', period.start]] : []), ...(period.end ? [[field, '<=', period.end]] : [])];
      const [incomes, expenses] = await Promise.all([
        capped(COLLECTIONS.incomes, { where: range('expectedDate'), orderBy: ['expectedDate', 'asc'] }),
        capped(COLLECTIONS.expenses, { where: range('dueDate'), orderBy: ['dueDate', 'asc'] }),
      ]);
      return { incomes, expenses };
    }, null),
    // Faturas + compras + cartões: total do mês e limite utilizado (mesmas leituras servem aos dois).
    attempt('cardInvoices', async () => {
      const [cards, allInvoices, purchases] = await Promise.all([
        capped(COLLECTIONS.creditCards), capped(COLLECTIONS.invoices), capped(COLLECTIONS.cardPurchases),
      ]);
      return { cards, invoices: allInvoices, purchases, truncated: allInvoices.length >= READ_LIMIT || purchases.length >= READ_LIMIT };
    }, null),
  ]);

  // Saldo/resultado dependem das contas E dos movimentos realizados; sem um deles ficam indisponíveis (null).
  const loaded = accounts
    ? await attempt('movements', () => loadBalances(uid, accounts, { list: fetchList }), null)
    : null;

  // Saldo livre × vinculado a metas em conta (caixinha/investimento): mesma repartição da tela de Metas.
  const activeBalances = new Map();
  if (loaded) for (const a of accounts) if (a.status === 'active') activeBalances.set(a.id, loaded.balances.get(a.id) ?? 0);
  let linkedCents = null;
  if (loaded && goals) {
    const txCounts = new Map();
    for (const t of loaded.movements.goalTransactions) txCounts.set(t.goalId, (txCounts.get(t.goalId) ?? 0) + 1);
    linkedCents = [...allocateLinkedGoalBalances(goals, activeBalances, txCounts).values()].reduce((t, v) => t + v, 0);
  }
  const totalCents = loaded ? totalBalanceCents(accounts, loaded.balances) : null;
  const result = loaded ? periodResult(loaded.movements.incomes, loaded.movements.expenses, period.start, period.end) : null;
  const series = loaded ? periodSeries(loaded.movements.incomes, loaded.movements.expenses, period) : null;

  // A receber de devedores no mês (fechamento) — depende da lista de devedores.
  const debtorMonthById = new Map(); // devedor → a receber no mês (fechamento)
  const debtorMonth = debtors
    ? await attempt('debtorMonth', async () => {
      const map = await loadDebtorStatements(uid, debtors, month, { list: fetchList });
      for (const [id, st] of map) debtorMonthById.set(id, st.totalCents);
      return [...map.values()].reduce((t, st) => t + st.totalCents, 0);
    }, null)
    : null;

  // Previsão mensal: reaproveita saldo, cartões/faturas/compras e devedores já lidos; lê só o que falta.
  const monthlyForecastData = loaded && cardInvoices
    ? await attempt('monthlyForecast', () => loadMonthlyForecast(uid, {
      month, today, balanceCents: totalCents, cards: cardInvoices.cards, invoices: cardInvoices.invoices, purchases: cardInvoices.purchases,
      debtorsReceivableCents: debtorMonth ?? 0, includeDebtors: Boolean(io.includeDebtors),
    }, { list: fetchList }), null)
    : null;

  const cardsView = cardInvoices
    ? cardsOverview({ cards: cardInvoices.cards, invoices: cardInvoices.invoices, purchases: cardInvoices.purchases, today, usedFn: cardLimitUsage })
    : null;
  const debtorsSummary = debtors ? summarizeDebtors(debtors) : null;
  // Posição líquida (curto prazo) = saldo das contas + a receber de devedores NO MÊS − faturas de cartão a pagar.
  // O total em aberto dos devedores (sem prazo) não entra no número principal: vai à parte em `netPositionWithAllDebtorsCents`.
  const hasSources = totalCents !== null && cardsView;
  const netPositionCents = hasSources && debtorMonth !== null ? totalCents + debtorMonth - cardsView.dueCents : null;
  const netPositionWithAllDebtorsCents = hasSources && debtorsSummary ? totalCents + debtorsSummary.pendingCents - cardsView.dueCents : null;

  return {
    period,
    series,
    accounts: loaded ? accountsOverview(accounts, loaded.balances, accountLabel, ACCOUNT_TYPE_LABELS) : null,
    cardsView,
    debtorsList: debtors
      ? debtorsOverview(debtors, debtorPendingCents).map((d) => ({ ...d, monthDueCents: debtorMonth === null ? null : (debtorMonthById.get(d.id) ?? 0) }))
      : null,
    subscriptionsList: subscriptions ? subscriptionsOverview(subscriptions, subscriptionMonthlyCents) : null,
    subscriptionsSummary: subscriptions ? summarizeSubscriptions(subscriptions) : null,
    netPositionCents,
    netPositionWithAllDebtorsCents,
    month,
    isCurrentMonth: month === currentMonth,
    accountCount: accounts ? accounts.filter((a) => a.status === 'active').length : null,
    totalBalanceCents: totalCents,
    linkedGoalsCents: linkedCents,
    freeBalanceCents: totalCents !== null && linkedCents !== null ? totalCents - linkedCents : null,
    result,
    monthlyForecast: monthlyForecastData,
    overview: result && monthPending ? periodOverview(result, monthPending.incomes, monthPending.expenses) : null,
    forecast: result && monthPending ? monthForecast(result, monthPending.incomes, monthPending.expenses) : null,
    cardInvoices: cardInvoices ? cardInvoicesSummary({ ...cardInvoices, month }) : null,
    upcoming: upcomingDue({ expenses: pendingExpenses, subscriptions: subscriptions ?? [], invoices, today }),
    budgets: budgets ? budgets.summary : null,
    debtors: debtors ? { ...summarizeDebtors(debtors), monthDueCents: debtorMonth } : null,
    truncated: [...(loaded?.truncated ?? []), ...(budgets?.truncated ? ['budgetExpenses'] : []), ...(cardInvoices?.truncated ? ['cardInvoices'] : []), ...(monthlyForecastData?.truncated ?? [])],
    failed,
  };
}

export { formatCents };
