/** Serviços de Orçamentos, Dashboard e Relatórios (VF-2-03e/f/g) com io injetado. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, updateBudgetLimit, deleteBudget, getBudgetProgress, EXPENSE_READ_LIMIT } from '../../js/services/budgets.js';
import { loadDashboard, todayParts, READ_LIMIT } from '../../js/services/dashboard.js';
import { loadReport, validatePeriod, seriesToCsv, categoriesToCsv, MAX_REPORT_MONTHS } from '../../js/services/reports.js';
import { toWhereValue } from '../../js/services/firestore.js';

const uid = 'u1';
const raw = (o = {}) => ({ categoryId: 'c1', month: '2026-11', limitCents: '500,00', ...o });

function makeIo({ categories = [{ id: 'c1', kind: 'expense' }], budgets = [], tables = {} } = {}) {
  const calls = { create: [], update: [], remove: [], audit: [], lists: [] };
  const io = {
    getById: async (u, c, id) => ({ categories, budgets }[c] ?? []).find((x) => x.id === id) ?? null,
    list: async (u, c, opts = {}) => {
      calls.lists.push({ c, opts });
      if (tables[c]) return tables[c];
      if (c === 'budgets') {
        const filters = opts.where ?? [];
        return budgets.filter((b) => filters.every(([f, , v]) => b[f] === v));
      }
      return [];
    },
    create: async (u, c, data) => { calls.create.push({ c, data }); return 'b-new'; },
    update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ c, id }); },
    writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
  };
  return { io, calls };
}

describe('filtros de data nas consultas', () => {
  it('toWhereValue converte só campos de data com ISO válido', () => {
    assert.equal(toWhereValue('dueDate', '2026-11-01').toDate().toISOString(), '2026-11-01T12:00:00.000Z');
    assert.equal(toWhereValue('status', '2026-11-01'), '2026-11-01');
    assert.equal(toWhereValue('dueDate', 5), 5);
    assert.throws(() => toWhereValue('dueDate', '2026-13-01'), RangeError);
  });
});

describe('budgets service', () => {
  it('cria e audita; normaliza limite para centavos', async () => {
    const { io, calls } = makeIo();
    assert.deepEqual(await createBudget(uid, raw(), io), { ok: true, id: 'b-new' });
    assert.deepEqual(calls.create[0].data, { categoryId: 'c1', month: '2026-11', limitCents: 50000 });
    assert.equal(calls.audit[0].action, 'create');
  });
  it('rejeita categoria inexistente/de receita, duplicata e dados inválidos', async () => {
    assert.ok((await createBudget(uid, raw({ categoryId: 'zz' }), makeIo().io)).errors.categoryId);
    assert.ok((await createBudget(uid, raw(), makeIo({ categories: [{ id: 'c1', kind: 'income' }] }).io)).errors.categoryId);
    const dup = makeIo({ budgets: [{ id: 'x', categoryId: 'c1', month: '2026-11', limitCents: 1 }] });
    assert.match((await createBudget(uid, raw(), dup.io)).errors.categoryId, /Já existe/);
    assert.equal(dup.calls.create.length, 0);
    assert.ok((await createBudget(uid, raw({ limitCents: '0' }), makeIo().io)).errors.limitCents);
    assert.ok((await createBudget(uid, raw({ month: '2026-1' }), makeIo().io)).errors.month);
  });
  it('edita só o limite (patch) e exclui com auditoria', async () => {
    const { io, calls } = makeIo({ budgets: [{ id: 'b1', categoryId: 'c1', month: '2026-11', limitCents: 100 }] });
    assert.equal((await updateBudgetLimit(uid, 'b1', '750,00', io)).ok, true);
    assert.deepEqual(calls.update[0], { c: 'budgets', id: 'b1', data: { limitCents: 75000 } });
    assert.ok((await updateBudgetLimit(uid, 'b1', '0', io)).errors.limitCents);
    assert.equal((await updateBudgetLimit(uid, 'zz', '1', io)).ok, false);
    assert.equal((await deleteBudget(uid, 'b1', io)).ok, true);
    assert.equal(calls.audit.at(-1).action, 'delete');
    assert.equal((await deleteBudget(uid, 'zz', io)).ok, false);
  });
  it('getBudgetProgress: consulta intervalo do mês com limite e deriva gasto', async () => {
    const expenses = [{ categoryId: 'c1', status: 'paid', amountCents: 40000, dueDate: '2026-11-10' }, { categoryId: 'c1', status: 'cancelled', amountCents: 9, dueDate: '2026-11-11' }];
    const { io, calls } = makeIo({ budgets: [{ id: 'b1', categoryId: 'c1', month: '2026-11', limitCents: 50000 }], tables: { expenses } });
    const r = await getBudgetProgress(uid, '2026-11', io);
    assert.equal(r.rows[0].spentCents, 40000);
    assert.equal(r.rows[0].state, 'warning');
    assert.equal(r.truncated, false);
    const q = calls.lists.find((l) => l.c === 'expenses').opts;
    assert.deepEqual(q.where, [['dueDate', '>=', '2026-11-01'], ['dueDate', '<=', '2026-11-30']]);
    assert.equal(q.limit, EXPENSE_READ_LIMIT);
  });
  it('getBudgetProgress sinaliza truncamento e trata mês inválido', async () => {
    const many = Array.from({ length: EXPENSE_READ_LIMIT }, () => ({ categoryId: 'z', status: 'paid', amountCents: 1, dueDate: '2026-11-10' }));
    assert.equal((await getBudgetProgress(uid, '2026-11', makeIo({ tables: { expenses: many } }).io)).truncated, true);
    assert.deepEqual((await getBudgetProgress(uid, 'x', makeIo().io)).rows, []);
  });
});

describe('dashboard service', () => {
  it('todayParts usa UTC', () => {
    assert.deepEqual(todayParts(new Date('2026-11-19T23:30:00Z')), { today: '2026-11-19', month: '2026-11' });
  });
  it('agrega saldo (incl. recebimentos e metas), resultado do mês, vencimentos, devedores e orçamentos', async () => {
    const tables = {
      accounts: [{ id: 'a1', status: 'active', initialBalanceCents: 100000 }],
      incomes: [{ accountId: 'a1', status: 'received', amountCents: 50000, receivedDate: '2026-11-05' }],
      expenses: [{ accountId: 'a1', categoryId: 'c1', status: 'paid', amountCents: 20000, paidDate: '2026-11-06', dueDate: '2026-11-06' }],
      transfers: [],
      debtPayments: [{ accountId: 'a1', amountCents: 3000 }],
      goalTransactions: [{ accountId: 'a1', type: 'deposit', amountCents: 10000 }],
      subscriptions: [{ id: 's', status: 'active', nextChargeDate: '2026-11-25', name: 'Spotify', amountCents: 2000, accountId: 'a1' }],
      debtors: [{ status: 'open', lentCents: 10000, receivedCents: 3000 }],
    };
    const { io } = makeIo({ tables });
    io.now = () => new Date('2026-11-19T12:00:00Z');
    const d = await loadDashboard(uid, io);
    assert.equal(d.totalBalanceCents, 100000 + 50000 - 20000 + 3000 - 10000);
    assert.deepEqual(d.result, { incomeCents: 50000, expenseCents: 20000, resultCents: 30000 });
    assert.deepEqual(d.upcoming.map((u) => u.label), ['Spotify']);
    assert.equal(d.debtors.pendingCents, 7000);
    assert.equal(d.accountCount, 1);
    assert.deepEqual(d.truncated, []);
  });
  it('lista coleções truncadas ao atingir o teto de leitura', async () => {
    const many = Array.from({ length: READ_LIMIT }, () => ({ accountId: 'a1', status: 'received', amountCents: 1, receivedDate: '2026-01-01' }));
    const { io } = makeIo({ tables: { accounts: [{ id: 'a1', status: 'active' }], incomes: many } });
    // o mock ignora `where`, então a leitura de receitas pendentes da previsão também enche o teto
    const { truncated } = await loadDashboard(uid, io);
    assert.ok(truncated.includes('incomes'));
  });
  it('consultas usam índices declarados (status + data) e limites', async () => {
    const { io, calls } = makeIo();
    io.now = () => new Date('2026-11-19T12:00:00Z');
    await loadDashboard(uid, io);
    const pending = calls.lists.find((l) => l.c === 'expenses' && l.opts.where?.[0]?.[2] === 'pending').opts;
    assert.deepEqual(pending.where, [['status', '==', 'pending'], ['dueDate', '>=', '2026-11-19']]);
    assert.deepEqual(pending.orderBy, ['dueDate', 'asc']);
    assert.ok(calls.lists.filter((l) => l.c !== 'accounts' && l.c !== 'budgets').every((l) => l.opts.limit));
  });
});

describe('reports service', () => {
  it('valida período (inválido, invertido, > 24 meses)', () => {
    assert.equal(validatePeriod('2026-11', '2026-11').ok, true);
    assert.equal(validatePeriod('2026-12', '2026-11').ok, false);
    assert.equal(validatePeriod('x', '2026-11').ok, false);
    assert.equal(validatePeriod('2024-01', '2026-01').ok, false); // 25 meses
    assert.equal(validatePeriod('2024-02', '2026-01').ok, true); // 24 meses
    assert.equal(MAX_REPORT_MONTHS, 24);
  });
  it('carrega só o intervalo, monta série, totais por categoria e nomes', async () => {
    const tables = {
      incomes: [{ categoryId: 'i1', status: 'received', amountCents: 9000, receivedDate: '2026-10-05' }],
      expenses: [{ categoryId: 'c1', status: 'paid', amountCents: 2500, paidDate: '2026-11-02' }, { categoryId: 'c1', status: 'paid', amountCents: 500, paidDate: '2026-11-20' }],
      categories: [{ id: 'c1', name: 'Mercado' }, { id: 'i1', name: 'Salário' }],
    };
    const { io, calls } = makeIo({ tables });
    const r = await loadReport(uid, '2026-10', '2026-11', io);
    assert.equal(r.ok, true);
    assert.deepEqual(r.totals, { incomeCents: 9000, expenseCents: 3000, resultCents: 6000 });
    assert.deepEqual(r.expensesByCategory.map((x) => [x.categoryId, x.totalCents]), [['c1', 3000]]);
    assert.equal(r.categories.get('c1'), 'Mercado');
    assert.deepEqual(calls.lists.find((l) => l.c === 'incomes').opts.where, [['receivedDate', '>=', '2026-10-01'], ['receivedDate', '<=', '2026-11-30']]);
    assert.equal((await loadReport(uid, '2026-12', '2026-01', io)).ok, false);
  });
  it('CSV da série e das categorias a partir de centavos', () => {
    const csv = seriesToCsv([{ month: '2026-11', incomeCents: 123456, expenseCents: 5, resultCents: -100 }]);
    assert.equal(csv, 'Mês;Receitas;Despesas;Resultado\r\n2026-11;1234,56;0,05;-1,00');
    const cat = categoriesToCsv([{ categoryId: 'c1', totalCents: 1050, count: 2, sharePercent: 50 }, { categoryId: 'gone', totalCents: 1, count: 1, sharePercent: 1 }], new Map([['c1', '=Mercado']]));
    assert.equal(cat, "Categoria;Total;Lançamentos;Participação\r\n'=Mercado;10,50;2;50%\r\n(sem categoria);0,01;1;1%");
  });
});
