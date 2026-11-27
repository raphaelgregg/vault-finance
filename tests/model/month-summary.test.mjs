import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMovements, periodOverview, periodResult } from '../../js/core/aggregates.js';
import { monthChoices } from '../../js/components/month-summary.js';

test('summarizeMovements: liquidado + pendente = previsto; cancelada fora dos totais', () => {
  const items = [
    { status: 'received', amountCents: 1000 },
    { status: 'pending', amountCents: 500, expectedDate: '2026-11-10' },
    { status: 'pending', amountCents: 200, expectedDate: '2026-11-28' },
    { status: 'cancelled', amountCents: 9999 },
  ];
  const s = summarizeMovements(items, { settledStatus: 'received', dateField: 'expectedDate', today: '2026-11-27' });
  assert.deepEqual(s, { count: 3, cancelledCount: 1, settledCents: 1000, pendingCents: 700, overdueCents: 500, totalCents: 1700 });
});

test('summarizeMovements: despesas usam "paid" e ignoram recebidas', () => {
  const s = summarizeMovements([{ status: 'paid', amountCents: 300 }, { status: 'received', amountCents: 50 }], { settledStatus: 'paid', dateField: 'dueDate' });
  assert.equal(s.settledCents, 300);
  assert.equal(s.totalCents, 300);
});

test('summarizeMovements: vazio e itens nulos', () => {
  assert.equal(summarizeMovements([null], { settledStatus: 'paid' }).count, 0);
  assert.equal(summarizeMovements(undefined, { settledStatus: 'paid' }).totalCents, 0);
});

test('periodOverview: mês sem realizado mostra só o pendente (caso do mês futuro)', () => {
  const result = periodResult([], [], '2026-12-01', '2026-12-31');
  const ov = periodOverview(result, [{ status: 'pending', amountCents: 1000 }], [{ status: 'pending', amountCents: 400 }]);
  assert.equal(ov.realizedResultCents, 0);
  assert.equal(ov.income.totalCents, 1000);
  assert.equal(ov.expense.totalCents, 400);
  assert.equal(ov.forecastResultCents, 600);
});

test('periodOverview: realizado + pendente, sem dupla contagem', () => {
  const ov = periodOverview({ incomeCents: 800, expenseCents: 300 }, [{ status: 'pending', amountCents: 200 }], [{ status: 'pending', amountCents: 100 }]);
  assert.equal(ov.income.totalCents, 1000);
  assert.equal(ov.expense.totalCents, 400);
  assert.equal(ov.realizedResultCents, 500);
  assert.equal(ov.forecastResultCents, 600);
});

test('monthChoices: inclui mês atual, próximos 6, carregados e selecionado, mais recente primeiro', () => {
  const m = monthChoices(new Set(['2026-05', '', 'x']), { current: '2026-11', selected: '2027-09' });
  assert.equal(m[0], '2027-09');
  assert.ok(m.includes('2027-05') && m.includes('2026-12') && m.includes('2026-11') && m.includes('2026-05'));
  assert.equal(m.includes('x'), false);
  assert.deepEqual([...m].sort().reverse(), m);
});
