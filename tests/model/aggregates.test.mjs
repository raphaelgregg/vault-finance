/** Agregações puras (VF-2-03e/f/g): orçamentos, dashboard e relatórios. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetSpentCents, budgetProgress, budgetRows, summarizeBudgetRows,
  monthResult, totalBalanceCents, upcomingDue, totalsByCategory, monthlySeries, sumSeries, toCsv,
} from '../../js/core/aggregates.js';
import { monthBounds, monthsBetween } from '../../js/utils/dates.js';
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
