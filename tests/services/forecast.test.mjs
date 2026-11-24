/**
 * Saldo de abertura (initialBalanceCents + openingDate), ajuste guiado e previsão financeira mensal.
 * Tudo puro/injetado — sem rede nem emulador.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountBalances, orphanMovements, debtorMonthStatement } from '../../js/core/model.js';
import { monthlyForecast, subscriptionOccurrences, unpaidInvoiceCents, projectedInvoiceForCharge } from '../../js/core/forecast.js';
import { computeOpeningAdjustment, adjustOpeningBalance } from '../../js/services/accounts.js';
import { loadMonthlyForecast } from '../../js/services/forecast.js';
import { updateAccount, createAccount } from '../../js/services/accounts.js';
import { mapImportRow, buildMergeRaw } from '../../js/core/importSchema.js';
import { buildEntity } from '../../js/core/model.js';

const acc = (id, initial = 0, extra = {}) => ({ id, status: 'active', institution: 'Banco', name: id, initialBalanceCents: initial, ...extra });
const inc = (accountId, cents, receivedDate, status = 'received') => ({ accountId, amountCents: cents, receivedDate, status });
const exp = (accountId, cents, paidDate, status = 'paid') => ({ accountId, amountCents: cents, paidDate, status });
const total = (map) => [...map.values()].reduce((t, v) => t + v, 0);

describe('saldo: abertura + entradas − saídas', () => {
  it('saldo inicial diferente de zero é a base do saldo atual (e nunca é sobrescrito)', () => {
    const accounts = [acc('a1', 500000)];
    assert.equal(accountBalances(accounts, {}).get('a1'), 500000);
    assert.equal(accounts[0].initialBalanceCents, 500000);
  });

  it('conta com receitas e despesas: abertura + recebidas − pagas; pendentes/canceladas não contam', () => {
    const b = accountBalances([acc('a1', 100000)], {
      incomes: [inc('a1', 50000, '2026-11-05'), inc('a1', 999, null, 'pending')],
      expenses: [exp('a1', 20000, '2026-11-06'), exp('a1', 777, null, 'pending'), exp('a1', 555, '2026-11-07', 'cancelled')],
    });
    assert.equal(b.get('a1'), 100000 + 50000 - 20000);
  });

  it('transferência confirmada debita uma conta e credita a outra, sem alterar o patrimônio', () => {
    const accounts = [acc('a1', 100000), acc('a2', 20000)];
    const before = total(accountBalances(accounts, {}));
    const b = accountBalances(accounts, { transfers: [
      { fromAccountId: 'a1', toAccountId: 'a2', amountCents: 30000, status: 'confirmed', date: '2026-11-10' },
      { fromAccountId: 'a1', toAccountId: 'a2', amountCents: 99999, status: 'pending', date: '2026-11-11' },
    ] });
    assert.equal(b.get('a1'), 70000);
    assert.equal(b.get('a2'), 50000);
    assert.equal(total(b), before);
  });

  it('fatura paga debita a conta UMA vez; compras do cartão não são despesas', () => {
    const b = accountBalances([acc('a1', 100000)], { invoices: [
      { status: 'paid', accountId: 'a1', paidCents: 40000, totalCents: 40000, paidAt: '2026-11-10' },
      { status: 'closed', accountId: 'a1', totalCents: 999 },
    ] });
    assert.equal(b.get('a1'), 60000);
  });

  it('data de abertura: só movimentos a partir dela entram (antigos já estão no saldo de abertura)', () => {
    const accounts = [acc('a1', 100000, { openingDate: '2026-11-01' })];
    const b = accountBalances(accounts, {
      incomes: [inc('a1', 50000, '2026-10-20'), inc('a1', 7000, '2026-11-01')], // 20/10 ignorada; 01/11 conta
      expenses: [exp('a1', 3000, '2026-09-01'), exp('a1', 1000, '2026-11-15')],
      transfers: [{ fromAccountId: 'a1', toAccountId: 'x', amountCents: 500, status: 'confirmed', date: '2026-10-31' }],
    });
    assert.equal(b.get('a1'), 100000 + 7000 - 1000);
  });

  it('conta antiga (sem openingDate) conta todos os movimentos, como antes; abertura é por conta', () => {
    const accounts = [acc('old', 0), acc('new', 0, { openingDate: '2026-11-01' })];
    const b = accountBalances(accounts, { incomes: [inc('old', 100, '2020-01-01'), inc('new', 100, '2020-01-01')] });
    assert.deepEqual([b.get('old'), b.get('new')], [100, 0]);
    // transferência: cada ponta respeita a abertura da própria conta
    const t = accountBalances(accounts, { transfers: [{ fromAccountId: 'old', toAccountId: 'new', amountCents: 50, status: 'confirmed', date: '2026-10-01' }] });
    assert.deepEqual([t.get('old'), t.get('new')], [-50, 0]);
  });

  it('movimentos órfãos (conta inexistente) são detectados em vez de sumirem em silêncio', () => {
    const o = orphanMovements([acc('a1')], {
      incomes: [inc('ghost', 1, '2026-11-01'), inc('a1', 1, '2026-11-01'), inc('ghost', 1, null, 'pending')],
      transfers: [{ fromAccountId: 'a1', toAccountId: 'ghost', status: 'confirmed' }],
    });
    assert.deepEqual(o, { count: 2, byCollection: { incomes: 1, transfers: 1 } });
  });
});

describe('ajuste guiado do saldo de abertura', () => {
  const account = acc('a1', 0);
  const movements = { incomes: [inc('a1', 30000, '2026-11-05')], expenses: [exp('a1', 10000, '2026-11-06')] };

  it('nova abertura = saldo real − movimentações (só a abertura muda)', () => {
    const r = computeOpeningAdjustment(account, movements, 150000);
    assert.deepEqual(r, { currentCents: 20000, movementsCents: 20000, newInitialCents: 130000 });
    // depois do ajuste o saldo derivado bate com o real
    assert.equal(accountBalances([{ ...account, initialBalanceCents: r.newInitialCents }], movements).get('a1'), 150000);
  });

  it('com data de abertura, movimentos anteriores deixam de contar no cálculo', () => {
    const r = computeOpeningAdjustment({ ...account, openingDate: '2026-11-06' }, movements, 50000);
    assert.equal(r.movementsCents, -10000);
    assert.equal(r.newInitialCents, 60000);
  });

  // VF-ARQ-02: o ajuste é calculado e gravado pelo SERVIDOR (mesma fórmula, testada em tests/integration). Aqui: fiação.
  const makeApi = (response) => {
    const calls = [];
    return { calls, finance: async (op, params, options) => { calls.push({ op, params, options }); return response; } };
  };

  it('envia o saldo real em centavos inteiros a account.adjustOpening e devolve o cálculo do servidor', async () => {
    const api = makeApi({ ok: true, previousInitialCents: 0, newInitialCents: 130000, movementsCents: 20000 });
    const r = await adjustOpeningBalance('u', 'a1', '1.500,00', {}, { finance: api.finance });
    assert.deepEqual([r.ok, r.newInitialCents, r.movementsCents, r.previousInitialCents], [true, 130000, 20000, 0]);
    assert.deepEqual(api.calls.map((c) => [c.op, c.params]), [['account.adjustOpening', { accountId: 'a1', realBalanceCents: 150000 }]]);
  });

  it('com data de abertura envia os dois campos', async () => {
    const api = makeApi({ ok: true, previousInitialCents: 0, newInitialCents: 60000, movementsCents: -10000 });
    await adjustOpeningBalance('u', 'a1', '500,00', { openingDate: '2026-11-06' }, { finance: api.finance });
    assert.deepEqual(api.calls[0].params, { accountId: 'a1', realBalanceCents: 50000, openingDate: '2026-11-06' });
  });

  it('saldo inválido/negativo e data inválida param antes do servidor; abertura negativa vem do servidor como erro de saldo', async () => {
    const api = makeApi({ ok: true });
    assert.ok((await adjustOpeningBalance('u', 'a1', 'abc', {}, { finance: api.finance })).errors.realBalance);
    assert.ok((await adjustOpeningBalance('u', 'a1', '-5,00', {}, { finance: api.finance })).errors.realBalance);
    assert.ok((await adjustOpeningBalance('u', 'a1', '5,00', { openingDate: 'x' }, { finance: api.finance })).errors.openingDate);
    assert.equal(api.calls.length, 0);
    const neg = makeApi({ ok: false, code: 'INVALID_STATE', errors: { _form: 'Os lançamentos já somam mais que o saldo informado; defina uma data de abertura.' } });
    assert.match((await adjustOpeningBalance('u', 'a1', '100,00', {}, { finance: neg.finance })).errors.realBalance, /data de abertura/);
  });
});

// ------------------------------------------------------------------------------------------------------------
describe('previsão mensal', () => {
  const base = { month: '2026-11', today: '2026-11-15' };
  const e = (id, dueDate, cents, status = 'pending', extra = {}) => ({ id, description: `Desp ${id}`, dueDate, amountCents: cents, status, ...extra });

  it('exemplo do enunciado: 5.000 + 2.000 − 1.200 − 1.500 − 300 = 4.000', () => {
    const f = monthlyForecast({
      ...base, balanceCents: 500000,
      pendingIncomes: [{ id: 'i1', status: 'pending', expectedDate: '2026-11-25', amountCents: 200000 }],
      expenses: [e('e1', '2026-11-20', 120000)],
      invoices: [{ id: 'f1', cardId: 'c1', status: 'closed', dueDate: '2026-11-28', totalCents: 150000 }],
      subscriptions: [{ id: 's1', name: 'Streaming', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-11-22', amountCents: 30000, accountId: 'a1' }],
    });
    assert.equal(f.projectedBalanceCents, 400000);
  });

  it('despesa prevista × paga × pendente × vencida', () => {
    const f = monthlyForecast({ ...base, expenses: [
      e('pago', '2026-11-05', 10000, 'paid', { paidDate: '2026-11-05' }),
      e('vencida', '2026-11-10', 20000), // < hoje (15/11)
      e('avencer', '2026-11-30', 30000),
      e('cancelada', '2026-11-12', 99999, 'cancelled'),
      e('mesAnterior', '2026-10-20', 5000), // vencida de mês anterior, ainda pendente
      e('proxMes', '2026-12-02', 77777),
    ] });
    assert.deepEqual(
      [f.expenses.plannedCents, f.expenses.paidCents, f.expenses.pendingCents, f.expenses.overdueCents, f.expenses.overduePreviousCents, f.expenses.upcomingCents],
      [60000, 10000, 50000, 25000, 5000, 30000]);
    assert.equal(f.expenses.toPayCents, 55000); // 20000 + 30000 + 5000 (vencida anterior entra no caixa)
  });

  it('despesas recorrentes lançadas no mês são destacadas; as não lançadas não são projetadas', () => {
    const f = monthlyForecast({ ...base, expenses: [e('aluguel', '2026-11-05', 150000, 'pending', { recurrence: 'monthly' }), e('mercado', '2026-11-06', 1000)] });
    assert.equal(f.expenses.recurringPlannedCents, 150000);
    assert.equal(f.nextMonths[0].expensesCents, 0); // dezembro: nada lançado = nada projetado
  });

  it('compra parcelada no cartão: compromisso total ≠ caixa do mês (só a fatura vence)', () => {
    const card = { id: 'c1', status: 'active', limitCents: 500000 };
    const invoices = [
      { id: 'f11', cardId: 'c1', referenceMonth: '2026-11', status: 'open', dueDate: '2026-11-28' },
      { id: 'f12', cardId: 'c1', referenceMonth: '2026-12', status: 'open', dueDate: '2026-12-28' },
      { id: 'f01', cardId: 'c1', referenceMonth: '2027-01', status: 'open', dueDate: '2027-01-28' },
    ];
    // R$ 900 em 3x de 300, uma em cada fatura
    const purchases = ['f11', 'f12', 'f01'].map((id, i) => ({ id: `p${i}`, cardId: 'c1', invoiceId: id, amountCents: 30000, purchaseDate: '2026-11-10' }));
    const f = monthlyForecast({ ...base, balanceCents: 100000, cards: [card], invoices, purchases });
    assert.equal(f.cards.committedCents, 90000); // o que foi comprado e não quitado
    assert.equal(f.cards.purchasesInMonthCents, 90000);
    assert.equal(f.cards.invoicesToPayCents, 30000); // só a fatura que vence em novembro sai do caixa
    assert.equal(f.projectedBalanceCents, 70000);
    assert.deepEqual(f.nextMonths.map((m) => [m.month, m.invoicesCents]), [['2026-12', 30000], ['2027-01', 30000], ['2027-02', 0]]);
  });

  it('fatura aberta (soma das compras), fechada (total) e paga (fora)', () => {
    const purchases = [{ invoiceId: 'a', amountCents: 1000 }, { invoiceId: 'a', amountCents: 2000 }];
    assert.equal(unpaidInvoiceCents({ id: 'a', status: 'open' }, purchases), 3000);
    assert.equal(unpaidInvoiceCents({ id: 'b', status: 'closed', totalCents: 5000 }, []), 5000);
    assert.equal(unpaidInvoiceCents({ id: 'c', status: 'paid', totalCents: 9000 }, []), 0);
    assert.equal(unpaidInvoiceCents({ id: 'd', status: 'cancelled', totalCents: 9000 }, []), 0);
    const f = monthlyForecast({ ...base, invoices: [
      { id: 'a', cardId: 'c', status: 'open', dueDate: '2026-11-20' },
      { id: 'b', cardId: 'c', status: 'closed', dueDate: '2026-11-10', totalCents: 5000 }, // vencida
      { id: 'c', cardId: 'c', status: 'paid', dueDate: '2026-11-05', totalCents: 9000, paidCents: 9000 },
    ], purchases });
    assert.deepEqual([f.cards.openInvoicesCents, f.cards.closedInvoicesCents, f.cards.invoicesToPayCents, f.cards.invoicesOverdueCents], [3000, 5000, 8000, 5000]);
  });

  it('fatura entra no caixa pelo VENCIMENTO, não pelo mês de referência', () => {
    const inv = { id: 'f', cardId: 'c', referenceMonth: '2026-10', status: 'closed', dueDate: '2026-11-05', totalCents: 40000 };
    assert.equal(monthlyForecast({ ...base, invoices: [inv] }).cards.invoicesToPayCents, 40000);
    assert.equal(monthlyForecast({ month: '2026-10', today: '2026-10-15', invoices: [inv] }).cards.invoicesToPayCents, 0);
  });

  it('assinatura mensal e semanal: ocorrências no mês; paga direto × no cartão; cobranças futuras de outro mês', () => {
    const monthly = { id: 'm', name: 'Streaming', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-10-22', amountCents: 5000, accountId: 'a1' };
    const weekly = { id: 'w', name: 'Feira', status: 'active', periodicity: 'weekly', nextChargeDate: '2026-11-03', amountCents: 1000, accountId: 'a1' };
    assert.deepEqual(subscriptionOccurrences(monthly, '2026-11-01', '2026-11-30'), ['2026-11-22']); // projeta a partir de outubro
    assert.deepEqual(subscriptionOccurrences(weekly, '2026-11-01', '2026-11-30'), ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
    assert.deepEqual(subscriptionOccurrences({ ...monthly, nextChargeDate: '2026-12-05' }, '2026-11-01', '2026-11-30'), []);
    const f = monthlyForecast({ ...base, subscriptions: [monthly, weekly, { id: 'c', name: 'Cloud', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-11-18', amountCents: 2000, cardId: 'c1' }, { id: 'p', name: 'Pausada', status: 'paused', periodicity: 'monthly', nextChargeDate: '2026-11-18', amountCents: 9999 }] });
    // cartão c1 desconhecido aqui: sem fatura para projetar, a saída de caixa cai na própria data (conservador)
    assert.deepEqual([f.subscriptions.directCents, f.subscriptions.cardCommitmentCents, f.subscriptions.cardCashCents, f.subscriptions.plannedInMonthCents], [9000, 2000, 2000, 11000]);
    assert.equal(f.subscriptions.monthlyCents, 5000 + Math.round(1000 * 52 / 12) + 2000); // valor mensal consolidado (ativas)
    assert.deepEqual(f.subscriptions.nextCharges.map((s) => s.id), ['m', 'w', 'c']);
  });

  it('PREVENÇÃO DE DUPLICIDADE: assinatura já lançada como despesa é descartada e sinalizada; no cartão nunca', () => {
    const sub = { id: 's', name: 'Netflix', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-11-20', amountCents: 5590, accountId: 'a1' };
    const twin = e('d', '2026-11-20', 5590, 'pending', { description: ' netflix ' });
    const f = monthlyForecast({ ...base, expenses: [twin], subscriptions: [sub] });
    assert.equal(f.subscriptions.directCents, 0);
    assert.deepEqual(f.subscriptions.duplicates.map((d) => [d.subscriptionId, d.expenseId]), [['s', 'd']]);
    assert.equal(f.expenses.toPayCents, 5590); // conta uma vez, pela despesa
    assert.equal(monthlyForecast({ ...base, expenses: [{ ...twin, amountCents: 6000 }], subscriptions: [sub] }).subscriptions.directCents, 5590); // valor diferente = outra coisa
    assert.equal(monthlyForecast({ ...base, expenses: [twin], subscriptions: [{ ...sub, cardId: 'c1' }] }).subscriptions.cardCommitmentCents, 5590);
  });

  it('PREVENÇÃO DE DUPLICIDADE: pago/recebido não entra de novo; compra do cartão não vira despesa; fatura paga fora', () => {
    const f = monthlyForecast({
      ...base, balanceCents: 100000,
      expenses: [e('pago', '2026-11-05', 40000, 'paid', { paidDate: '2026-11-05' })],
      pendingIncomes: [{ id: 'rec', status: 'received', expectedDate: '2026-11-05', amountCents: 88888 }], // recebida: já está no saldo
      cards: [{ id: 'c', status: 'active', limitCents: 100000 }],
      invoices: [{ id: 'f', cardId: 'c', status: 'paid', dueDate: '2026-11-10', totalCents: 30000, paidCents: 30000 }],
      purchases: [{ id: 'p', cardId: 'c', invoiceId: 'f', amountCents: 30000, purchaseDate: '2026-11-01' }],
    });
    assert.equal(f.projectedBalanceCents, 100000); // nada pendente → saldo projetado = saldo atual
    assert.equal(f.cards.committedCents, 0); // fatura paga quita o compromisso
    assert.equal(f.cards.invoicesToPayCents, 0);
  });

  it('dívida parcelada de devedor: a receber no mês é informativo e só entra com o interruptor', () => {
    const st = debtorMonthStatement({
      debtor: { id: 'd1', status: 'open', lentCents: 90000, receivedCents: 0 }, month: '2026-11',
      debts: [{ id: 'x1', status: 'pending', principalCents: 30000, dueDate: '2026-11-10', installmentNumber: 1, installmentsTotal: 3, description: 'Moto' },
        { id: 'x2', status: 'pending', principalCents: 30000, dueDate: '2026-12-10', installmentNumber: 2, installmentsTotal: 3, description: 'Moto' }],
    });
    assert.equal(st.totalCents, 30000); // só a parcela de novembro
    const off = monthlyForecast({ ...base, balanceCents: 1000, debtorsReceivableCents: st.totalCents });
    const on = monthlyForecast({ ...base, balanceCents: 1000, debtorsReceivableCents: st.totalCents, includeDebtors: true });
    assert.deepEqual([off.projectedBalanceCents, on.projectedBalanceCents, off.debtors.receivableCents], [1000, 31000, 30000]);
  });

  it('mudança de mês: lançamentos de meses anteriores/posteriores não vazam; vencidas antigas pesam', () => {
    const expenses = [e('out', '2026-10-31', 1000), e('nov', '2026-11-30', 2000), e('dez', '2026-12-01', 4000)];
    const nov = monthlyForecast({ month: '2026-11', today: '2026-11-15', expenses });
    assert.deepEqual([nov.expenses.plannedCents, nov.expenses.toPayCents], [2000, 3000]); // out vencida entra no caixa, não no "previsto do mês"
    const dec = monthlyForecast({ month: '2026-12', today: '2026-11-15', expenses });
    assert.deepEqual([dec.expenses.plannedCents, dec.expenses.toPayCents], [4000, 7000]); // acumula tudo até o fim de dezembro
    assert.equal(nov.nextMonths[0].expensesCents, 4000);
    assert.throws(() => monthlyForecast({ month: '2026-13', today: '2026-11-15' }), RangeError);
  });

  it('virada de ano: janeiro lê dezembro como mês anterior e fevereiro tem 28/29 dias', () => {
    const f = monthlyForecast({ month: '2027-01', today: '2026-12-20', expenses: [e('a', '2026-12-28', 100), e('b', '2027-01-31', 200)] });
    assert.deepEqual([f.start, f.end, f.expenses.plannedCents, f.expenses.toPayCents], ['2027-01-01', '2027-01-31', 200, 300]);
    assert.equal(monthlyForecast({ month: '2028-02', today: '2028-02-01' }).end, '2028-02-29');
  });

  it('projeção negativa é calculada (saldo insuficiente para os compromissos)', () => {
    assert.equal(monthlyForecast({ ...base, balanceCents: 1000, expenses: [e('x', '2026-11-20', 5000)] }).projectedBalanceCents, -4000);
  });
});

describe('serviço da previsão (leituras)', () => {
  it('usa faixas/índices declarados, limites e delega ao cálculo puro; sinaliza truncamento', async () => {
    const calls = [];
    const tables = {
      expenses: [{ id: 'e1', description: 'X', dueDate: '2026-11-20', amountCents: 1000, status: 'pending' }],
      incomes: [{ id: 'i1', status: 'pending', expectedDate: '2026-11-25', amountCents: 5000 }],
      subscriptions: [],
    };
    const io = { list: async (_u, c, o) => { calls.push({ c, o }); return tables[c] ?? []; } };
    const f = await loadMonthlyForecast('u', { month: '2026-11', today: '2026-11-15', balanceCents: 10000 }, io);
    assert.equal(f.projectedBalanceCents, 10000 + 5000 - 2000); // o mock devolve a mesma despesa nas duas leituras de despesas…
    assert.deepEqual(calls.map((c) => c.c).sort(), ['expenses', 'expenses', 'incomes', 'subscriptions']);
    assert.ok(calls.every((c) => c.o.limit === 1000));
    assert.deepEqual(calls.find((c) => c.c === 'incomes').o.where, [['status', '==', 'pending'], ['expectedDate', '<=', '2026-11-30']]);
    assert.deepEqual(calls.filter((c) => c.c === 'expenses').map((c) => c.o.where), [
      [['dueDate', '>=', '2026-11-01'], ['dueDate', '<=', '2026-11-30']],
      [['status', '==', 'pending'], ['dueDate', '<', '2026-11-01']],
    ]);
    const many = { ...tables, incomes: Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, status: 'pending', expectedDate: '2026-11-01', amountCents: 1 })) };
    const t = await loadMonthlyForecast('u', { month: '2026-11', today: '2026-11-15' }, { list: async (_u, c) => many[c] ?? [] });
    assert.deepEqual(t.truncated, ['incomesPending']);
  });
});

describe('data de abertura: cadastro, edição e CSV', () => {
  const raw = { institution: 'Nubank', type: 'checking', initialBalanceCents: '1.500,00', color: '#000', status: 'active' };
  it('modelo aceita openingDate válida e rejeita data inexistente; sem ela a conta continua válida (compatibilidade)', () => {
    assert.equal(buildEntity('accounts', { ...raw, openingDate: '2026-11-01' }).data.openingDate, '2026-11-01');
    assert.ok(buildEntity('accounts', { ...raw, openingDate: '2026-02-30' }).errors.openingDate);
    assert.equal(buildEntity('accounts', raw).ok, true);
  });
  it('criar envia openingDate; editar NÃO altera abertura/saldo (só o servidor ajusta): mudança é recusada, sem mudança não envia o campo', async () => {
    const calls = [];
    const stored = { id: 'a1', initialBalanceCents: 150000, openingDate: '2026-11-01' };
    const io = { getById: async () => stored, create: async (_u, _c, d) => { calls.push(['create', d]); return 'n'; }, update: async (_u, _c, _id, d) => { calls.push(['update', d]); }, writeAudit: async () => {} };
    await createAccount('u', { ...raw, openingDate: '2026-11-01' }, io);
    assert.equal(calls[0][1].openingDate, '2026-11-01');
    assert.equal(calls[0][1].initialBalanceCents, 150000);
    const refused = await updateAccount('u', 'a1', raw, io); // sem openingDate: tentaria removê-la
    assert.equal(refused.ok, false);
    assert.ok(refused.errors.openingDate);
    const ok = await updateAccount('u', 'a1', { ...raw, openingDate: '2026-11-01' }, io);
    assert.equal(ok.ok, true);
    assert.equal('openingDate' in calls[1][1], false);
    assert.equal('initialBalanceCents' in calls[1][1], false);
  });
  it('CSV de contas: coluna data_abertura opcional; mesclagem preserva a data existente', () => {
    const ctx = { accounts: [], categories: [], cards: [], debtors: [] };
    const ok = mapImportRow('contas', { instituicao: 'Nubank', tipo: 'checking', saldo_inicial: '1500,00', data_abertura: '2026-11-01' }, ctx);
    assert.equal(ok.ok, true);
    assert.equal(ok.raw.openingDate, '2026-11-01');
    assert.ok(mapImportRow('contas', { instituicao: 'Nubank', tipo: 'checking', data_abertura: '01/11/2026' }, ctx).errors.data_abertura);
    assert.equal(mapImportRow('contas', { instituicao: 'Nubank', tipo: 'checking' }, ctx).ok, true);
    const merged = buildMergeRaw('contas', { institution: 'Nubank', type: 'checking', color: '#000', status: 'active', initialBalanceCents: 0, openingDate: '2026-11-01' }, { color: '#fff' }, ['color']);
    assert.equal(merged.openingDate, '2026-11-01');
  });
});

describe('assinatura no cartão: comprometimento (mês da cobrança) × saída de caixa (vencimento da fatura)', () => {
  // fecha dia 10, vence dia 17 (mesmo mês da referência); cobrança dia 20 cai na fatura do mês SEGUINTE
  const card = { id: 'c1', status: 'active', closingDay: 10, dueDay: 17, limitCents: 1000000 };
  const sub = (over = {}) => ({ id: 's1', name: 'Netflix', status: 'active', periodicity: 'monthly', cardId: 'c1', nextChargeDate: '2026-11-20', amountCents: 5590, ...over });
  const base = { month: '2026-11', today: '2026-11-15', balanceCents: 100000, cards: [card] };

  it('fatura projetada: fechamento define a referência; vence conforme o cartão; fechada/paga empurra para a próxima', () => {
    assert.deepEqual(projectedInvoiceForCharge(card, '2026-11-20', []), { referenceMonth: '2026-12', dueDate: '2026-12-17' });
    assert.deepEqual(projectedInvoiceForCharge(card, '2026-11-05', []), { referenceMonth: '2026-11', dueDate: '2026-11-17' });
    assert.deepEqual(projectedInvoiceForCharge(card, '2026-12-20', []), { referenceMonth: '2027-01', dueDate: '2027-01-17' }); // virada de ano
    // vencimento no mês seguinte ao fechamento (fecha 25, vence 5)
    assert.deepEqual(projectedInvoiceForCharge({ ...card, closingDay: 25, dueDay: 5 }, '2026-11-20', []), { referenceMonth: '2026-11', dueDate: '2026-12-05' });
    // fatura existente: usa o vencimento dela; fechada não recebe compra nova
    const open = { cardId: 'c1', referenceMonth: '2026-12', status: 'open', dueDate: '2026-12-18' };
    assert.deepEqual(projectedInvoiceForCharge(card, '2026-11-20', [open]), { referenceMonth: '2026-12', dueDate: '2026-12-18' });
    assert.deepEqual(projectedInvoiceForCharge(card, '2026-11-20', [{ ...open, status: 'closed' }]), { referenceMonth: '2027-01', dueDate: '2027-01-17' });
    assert.equal(projectedInvoiceForCharge(undefined, '2026-11-20', []), null);
  });

  it('NÃO lançada: compromisso no mês da cobrança (novembro); sem saída de caixa em novembro (fatura vence em dezembro)', () => {
    const f = monthlyForecast({ ...base, subscriptions: [sub()] });
    const [c] = f.subscriptions.cardCharges.filter((x) => x.chargeMonth === '2026-11');
    assert.deepEqual([c.chargeMonth, c.referenceMonth, c.dueDate], ['2026-11', '2026-12', '2026-12-17']);
    assert.equal(f.subscriptions.cardCommitmentCents, 5590);
    assert.equal(f.subscriptions.plannedInMonthCents, 5590);
    assert.equal(f.subscriptions.cardCashCents, 0);
    assert.equal(f.projectedBalanceCents, 100000); // caixa de novembro intacto
    // o caixa aparece em dezembro (vencimento da fatura), o comprometimento da cobrança de dezembro também
    const dec = f.nextMonths[0];
    assert.deepEqual([dec.month, dec.subscriptionsCents, dec.cardSubscriptionChargesCents], ['2026-12', 5590, 5590]);
    assert.equal(dec.commitmentsCents, 5590); // total de caixa não soma o comprometimento informativo
  });

  it('cobrança cuja fatura vence ainda no mês entra no caixa do mês', () => {
    const f = monthlyForecast({ ...base, subscriptions: [sub({ nextChargeDate: '2026-11-05' })] }); // ≤ fechamento 10 → fatura de novembro, vence 17/11
    assert.equal(f.subscriptions.cardCashCents, 5590);
    assert.equal(f.projectedBalanceCents, 100000 - 5590);
  });

  it('cobrança não lançada do mês anterior pesa no caixa do mês em que a fatura vence', () => {
    const f = monthlyForecast({ ...base, subscriptions: [sub({ nextChargeDate: '2026-10-20' })] }); // 20/10 → fatura nov (vence 17/11)
    assert.equal(f.subscriptions.cardCashCents, 5590);
    assert.equal(f.subscriptions.cardCharges.find((c) => c.chargeMonth === '2026-10').dueDate, '2026-11-17');
    assert.equal(f.subscriptions.cardCommitmentCents, 5590); // a de 20/11 é o comprometimento de novembro; a de outubro não
  });

  it('JÁ lançada: compõe fatura e comprometido do cartão; caixa pelo vencimento da fatura; nada é somado de novo', () => {
    const before = monthlyForecast({ ...base, month: '2026-12', today: '2026-11-15', subscriptions: [sub()], invoices: [], purchases: [] });
    // lançar: compra 1x na fatura aberta 2026-12 (vence 17/12) e a assinatura avança para 20/12
    const purchase = { id: 'p1', cardId: 'c1', invoiceId: 'c1_2026-12', amountCents: 5590, purchaseDate: '2026-11-20', description: 'Netflix', notes: 'Assinatura' };
    const invoice = { id: 'c1_2026-12', cardId: 'c1', referenceMonth: '2026-12', status: 'open', dueDate: '2026-12-17' };
    const after = monthlyForecast({ ...base, month: '2026-11', today: '2026-11-21', subscriptions: [sub({ nextChargeDate: '2026-12-20' })], invoices: [invoice], purchases: [purchase] });
    assert.equal(after.subscriptions.cardCommitmentCents, 0); // não é mais "previsto": é compra
    assert.equal(after.subscriptions.launchedInCardsCents, 5590);
    assert.equal(after.cards.committedCents, 5590); // comprometimento do cartão
    assert.equal(after.projectedBalanceCents, 100000); // novembro: nada sai
    const decAfter = after.nextMonths[0];
    assert.equal(decAfter.invoicesCents, 5590); // saída de caixa pelo vencimento da fatura…
    assert.equal(decAfter.subscriptionsCents, 0); // …e NÃO de novo como assinatura
    // dezembro antes (prevista) e depois (lançada): mesmo caixa, contado uma única vez
    const decBeforeCash = before.subscriptions.cardCashCents; // dezembro: previstas com fatura ≤ 31/12
    assert.equal(decBeforeCash, 5590);
    assert.equal(decAfter.commitmentsCents, 5590);
  });

  it('compra já existente no cartão (mesma descrição, valor e data) descarta a ocorrência prevista e sinaliza', () => {
    const purchase = { id: 'p1', cardId: 'c1', invoiceId: 'c1_2026-12', amountCents: 5590, purchaseDate: '2026-11-20', description: ' netflix ' };
    const f = monthlyForecast({ ...base, subscriptions: [sub()], invoices: [{ id: 'c1_2026-12', cardId: 'c1', referenceMonth: '2026-12', status: 'open', dueDate: '2026-12-17' }], purchases: [purchase] });
    assert.equal(f.subscriptions.cardCommitmentCents, 0);
    assert.deepEqual(f.subscriptions.duplicates.map((d) => [d.via, d.purchaseId]), [['purchase', 'p1']]);
    assert.equal(f.subscriptions.cardCharges.some((c) => c.date === '2026-11-20'), false);
    // valor diferente = outra compra: a ocorrência continua prevista
    const other = monthlyForecast({ ...base, subscriptions: [sub()], purchases: [{ ...purchase, amountCents: 100 }] });
    assert.equal(other.subscriptions.cardCommitmentCents, 5590);
  });

  it('VF-COR-07: assinatura SEM conta e SEM cartão (só devedor ou só acompanhamento) NÃO sai do caixa da previsão; com devedor + cartão segue como cartão', () => {
    const semVinculo = sub({ cardId: undefined, accountId: undefined });
    const soDevedor = sub({ id: 's2', cardId: undefined, accountId: undefined, debtorId: 'dv' });
    const f = monthlyForecast({ ...base, subscriptions: [semVinculo, soDevedor] });
    assert.deepEqual([f.subscriptions.directCents, f.subscriptions.cardCommitmentCents], [0, 0]);
    assert.equal(f.projectedBalanceCents, 100000);
    const cartaoDevedor = monthlyForecast({ ...base, subscriptions: [sub({ debtorId: 'dv' })] });
    const cartao = monthlyForecast({ ...base, subscriptions: [sub()] });
    assert.deepEqual(cartaoDevedor.subscriptions, cartao.subscriptions);
  });

  it('VF-COR-09: ocorrências de assinatura do dia 31 respeitam a âncora (28/02 → 31/03 → 30/04 → 31/05)', () => {
    const s31 = { nextChargeDate: '2026-02-28', periodicity: 'monthly', chargeDay: 31 };
    assert.deepEqual(subscriptionOccurrences(s31, '2026-02-01', '2026-06-30'), ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    const legacy = { nextChargeDate: '2026-02-28', periodicity: 'monthly' }; // sem chargeDay: como antes
    assert.deepEqual(subscriptionOccurrences(legacy, '2026-02-01', '2026-04-30'), ['2026-02-28', '2026-03-28', '2026-04-28']);
  });

  it('assinatura direta (conta) segue pela data da cobrança: comprometimento = caixa no mesmo mês', () => {
    const f = monthlyForecast({ ...base, subscriptions: [sub({ cardId: undefined, accountId: 'a1' })] });
    assert.deepEqual([f.subscriptions.directCents, f.subscriptions.cardCommitmentCents, f.subscriptions.cardCashCents], [5590, 0, 0]);
    assert.equal(f.projectedBalanceCents, 100000 - 5590);
  });

  it('a lógica de compras, parcelas e faturas permanece: compras não entram no caixa; só a fatura pelo vencimento', () => {
    const invoices = [{ id: 'f', cardId: 'c1', referenceMonth: '2026-11', status: 'open', dueDate: '2026-11-17' }];
    const purchases = [{ id: 'p', cardId: 'c1', invoiceId: 'f', amountCents: 30000, purchaseDate: '2026-11-02' }];
    const f = monthlyForecast({ ...base, invoices, purchases, subscriptions: [sub()] });
    assert.deepEqual([f.cards.committedCents, f.cards.invoicesToPayCents], [30000, 30000]);
    assert.equal(f.projectedBalanceCents, 100000 - 30000); // fatura sim; assinatura (vence em dez) não
  });

  it('virada de ano: cobrança de dezembro tem fatura em janeiro', () => {
    const f = monthlyForecast({ month: '2026-12', today: '2026-12-15', balanceCents: 0, cards: [card], subscriptions: [sub({ nextChargeDate: '2026-12-20' })] });
    assert.equal(f.subscriptions.cardCommitmentCents, 5590);
    assert.equal(f.subscriptions.cardCashCents, 0);
    assert.deepEqual([f.nextMonths[0].month, f.nextMonths[0].subscriptionsCents], ['2027-01', 5590]);
  });
});
