/** Agregações puras (VF-2-03e/f/g): orçamentos, dashboard e relatórios. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetSpentCents, budgetProgress, budgetRows, summarizeBudgetRows,
  monthResult, totalBalanceCents, upcomingDue, totalsByCategory, monthlySeries, sumSeries, toCsv,
  periodResult, periodSeries, accountsOverview, cardsOverview, debtorsOverview, subscriptionsOverview,
} from '../../js/core/aggregates.js';
import { monthBounds, monthsBetween, resolvePeriod } from '../../js/utils/dates.js';
import { validateEntity } from '../../js/core/model.js';

const exp = (o = {}) => ({ categoryId: 'c1', status: 'paid', amountCents: 1000, dueDate: '2026-11-10', paidDate: '2026-11-10', ...o });
const inc = (o = {}) => ({ categoryId: 'i1', status: 'received', amountCents: 5000, receivedDate: '2026-11-05', ...o });

describe('dates — monthBounds/monthsBetween', () => {
  it('limites do mês incluindo bissexto e dezembro', () => {
    assert.deepEqual(monthBounds('2026-11'), { start: '2026-11-01', end: '2026-11-30' });
    assert.deepEqual(monthBounds('2028-02'), { start: '2028-02-01', end: '2028-02-29' });
    assert.deepEqual(monthBounds('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
    assert.equal(monthBounds('2026-13'), null);
    assert.equal(monthBounds(undefined), null);
  });
  it('intervalo de meses, virada de ano, invertido e inválido', () => {
    assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.deepEqual(monthsBetween('2026-11', '2026-11'), ['2026-11']);
    assert.deepEqual(monthsBetween('2026-12', '2026-11'), []);
    assert.deepEqual(monthsBetween('x', '2026-11'), []);
  });
});

describe('orçamentos', () => {
  it('gasto: só a categoria/mês, ignora canceladas; pendentes contam', () => {
    const items = [exp(), exp({ amountCents: 500, status: 'pending' }), exp({ status: 'cancelled' }),
      exp({ categoryId: 'c2' }), exp({ dueDate: '2026-12-01' })];
    assert.equal(budgetSpentCents(items, 'c1', '2026-11'), 1500);
  });
  it('progresso: ok / warning (≥80%) / over (>limite), percent sem teto, restante negativo', () => {
    assert.deepEqual(budgetProgress({ limitCents: 1000 }, 799), { limitCents: 1000, spentCents: 799, remainingCents: 201, percent: 79, state: 'ok' });
    assert.equal(budgetProgress({ limitCents: 1000 }, 800).state, 'warning');
    assert.equal(budgetProgress({ limitCents: 1000 }, 1000).state, 'warning');
    const over = budgetProgress({ limitCents: 1000 }, 1500);
    assert.deepEqual([over.state, over.percent, over.remainingCents], ['over', 150, -500]);
    assert.equal(budgetProgress({ limitCents: 0 }, 10).percent, 0);
  });
  it('linhas do mês ordenadas por consumo e resumo', () => {
    const budgets = [{ id: 'a', categoryId: 'c1', month: '2026-11', limitCents: 1000 }, { id: 'b', categoryId: 'c2', month: '2026-11', limitCents: 1000 },
      { id: 'z', categoryId: 'c1', month: '2026-10', limitCents: 1 }];
    const rows = budgetRows(budgets, [exp({ amountCents: 900 }), exp({ categoryId: 'c2', amountCents: 1200 })], '2026-11');
    assert.deepEqual(rows.map((r) => r.id), ['b', 'a']);
    assert.deepEqual(summarizeBudgetRows(rows), { limitCents: 2000, spentCents: 2100, overCount: 1, warningCount: 1 });
  });
  it('schema de budgets espelha as Rules', () => {
    const b = { categoryId: 'c', month: '2026-11', limitCents: 100 };
    assert.equal(validateEntity('budgets', b).ok, true);
    assert.ok(validateEntity('budgets', { ...b, limitCents: 0 }).errors.limitCents);
    assert.ok(validateEntity('budgets', { ...b, month: '2026-1' }).errors.month);
    assert.ok(validateEntity('budgets', { ...b, extra: 1 }).errors.extra);
  });
});

describe('dashboard', () => {
  it('monthResult: recebidas/pagas por data de realização no mês', () => {
    const r = monthResult([inc(), inc({ status: 'pending' }), inc({ receivedDate: '2026-10-31' })],
      [exp(), exp({ status: 'pending' }), exp({ paidDate: '2026-12-01' })], '2026-11');
    assert.deepEqual(r, { incomeCents: 5000, expenseCents: 1000, resultCents: 4000 });
  });
  it('totalBalanceCents só soma contas ativas', () => {
    const accounts = [{ id: 'a', status: 'active' }, { id: 'b', status: 'archived' }, { id: 'c', status: 'active' }];
    assert.equal(totalBalanceCents(accounts, new Map([['a', 100], ['b', 999], ['c', -30]])), 70);
  });
  it('upcomingDue: mistura fontes, filtra status/data, ordena e limita', () => {
    const r = upcomingDue({
      today: '2026-11-19', limit: 3,
      expenses: [{ id: 'e1', status: 'pending', dueDate: '2026-11-25', description: 'Luz', amountCents: 100 }, { id: 'e2', status: 'pending', dueDate: '2026-11-01', description: 'Velha', amountCents: 1 }, { id: 'e3', status: 'paid', dueDate: '2026-11-20', description: 'Paga', amountCents: 1 }],
      subscriptions: [{ id: 's1', status: 'active', nextChargeDate: '2026-11-19', name: 'Netflix', amountCents: 50, accountId: 'a1' }, { id: 's2', status: 'paused', nextChargeDate: '2026-11-20', name: 'X', amountCents: 1 }],
      invoices: [{ id: 'i1', status: 'closed', dueDate: '2026-11-22', referenceMonth: '2026-11', totalCents: 900 }, { id: 'i2', status: 'open', dueDate: '2026-11-21', referenceMonth: '2026-11' }],
    });
    assert.deepEqual(r.map((x) => `${x.kind}:${x.id}`), ['subscription:s1', 'invoice:i1', 'expense:e1']);
    assert.equal(r[1].amountCents, 900);
  });
});

describe('relatórios', () => {
  it('totalsByCategory: realizados no período, ordenado, participação truncada', () => {
    const items = [exp({ categoryId: 'a', amountCents: 300 }), exp({ categoryId: 'b', amountCents: 700 }), exp({ categoryId: 'a', amountCents: 100 }),
      exp({ status: 'pending' }), exp({ paidDate: '2027-01-01' })];
    const r = totalsByCategory(items, 'expense', '2026-11', '2026-12');
    assert.deepEqual(r.map((x) => [x.categoryId, x.totalCents, x.count, x.sharePercent]), [['b', 700, 1, 63], ['a', 400, 2, 36]]);
    assert.deepEqual(totalsByCategory([inc()], 'income', '2026-11', '2026-11').map((x) => x.totalCents), [5000]);
    assert.deepEqual(totalsByCategory([], 'expense', '2026-11', '2026-11'), []);
  });
  it('monthlySeries cobre meses sem movimento e sumSeries bate com a soma', () => {
    const s = monthlySeries([inc(), inc({ receivedDate: '2026-12-02', amountCents: 200 })], [exp()], '2026-11', '2027-01');
    assert.deepEqual(s.map((x) => x.month), ['2026-11', '2026-12', '2027-01']);
    assert.deepEqual(s[2], { month: '2027-01', incomeCents: 0, expenseCents: 0, resultCents: 0 });
    assert.deepEqual(sumSeries(s), { incomeCents: 5200, expenseCents: 1000, resultCents: 4200 });
  });
  it('toCsv: separador ;, CRLF, aspas e proteção contra injeção de fórmula', () => {
    const csv = toCsv([{ a: 'x;y', b: '=1+1' }, { a: 'diz "oi"', b: 12 }, { a: '-cmd', b: null }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
    assert.equal(csv, 'A;B\r\n"x;y";\'=1+1\r\n"diz ""oi""";12\r\n\'-cmd;');
  });
});

describe('upcomingDue — assinaturas sem conta (VF-COR-07)', () => {
  it('assinatura sem conta (só devedor/acompanhamento) não aparece em "próximos vencimentos": não vence na SUA conta', () => {
    const up = upcomingDue({ today: '2026-11-19', subscriptions: [
      { id: 'a', name: 'Com conta', status: 'active', nextChargeDate: '2026-11-20', amountCents: 1000, accountId: 'a1' },
      { id: 'b', name: 'Só devedor', status: 'active', nextChargeDate: '2026-11-21', amountCents: 2000, debtorId: 'dv' },
      { id: 'c', name: 'Sem vínculo', status: 'active', nextChargeDate: '2026-11-22', amountCents: 3000 },
    ] });
    assert.deepEqual(up.map((i) => i.label), ['Com conta']);
  });
});

describe('dashboard por período e visões de situação', () => {
  const incomes = [inc({ receivedDate: '2026-01-10', amountCents: 1000 }), inc({ receivedDate: '2026-08-10', amountCents: 5000 }), inc({ status: 'pending', receivedDate: '2026-08-11', amountCents: 9999 })];
  const expenses = [exp({ paidDate: '2026-01-20', amountCents: 300 }), exp({ paidDate: '2026-08-02', amountCents: 700 }), exp({ paidDate: '2025-12-31', amountCents: 50 })];

  it('periodResult respeita limites inclusivos e "todo o período" (sem limite)', () => {
    assert.deepEqual(periodResult(incomes, expenses, '2026-07-01', '2026-12-31'), { incomeCents: 5000, expenseCents: 700, resultCents: 4300 });
    assert.deepEqual(periodResult(incomes, expenses, '2026-01-01', '2026-12-31'), { incomeCents: 6000, expenseCents: 1000, resultCents: 5000 });
    assert.deepEqual(periodResult(incomes, expenses, null, null), { incomeCents: 6000, expenseCents: 1050, resultCents: 4950 });
  });

  it('periodSeries: semestre fixo e todo o período pelo primeiro/último movimento', () => {
    const sem = periodSeries(incomes, expenses, resolvePeriod({ mode: 'semester', year: 2026, semester: 2 }, '2026-11'));
    assert.equal(sem.length, 6);
    assert.equal(sem[1].incomeCents, 5000); // 2026-08
    const all = periodSeries(incomes, expenses, resolvePeriod({ mode: 'all' }, '2026-11'));
    assert.equal(all[0].month, '2025-12');
    assert.equal(all.at(-1).month, '2026-08');
    assert.equal(sumSeries(all).resultCents, 4950);
    assert.deepEqual(periodSeries([], [], resolvePeriod({ mode: 'all' }, '2026-11')), []);
  });

  it('resolvePeriod: mês, semestre, ano e fallback', () => {
    assert.equal(resolvePeriod({ mode: 'year', year: 2025 }, '2026-11').end, '2025-12-31');
    assert.equal(resolvePeriod({ mode: 'semester', year: 2026, semester: 1 }, '2026-11').label, '1º semestre de 2026');
    assert.equal(resolvePeriod({ mode: 'month', month: 'lixo' }, '2026-11').month, '2026-11');
    assert.equal(resolvePeriod({ mode: 'xyz' }, '2026-11').mode, 'month');
  });

  it('accountsOverview: só ativas, maior saldo primeiro', () => {
    const rows = accountsOverview(
      [{ id: 'a', status: 'active', name: 'A', type: 'checking' }, { id: 'b', status: 'active', name: 'B', type: 'savings' }, { id: 'c', status: 'archived', name: 'C' }],
      new Map([['a', 100], ['b', 900], ['c', 5]]), (a) => a.name, { savings: 'Poupança' },
    );
    assert.deepEqual(rows.map((r) => [r.id, r.balanceCents, r.typeLabel]), [['b', 900, 'Poupança'], ['a', 100, '']]);
  });

  it('cardsOverview: usado, fatura a pagar (aberta soma parcelas, fechada usa total), vencida e total', () => {
    const cards = [{ id: 'k1', name: 'Roxo', status: 'active', limitCents: 10000 }, { id: 'k2', name: 'Velho', status: 'inactive', limitCents: 1 }];
    const invoices = [
      { id: 'i1', cardId: 'k1', status: 'open', dueDate: '2026-12-10' },
      { id: 'i2', cardId: 'k1', status: 'closed', totalCents: 2000, dueDate: '2026-11-10' },
      { id: 'i3', cardId: 'k1', status: 'paid', totalCents: 999, dueDate: '2026-10-10' },
    ];
    const purchases = [{ cardId: 'k1', invoiceId: 'i1', amountCents: 3000 }, { cardId: 'k1', invoiceId: 'i2', amountCents: 2000 }, { cardId: 'k1', invoiceId: 'i3', amountCents: 999 }];
    const usedFn = (card, ps, is) => {
      const settled = new Set(is.filter((i) => i.status === 'paid').map((i) => i.id));
      const usedCents = ps.reduce((t, p) => (settled.has(p.invoiceId) ? t : t + p.amountCents), 0);
      return { usedCents, availableCents: card.limitCents - usedCents };
    };
    const { rows, dueCents } = cardsOverview({ cards, invoices, purchases, today: '2026-11-24', usedFn });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].usedCents, rows[0].usedPercent, rows[0].dueCents, rows[0].nextDueDate, rows[0].overdue], [5000, 50, 5000, '2026-11-10', true]);
    assert.equal(dueCents, 5000);
  });

  it('debtorsOverview e subscriptionsOverview', () => {
    const pending = (d) => d.lentCents - d.receivedCents;
    const d = debtorsOverview([
      { id: '1', name: 'Ana', status: 'open', lentCents: 1000, receivedCents: 400 },
      { id: '2', name: 'Bia', status: 'open', lentCents: 5000, receivedCents: 0 },
      { id: '3', name: 'Caio', status: 'paid', lentCents: 100, receivedCents: 100 },
      { id: '4', name: 'Duda', status: 'open', lentCents: 100, receivedCents: 100 },
    ], pending);
    assert.deepEqual(d.map((x) => [x.name, x.pendingCents]), [['Bia', 5000], ['Ana', 600]]);
    const s = subscriptionsOverview([
      { id: 'a', name: 'B', status: 'active', amountCents: 100, periodicity: 'monthly', nextChargeDate: '2026-12-05', cardId: 'k' },
      { id: 'b', name: 'A', status: 'active', amountCents: 200, periodicity: 'yearly', nextChargeDate: '2026-11-30' },
      { id: 'c', name: 'C', status: 'paused', amountCents: 1, periodicity: 'monthly', nextChargeDate: '2026-11-01' },
    ], (amount) => amount);
    assert.deepEqual(s.map((x) => [x.id, x.viaCard]), [['b', false], ['a', true]]);
  });
});

describe('upcomingDue — rótulo de fatura em formato brasileiro', () => {
  it('mostra "Fatura MM/AAAA", nunca AAAA-MM', () => {
    const up = upcomingDue({ today: '2026-11-19', invoices: [{ id: 'i1', status: 'closed', referenceMonth: '2026-11', dueDate: '2026-11-25', totalCents: 1000 }] });
    assert.equal(up[0].label, 'Fatura 11/2026');
  });
});
