/**
 * VF-2-03i — débitos de devedor por origem (empréstimo × cartão), erro amigável e dashboard resiliente.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerCardPurchase, deleteCardPurchase } from '../../js/services/creditCards.js';
import { createDebtPlan, settleDebts, registerDebtPayment, settleInstallment, settleMonthInstallments } from '../../js/services/debtPayments.js';
import { deleteDebtor, getDebtorOverview, listOpenDebtors, loadDebtorStatements, getDebtorStatement, DEBTOR_LINK_QUERIES } from '../../js/services/debtors.js';
import { debtorOverview, debtorMonthStatement, debtorObligations, applyPaymentToDebtor } from '../../js/core/model.js';
import { describeError } from '../../js/utils/errors.js';
import { allocateLinkedGoalBalances, isAccountLinkedGoal } from '../../js/core/model.js';
import { registerGoalTransaction } from '../../js/services/goals.js';
import { monthForecast } from '../../js/core/aggregates.js';
import { cardInvoicesSummary } from '../../js/core/model.js';
import { registerSubscriptionCharge, createSubscription } from '../../js/services/subscriptions.js';
import { registerInvoiceConsolidation, deleteCard } from '../../js/services/creditCards.js';
import { consolidationDeltaCents } from '../../js/core/model.js';
import { upcomingDue } from '../../js/core/aggregates.js';
import { loadDashboard, DASHBOARD_SOURCES } from '../../js/services/dashboard.js';

const uid = 'u1';
const card = { id: 'c1', name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active' };
const debtor = (o = {}) => ({ id: 'd1', name: 'João', lentCents: 100000, receivedCents: 20000, status: 'open', ...o });
const rawBuy = (o = {}) => ({ description: 'TV', amountCents: '300,00', purchaseDate: '2026-11-05', installmentsTotal: 3, debtorId: 'd1', ...o });

function makeIo({ debtors = [debtor()], purchases = [] } = {}) {
  const atomic = [];
  const io = {
    getById: async (u, c, id) => ({ creditCards: [card], debtors, cardPurchases: purchases }[c] ?? []).find((x) => x.id === id) ?? null,
    list: async (u, c) => (c === 'cardPurchases' ? purchases : []),
    commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); },
    now: () => new Date('2026-11-18T12:00:00Z'),
  };
  return { io, atomic };
}

describe('compra de cartão vinculada a devedor', () => {
  it('soma ao emprestado no MESMO lote das parcelas e grava debtorId em cada parcela', async () => {
    const { io, atomic } = makeIo();
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    const batch = atomic.at(-1);
    const parts = batch.filter((o) => o.collection === 'cardPurchases');
    assert.equal(parts.length, 3);
    assert.ok(parts.every((o) => o.data.debtorId === 'd1'));
    const upd = batch.find((o) => o.collection === 'debtors');
    // soma por `increment` atômico (não valor absoluto de leitura velha); devedor em aberto não muda de status
    assert.deepEqual(upd, { type: 'update', collection: 'debtors', docId: 'd1', action: 'card-purchase', data: {}, increments: { lentCents: 30000 } });
    assert.ok(Number.isInteger(upd.increments.lentCents));
  });
  it('rejeita devedor inexistente ou cancelado e não grava nada', async () => {
    for (const debtors of [[], [debtor({ status: 'cancelled' })]]) {
      const { io, atomic } = makeIo({ debtors });
      const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
      assert.equal(r.ok, false);
      assert.ok(r.errors.debtorId);
      assert.equal(atomic.length, 0);
    }
  });
  it('devedor sem empréstimo inicial (lentCents 0): compra soma ao emprestado e o fechamento funciona', async () => {
    const zero = debtor({ lentCents: 0, receivedCents: 0 });
    const { io, atomic } = makeIo({ debtors: [zero] });
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    assert.equal(atomic.at(-1).find((o) => o.collection === 'debtors').increments.lentCents, 30000);
    const none = debtorMonthStatement({ debtor: zero, month: '2026-11' });
    assert.equal(none.totalCents, 0); // sem nada vinculado: 0, sem erro
    const st = debtorMonthStatement({ debtor: debtor({ lentCents: 30000, receivedCents: 0 }), month: '2026-11', purchases: [{ amountCents: 10000, purchaseDate: '2026-11-05' }] });
    assert.equal(st.totalCents, 10000);
  });
  it('sem devedor, o lote não toca em debtors', async () => {
    const { io, atomic } = makeIo();
    await registerCardPurchase(uid, 'c1', rawBuy({ debtorId: undefined }), io);
    assert.equal(atomic.at(-1).some((o) => o.collection === 'debtors'), false);
  });
  it('compra vinculada não pode ser excluída', async () => {
    const { io } = makeIo({ purchases: [{ id: 'p1', cardId: 'c1', debtorId: 'd1' }] });
    const r = await deleteCardPurchase(uid, 'p1', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /devedor/);
  });
});

describe('visão consolidada do devedor', () => {
  it('separa cartão × empréstimo; pendente = emprestado − recebido', () => {
    const o = debtorOverview(debtor({ lentCents: 130000 }), [{ amountCents: 10000 }, { amountCents: 20000 }]);
    assert.deepEqual(o, { lentCents: 130000, receivedCents: 20000, pendingCents: 110000, cardCents: 30000, loanCents: 100000, cardCount: 2 });
    assert.equal(debtorOverview(debtor({ lentCents: 100 }), [{ amountCents: 500 }]).loanCents, 0); // limitado ao emprestado
  });
  it('getDebtorOverview lista compras vinculadas (mais recentes primeiro)', async () => {
    const purchases = [{ amountCents: 100, purchaseDate: '2026-01-01' }, { amountCents: 200, purchaseDate: '2026-02-01' }];
    const o = await getDebtorOverview(uid, debtor(), { list: async () => [...purchases] });
    assert.equal(o.cardPurchases[0].purchaseDate, '2026-02-01');
    assert.equal(o.cardCents, 300);
  });
  it('exclusão de devedor considera compras no cartão: a verificação é do SERVIDOR (debtor.delete); o vínculo segue declarado', async () => {
    assert.ok(DEBTOR_LINK_QUERIES.some((q) => q.collection === 'cardPurchases' && q.field === 'debtorId'));
    const finance = async () => ({ ok: false, code: 'HAS_HISTORY', errors: { _form: 'Este devedor possui 2 compras no cartão e não pode ser excluído; arquive-o.' } });
    const r = await deleteDebtor(uid, 'd1', { finance });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /2 compras no cartão/);
  });
});

describe('describeError', () => {
  it('traduz códigos do Firebase', () => {
    assert.match(describeError({ code: 'permission-denied' }), /Permissão negada.*firestore\.rules/);
    assert.match(describeError({ code: 'unavailable' }), /conexão/);
    assert.match(describeError(new Error('x')), /Tente novamente/);
    assert.ok(describeError(undefined));
  });
});

describe('dashboard resiliente por fonte', () => {
  const base = { accounts: [{ id: 'a1', status: 'active', initialBalanceCents: 1000 }] };
  const ioWith = (failing = []) => ({
    now: () => new Date('2026-11-19T12:00:00Z'),
    list: async (u, c, opts = {}) => {
      if (failing.includes(`${c}:${opts.where?.[0]?.[2] ?? ''}`) || failing.includes(c)) throw Object.assign(new Error('x'), { code: 'permission-denied' });
      return base[c] ?? [];
    },
  });
  const silent = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

  it('coleções vazias não são falha', async () => {
    const d = await loadDashboard(uid, ioWith());
    assert.deepEqual(d.failed, []);
    assert.equal(d.debtors.pendingCents, 0);
  });
  it('falha em uma fonte não derruba as demais', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['debtors', 'invoices:closed'])));
    assert.deepEqual(d.failed.sort(), ['debtors', 'invoices']);
    assert.equal(d.debtors, null);
    assert.equal(typeof d.totalBalanceCents, 'number');
    assert.ok(d.result);
    assert.ok(Array.isArray(d.upcoming));
  });
  it('sem movimentos: saldo e resultado indisponíveis (null), resto intacto', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['incomes:received'])));
    assert.deepEqual(d.failed, ['movements']);
    assert.equal(d.totalBalanceCents, null);
    assert.equal(d.result, null);
    assert.ok(d.debtors);
  });
  it('sem contas: saldo nulo e movimentos não consultados', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['accounts'])));
    assert.deepEqual(d.failed, ['accounts']);
    assert.equal(d.accountCount, null);
    assert.equal(d.totalBalanceCents, null);
    assert.ok(DASHBOARD_SOURCES.includes('movements'));
  });
});

describe('fechamento do mês por devedor (VF-2-03j)', () => {
  const inv = new Map([
    ['i11', { id: 'i11', referenceMonth: '2026-11', status: 'open' }],
    ['i12', { id: 'i12', referenceMonth: '2026-12', status: 'paid' }],
  ]);
  const buys = [
    { id: 'p1', description: 'TV', installmentNumber: 1, installmentsTotal: 2, amountCents: 15000, invoiceId: 'i11', purchaseDate: '2026-11-05' },
    { id: 'p2', description: 'TV', installmentNumber: 2, installmentsTotal: 2, amountCents: 15000, invoiceId: 'i12', purchaseDate: '2026-11-05' },
  ];
  const debts = [
    { id: 'b1', principalCents: 20000, dueDate: '2026-11-20', status: 'pending' },
    { id: 'b2', principalCents: 10000, dueDate: '2026-12-20', status: 'pending' },
    { id: 'b3', principalCents: 5000, dueDate: '2026-11-25', status: 'cancelled' },
  ];
  // lent = 100000 (inclui 30000 de cartão); recebido 20000 → pendente 80000
  const d = debtor({ lentCents: 100000, receivedCents: 20000 });

  it('soma cartão (mês da FATURA) + parcelas de empréstimo do mês (restante), em centavos', () => {
    const st = debtorMonthStatement({ debtor: d, month: '2026-11', purchases: buys, invoicesById: inv, debts, receivedByDebt: new Map([['b1', 5000]]) });
    assert.equal(st.cardCents, 15000);
    assert.equal(st.loanCents, 15000); // 20000 − 5000 recebidos; cancelada e de dezembro fora
    assert.equal(st.totalCents, 30000);
    assert.equal(st.capped, false);
    assert.deepEqual(st.card.map((p) => p.installmentNumber), [1]);
    assert.equal(debtorMonthStatement({ debtor: d, month: '2026-12', purchases: buys, invoicesById: inv, debts }).cardCents, 15000);
  });
  it('limita ao pendente e zera para devedor não aberto', () => {
    const small = debtor({ lentCents: 100000, receivedCents: 80000 }); // pendente 20000
    const st = debtorMonthStatement({ debtor: small, month: '2026-11', purchases: buys, invoicesById: inv, debts });
    assert.equal(st.rawCents, 35000);
    assert.equal(st.totalCents, 20000);
    assert.equal(st.capped, true);
    assert.equal(debtorMonthStatement({ debtor: debtor({ status: 'cancelled' }), month: '2026-11', purchases: buys, invoicesById: inv, debts }).totalCents, 0);
  });
  it('sem fatura usa o mês da compra', () => {
    const st = debtorMonthStatement({ debtor: d, month: '2026-11', purchases: [{ ...buys[0], invoiceId: undefined }], debts });
    assert.equal(st.cardCents, 15000);
    assert.equal('overlapCents' in st, false); // sem alerta de duplicidade (VF-2-03m)
  });
  it('loadDebtorStatements: consultas `in` por lote, só devedores abertos, recebimentos por parcela', async () => {
    const calls = [];
    const io = {
      list: async (u, c, opts) => {
        calls.push({ c, where: opts.where });
        return ({
          cardPurchases: buys.map((p) => ({ ...p, debtorId: 'd1', cardId: 'c1' })),
          debts: debts.map((x) => ({ ...x, debtorId: 'd1' })),
          debtPayments: [{ debtId: 'b1', debtorId: 'd1', amountCents: 5000 }],
          reversals: [],
          invoices: [...inv.values()],
        })[c];
      },
    };
    const open = [d, debtor({ id: 'd2', status: 'cancelled' })];
    const map = await loadDebtorStatements(uid, open, '2026-11', io);
    assert.deepEqual([...map.keys()], ['d1']);
    assert.equal(map.get('d1').totalCents, 30000);
    assert.deepEqual(calls.find((x) => x.c === 'cardPurchases').where, [['debtorId', 'in', ['d1']]]);
    assert.deepEqual(calls.find((x) => x.c === 'invoices').where, [['cardId', 'in', ['c1']]]);
    assert.equal((await loadDebtorStatements(uid, [debtor({ status: 'paid' })], '2026-11', io)).size, 0);
    const single = await getDebtorStatement(uid, debtor({ id: 'd1', status: 'paid' }), '2026-11', io);
    assert.equal(single.totalCents, 0);
    assert.equal(single.purchases.length, 2);
  });
  it('lotes de 30 no operador `in`', async () => {
    const many = Array.from({ length: 65 }, (_, i) => debtor({ id: `d${i}` }));
    const seen = [];
    await loadDebtorStatements(uid, many, '2026-11', { list: async (u, c, o) => { if (c === 'cardPurchases') seen.push(o.where[0][2].length); return []; } });
    assert.deepEqual(seen, [30, 30, 5]);
  });
});

describe('listOpenDebtors (seletor da compra de cartão)', () => {
  it('lista sem where/orderBy no servidor (evita índice composto) e filtra/ordena no cliente', async () => {
    const calls = [];
    const rows = [debtor({ id: 'a', name: 'Zé' }), debtor({ id: 'b', name: 'Ana' }), debtor({ id: 'c', name: 'Bia', status: 'cancelled' }), debtor({ id: 'd', name: 'Caio', status: 'paid' })];
    const out = await listOpenDebtors(uid, { list: async (u, c, opts) => { calls.push({ c, opts }); return rows; } });
    assert.deepEqual(out.map((d) => d.name), ['Ana', 'Caio', 'Zé']); // abertos e quitados (a compra reabre o quitado); cancelado fora
    assert.deepEqual(calls, [{ c: 'debtors', opts: {} }]); // sem where/orderBy
  });
});

describe('dívidas do devedor (VF-2-03m)', () => {
  const planIo = (debtors = [debtor({ lentCents: 0, receivedCents: 0 })]) => {
    const atomic = [];
    return {
      atomic,
      io: {
        getById: async (u, c, id) => debtors.find((x) => x.id === id) ?? null,
        commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => `n${i}`); },
        groupId: () => 'grp1',
      },
    };
  };
  const plan = (o = {}) => ({ debtorId: 'd1', description: 'Moto', totalCents: '1.000,01', installments: 3, firstDueDate: '2026-01-31', ...o });

  it('parcelada: N parcelas em um lote, centavos exatos, mesmo grupo, vencimento mensal com clamp e lentCents += total', async () => {
    const { io, atomic } = planIo();
    const r = await createDebtPlan(uid, plan(), io);
    assert.equal(r.ok, true);
    const ops = atomic[0];
    const parcels = ops.filter((o) => o.collection === 'debts');
    assert.deepEqual(parcels.map((o) => o.data.principalCents), [33335, 33333, 33333]);
    assert.equal(parcels.reduce((t, o) => t + o.data.principalCents, 0), 100001);
    assert.deepEqual(parcels.map((o) => o.data.installmentNumber), [1, 2, 3]);
    assert.ok(parcels.every((o) => o.data.installmentsTotal === 3 && o.data.debtGroupId === 'grp1' && o.data.status === 'pending'));
    assert.deepEqual(parcels.map((o) => o.data.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
    assert.deepEqual(ops.at(-1), { type: 'update', collection: 'debtors', docId: 'd1', action: 'debt-plan', data: {}, increments: { lentCents: 100001 } });
  });
  it('à vista (1 parcela) e várias dívidas independentes somam no emprestado', async () => {
    const { io, atomic } = planIo([debtor({ lentCents: 50000, receivedCents: 0 })]);
    const r = await createDebtPlan(uid, plan({ installments: '', totalCents: '200,00' }), io);
    assert.equal(r.ok, true);
    assert.equal(atomic[0].filter((o) => o.collection === 'debts').length, 1);
    assert.equal(atomic[0].filter((o) => o.collection === 'debts')[0].data.installmentsTotal, 1);
    assert.equal(atomic[0].at(-1).increments.lentCents, 20000);
  });
  it('valida devedor, valor, parcelas e data sem gravar', async () => {
    const bad = [
      [plan({ debtorId: 'zz' }), 'debtorId'], [plan({ totalCents: '0' }), 'totalCents'], [plan({ installments: 0 }), 'installments'],
      [plan({ installments: 121 }), 'installments'], [plan({ firstDueDate: '2026-13-01' }), 'firstDueDate'], [plan({ totalCents: '0,02', installments: 3 }), 'totalCents'],
      [plan({ description: '' }), 'description'],
    ];
    for (const [raw, field] of bad) {
      const { io, atomic } = planIo();
      const r = await createDebtPlan(uid, raw, io);
      assert.equal(r.ok, false, field);
      assert.ok(r.errors[field], field);
      assert.equal(atomic.length, 0);
    }
    const { io, atomic } = planIo([debtor({ status: 'cancelled' })]);
    assert.equal((await createDebtPlan(uid, plan(), io)).ok, false);
    assert.equal(atomic.length, 0);
  });
  it('obrigações: à vista, parcelada, legada e cartão em lista única; sem alerta de duplicidade', () => {
    const d = debtor({ lentCents: 200000, receivedCents: 30000 }); // aberto 170000
    const o = debtorObligations({
      debtor: d,
      debts: [
        { id: 'x1', description: 'Moto', principalCents: 50000, installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', dueDate: '2026-11-10', status: 'pending' },
        { id: 'x2', description: 'Moto', principalCents: 50000, installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g', dueDate: '2026-12-10', status: 'pending' },
        { id: 'x3', description: 'Notebook', principalCents: 80000, installmentNumber: 1, installmentsTotal: 1, dueDate: '2026-11-15', status: 'paid' },
        { id: 'x4', description: 'Antiga', principalCents: 10000, installmentNumber: 1, dueDate: '2026-11-01', status: 'pending' },
        { id: 'x5', description: 'Cancelada', principalCents: 99999, installmentNumber: 1, installmentsTotal: 1, dueDate: '2026-11-01', status: 'cancelled' },
      ],
      receivedByDebt: new Map([['x4', 4000]]),
      purchases: [{ id: 'p1', cardId: 'c1', description: 'TV', installmentNumber: 2, installmentsTotal: 6, amountCents: 20000, invoiceId: 'i1', purchaseDate: '2026-10-01' }],
      invoicesById: new Map([['i1', { id: 'i1', referenceMonth: '2026-11', dueDate: '2026-11-17', status: 'closed' }]]),
      cardsById: new Map([['c1', 'Nubank']]),
    });
    assert.deepEqual(o.items.map((i) => `${i.kind}:${i.description}:${i.installmentNumber}`),
      ['legacy:Antiga:1', 'installment:Moto:1', 'cash:Notebook:1', 'card:TV:2', 'installment:Moto:2']);
    const tv = o.items.find((i) => i.kind === 'card');
    assert.deepEqual([tv.cardName, tv.installmentsTotal, tv.amountCents, tv.referenceMonth, tv.dueDate, tv.status], ['Nubank', 6, 20000, '2026-11', '2026-11-17', 'pending']);
    assert.equal(o.items.find((i) => i.id === 'x3').status, 'paid');
    assert.equal(o.openCents, 170000);
    assert.equal(o.listedCents, 6000 + 20000 + 50000 + 50000); // paga e cancelada não entram
    assert.equal(o.unlistedCents, 170000 - 126000);
    assert.ok(o.listedCents + o.unlistedCents === o.openCents);
    // restante listado acima do em aberto é limitado (sem negativo)
    assert.equal(debtorObligations({ debtor: debtor({ lentCents: 1000, receivedCents: 0 }), purchases: [{ id: 'p', amountCents: 5000 }] }).unlistedCents, 0);
  });
});

describe('antecipar e quitar (VF-2-03n / VF-ARQ-02)', () => {
  const rawS = (o = {}) => ({ date: '2026-11-19', accountId: 'a1', ...o });
  /** Servidor falso: registra a intenção e responde como a camada confiável responderia. */
  const server = (responder) => {
    const calls = [];
    return { calls, finance: async (op, params, options) => { calls.push({ op, params, options }); return responder(op, params, calls.length); } };
  };

  it('antecipação: registerDebtPayment envia debt.receive e sinaliza `anticipated` pela data × vencimento da parcela', async () => {
    const api = server(() => ({ ok: true, paymentId: 'x', settled: false, remainingCents: 20000, amountCents: 10000, debtorStatus: 'open' }));
    const io = { finance: api.finance, getById: async () => ({ id: 'f1', debtorId: 'd1', dueDate: '2027-01-10' }) };
    const part = await registerDebtPayment(uid, 'f1', { amountCents: '100,00', date: '2026-11-19', accountId: 'a1', operationId: 'op-1' }, io);
    assert.deepEqual([part.ok, part.anticipated, part.debtPaid], [true, true, false]);
    assert.deepEqual(api.calls[0].params, { debtId: 'f1', amountCents: 10000, date: '2026-11-19', accountId: 'a1' });
    assert.equal(api.calls[0].options.operationId, 'op-1');
    const late = await registerDebtPayment(uid, 'f1', { amountCents: '300,00', date: '2027-01-10', accountId: 'a1' }, io);
    assert.equal(late.anticipated, false); // no vencimento não é antecipação
  });

  it('recebimento NUNCA é gravado direto: nenhuma escrita no cliente em settleInstallment/registerDebtPayment', async () => {
    const writes = [];
    const api = server(() => ({ ok: true, paymentId: 'x', settled: true, remainingCents: 0, amountCents: 30000, debtorStatus: 'paid' }));
    const io = { finance: api.finance, getById: async () => ({ id: 'p1', debtorId: 'd1' }), commitAtomic: async (...a) => { writes.push(a); return []; }, create: async (...a) => { writes.push(a); }, update: async (...a) => { writes.push(a); } };
    const r = await settleInstallment(uid, 'd1', { debtId: 'p1' }, rawS(), io);
    assert.deepEqual([r.ok, r.settled, r.debtorPaid], [true, true, true]);
    assert.deepEqual(writes, []);
  });

  it('quitar dívida (grupo) e todas: envia debt.settleBatch com o escopo; repete a chamada (mesmo operationId) até concluir', async () => {
    let n = 0;
    const api = server(() => {
      n += 1;
      return n < 3
        ? { ok: true, status: 'running', total: 3, done: n, skipped: 0, failed: 0, pending: 3 - n, receivedCents: 1000 * n, items: [] }
        : { ok: true, status: 'completed', total: 3, done: 3, skipped: 0, failed: 0, pending: 0, receivedCents: 90000, items: [] };
    });
    const r = await settleDebts(uid, 'd1', { groupId: 'g1' }, rawS({ notes: 'quitação', operationId: 'batch-1' }), { finance: api.finance, getById: async () => ({ id: 'd1', status: 'paid' }) });
    assert.deepEqual([r.ok, r.count, r.totalCents, r.debtorPaid], [true, 3, 90000, true]);
    assert.equal(api.calls.length, 3);
    assert.ok(api.calls.every((c) => c.op === 'debt.settleBatch' && c.options.operationId === 'batch-1'));
    assert.deepEqual(api.calls[0].params.scope, { groupId: 'g1' });
    const all = server(() => ({ ok: true, status: 'completed', total: 1, done: 1, skipped: 0, failed: 0, pending: 0, receivedCents: 100, items: [] }));
    await settleDebts(uid, 'd1', {}, rawS(), { finance: all.finance, getById: async () => null });
    assert.deepEqual(all.calls[0].params.scope, { all: true });
  });

  it('lote parcialmente falho: ok:false, partial, itens gravados permanecem e a mensagem diz como retomar', async () => {
    const api = server(() => ({ ok: true, status: 'partial_failed', total: 3, done: 2, skipped: 0, failed: 1, pending: 0, receivedCents: 2000, items: [] }));
    const r = await settleDebts(uid, 'd1', {}, rawS({ operationId: 'b2' }), { finance: api.finance, getById: async () => null });
    assert.deepEqual([r.ok, r.partial, r.count, r.failed], [false, true, 2, 1]);
    assert.match(r.errors._form, /Repita a operação/);
  });

  it('falha de rede NO MEIO do lote devolve partial + batchId (retomável com o mesmo operationId)', async () => {
    let n = 0;
    const api = server(() => {
      n += 1;
      return n === 1 ? { ok: true, status: 'running', total: 30, done: 15, skipped: 0, failed: 0, pending: 15, receivedCents: 1, items: [] } : { ok: false, errors: { _form: 'Falha de rede.' }, retryable: true };
    });
    const r = await settleDebts(uid, 'd1', {}, rawS({ operationId: 'b3' }), { finance: api.finance, getById: async () => null });
    assert.deepEqual([r.ok, r.partial, r.batchId], [false, true, 'b3']);
  });

  it('mês inválido e dados inválidos (conta/data) param antes do servidor', async () => {
    const api = server(() => ({ ok: true }));
    const io = { finance: api.finance };
    assert.equal((await settleMonthInstallments(uid, 'd1', '2026-13', rawS(), io)).ok, false);
    assert.ok((await settleDebts(uid, 'd1', {}, rawS({ date: '2026-02-30' }), io)).errors.date);
    assert.ok((await settleDebts(uid, 'd1', {}, { date: '2026-11-19' }, io)).errors.accountId);
    assert.deepEqual(api.calls, []);
  });
});

describe('metas vinculadas a conta (VF-2-03o)', () => {
  const ts = (ms) => ({ toMillis: () => ms });
  const g = (id, accountId, target, ms, o = {}) => ({ id, accountId, targetCents: target, status: 'active', createdAt: ts(ms), ...o });

  it('modo conta vinculada = tem conta E nenhuma movimentação', () => {
    assert.equal(isAccountLinkedGoal({ accountId: 'a' }, 0), true);
    assert.equal(isAccountLinkedGoal({ accountId: 'a' }, undefined), true);
    assert.equal(isAccountLinkedGoal({ accountId: 'a' }, 2), false); // legado com aportes
    assert.equal(isAccountLinkedGoal({}, 0), false);
  });
  it('progresso = saldo da conta; várias metas na mesma conta repartem em ordem de criação, sem duplicar', () => {
    const balances = new Map([['nu', 150000], ['inv', 40000], ['neg', -500]]);
    const out = allocateLinkedGoalBalances([
      g('b', 'nu', 100000, 2), g('a', 'nu', 100000, 1), g('c', 'inv', 90000, 1), g('n', 'neg', 100, 1),
      g('x', 'nu', 500, 3, { status: 'cancelled' }), g('l', 'nu', 700, 1, {}), g('free', undefined, 10, 1),
    ], balances, new Map([['l', 3]]));
    assert.deepEqual([...out.entries()].sort(), [['a', 100000], ['b', 50000], ['c', 40000], ['n', 0]]);
    assert.ok(out.get('a') + out.get('b') <= 150000); // nunca soma mais que o saldo
    assert.equal(out.has('x'), false); // cancelada fora
    assert.equal(out.has('l'), false); // legada (com movimentações) fora
  });
  it('aporte/resgate em meta vinculada a conta: a regra é do SERVIDOR (goal.deposit recusa); o cliente repassa o erro sem gravar', async () => {
    const atomic = [];
    const finance = async () => ({ ok: false, code: 'INVALID_STATE', errors: { _form: 'Meta vinculada a uma conta: o progresso segue o saldo dessa conta; transfira para ela em Transferências.' } });
    const io = { finance, commitAtomic: async (u, ops) => { atomic.push(ops); return []; } };
    const raw = { amountCents: '10,00', date: '2026-11-19', accountId: 'a1' };
    const r = await registerGoalTransaction(uid, 'g1', 'deposit', raw, io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /Transferências/);
    assert.equal(atomic.length, 0);
  });
});

describe('dashboard enriquecido (VF-2-03q)', () => {
  it('previsto do mês = realizado + pendentes, sem contar o mesmo lançamento duas vezes', () => {
    const f = monthForecast({ incomeCents: 100000, expenseCents: 30000 },
      [{ status: 'pending', amountCents: 20000 }, { status: 'received', amountCents: 999 }],
      [{ status: 'pending', amountCents: 5000 }, { status: 'paid', amountCents: 777 }, { status: 'cancelled', amountCents: 1 }]);
    assert.deepEqual(f, { incomeCents: 20000, expenseCents: 5000, forecastResultCents: (100000 + 20000) - (30000 + 5000) });
  });
  it('faturas do mês (aberta pelas parcelas, fechada/paga pelo gravado; canceladas fora) e limite só de cartões ativos', () => {
    const cards = [{ id: 'c1', status: 'active', limitCents: 100000 }, { id: 'c2', status: 'blocked', limitCents: 50000 }];
    const invoices = [
      { id: 'i1', cardId: 'c1', referenceMonth: '2026-11', status: 'open' },
      { id: 'i2', cardId: 'c1', referenceMonth: '2026-11', status: 'closed', totalCents: 7000 },
      { id: 'i3', cardId: 'c1', referenceMonth: '2026-11', status: 'paid', totalCents: 3000, paidCents: 3000, accountId: 'a' },
      { id: 'i4', cardId: 'c1', referenceMonth: '2026-11', status: 'cancelled' },
      { id: 'i5', cardId: 'c1', referenceMonth: '2026-12', status: 'open' },
    ];
    const purchases = [
      { cardId: 'c1', invoiceId: 'i1', amountCents: 10000 }, { cardId: 'c1', invoiceId: 'i2', amountCents: 7000 },
      { cardId: 'c1', invoiceId: 'i3', amountCents: 3000 }, { cardId: 'c1', invoiceId: 'i5', amountCents: 4000 }, { cardId: 'c2', invoiceId: 'x', amountCents: 9999 },
    ];
    const s = cardInvoicesSummary({ cards, invoices, purchases, month: '2026-11' });
    assert.deepEqual(s, { count: 3, openCents: 10000, closedCents: 7000, paidCents: 3000, dueCents: 17000, limitCents: 100000, usedCents: 21000, availableCents: 79000 });
    // fatura paga libera limite: usado = 10000 + 7000 + 4000 (i3 paga fora)
  });
  it('loadDashboard: saldo livre × vinculado a metas, previsto, faturas do mês, a receber no mês; mês selecionável', async () => {
    const tables = {
      accounts: [{ id: 'a1', status: 'active', initialBalanceCents: 100000 }, { id: 'a2', status: 'active', initialBalanceCents: 40000 }],
      goals: [{ id: 'g1', accountId: 'a2', targetCents: 30000, status: 'active' }],
      incomes: [{ status: 'pending', amountCents: 20000, expectedDate: '2026-12-05' }],
      expenses: [{ status: 'pending', amountCents: 5000, dueDate: '2026-12-10' }],
      creditCards: [{ id: 'c1', status: 'active', limitCents: 100000 }],
      invoices: [{ id: 'i1', cardId: 'c1', referenceMonth: '2026-12', status: 'open' }, { id: 'i0', cardId: 'c1', referenceMonth: '2026-12', status: 'paid', accountId: 'a1', paidCents: 1000 }],
      cardPurchases: [{ cardId: 'c1', invoiceId: 'i1', amountCents: 8000 }],
      debtors: [{ id: 'd1', status: 'open', lentCents: 50000, receivedCents: 0 }],
    };
    const calls = [];
    const io = {
      now: () => new Date('2026-11-19T12:00:00Z'), month: '2026-12',
      list: async (u, c, opts = {}) => { calls.push([c, opts]); return tables[c] ?? []; },
    };
    const d = await loadDashboard(uid, io);
    assert.equal(d.month, '2026-12');
    assert.equal(d.isCurrentMonth, false);
    assert.deepEqual(d.failed, []);
    assert.equal(d.totalBalanceCents, 100000 + 40000 - 1000); // fatura paga debita a conta a1
    assert.equal(d.linkedGoalsCents, 30000); // meta na caixinha a2 (saldo 40000, alvo 30000)
    assert.equal(d.freeBalanceCents, d.totalBalanceCents - 30000);
    assert.deepEqual(d.forecast, { incomeCents: 20000, expenseCents: 5000, forecastResultCents: 15000 });
    assert.equal(d.cardInvoices.openCents, 8000);
    assert.equal(d.cardInvoices.paidCents, 1000);
    assert.equal(d.cardInvoices.usedCents, 8000);
    assert.equal(d.debtors.pendingCents, 50000);
    assert.equal(typeof d.debtors.monthDueCents, 'number');
    const pend = calls.find(([c, o]) => c === 'expenses' && o.where?.[1]?.[0] === 'dueDate' && o.where[1][1] === '>=' && o.where[2]);
    assert.deepEqual(pend[1].where, [['status', '==', 'pending'], ['dueDate', '>=', '2026-12-01'], ['dueDate', '<=', '2026-12-31']]); // índice status+dueDate
  });
  it('falha de uma nova fonte não derruba as outras', async () => {
    const d = await silentRun(() => loadDashboard(uid, { now: () => new Date('2026-11-19T12:00:00Z'), list: async (u, c) => { if (c === 'creditCards' || c === 'goals') throw Object.assign(new Error('x'), { code: 'permission-denied' }); return c === 'accounts' ? [{ id: 'a', status: 'active', initialBalanceCents: 100 }] : []; } }));
    assert.deepEqual(d.failed.sort(), ['cardInvoices', 'goals']);
    assert.equal(d.cardInvoices, null);
    assert.equal(d.freeBalanceCents, null);
    assert.equal(d.totalBalanceCents, 100);
    assert.ok(d.forecast);
  });
});
async function silentRun(fn) { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } }

describe('assinaturas × cartão × fatura (VF-2-03r)', () => {
  const cardX = { id: 'c1', name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active' };
  const subCard = (o = {}) => ({ id: 's1', name: 'Netflix', amountCents: 5590, periodicity: 'monthly', nextChargeDate: '2026-11-05', accountId: 'a1', categoryId: 'cat', cardId: 'c1', status: 'active', ...o });
  const mk = ({ sub = subCard(), invoices = [], purchases = [] } = {}) => {
    const atomic = [];
    const updates = [];
    return {
      atomic, updates,
      io: {
        getById: async (u, c, id) => ({ subscriptions: [sub], creditCards: [cardX], categories: [{ id: 'cat', kind: 'expense' }] }[c] ?? []).find((x) => x.id === id) ?? null,
        list: async (u, c) => (c === 'invoices' ? invoices : purchases),
        commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); },
        update: async (u, c, id, data) => updates.push({ c, id, data }),
        writeAudit: async () => ({ ok: true }),
        now: () => new Date('2026-11-05T12:00:00Z'),
      },
    };
  };

  it('cobrança de assinatura no cartão: 1 parcela na fatura + avanço da data no MESMO lote; sem despesa nem escrita separada', async () => {
    const { io, atomic, updates } = mk();
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via, r.nextChargeDate], [true, 'card', '2026-12-05']);
    const ops = atomic.at(-1);
    const buy = ops.filter((o) => o.collection === 'cardPurchases');
    assert.equal(buy.length, 1);
    assert.deepEqual([buy[0].data.amountCents, buy[0].data.installmentsTotal, buy[0].data.description, buy[0].data.categoryId], [5590, 1, 'Netflix', 'cat']);
    assert.deepEqual(ops.at(-1), { type: 'update', collection: 'subscriptions', docId: 's1', data: { nextChargeDate: '2026-12-05' }, action: 'charge' });
    assert.equal(ops.some((o) => o.collection === 'expenses'), false); // sem despesa em conta
    assert.equal(updates.length, 0); // a data NÃO é gravada fora do lote
  });
  it('fatura do mês paga/fechada não é alterada: a cobrança vai para a próxima fatura aberta', async () => {
    const paid = { id: 'c1_2026-11', cardId: 'c1', referenceMonth: '2026-11', status: 'paid', totalCents: 9000 };
    const { io, atomic } = mk({ invoices: [paid] });
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.equal(r.ok, true);
    const ops = atomic.flat();
    assert.equal(ops.some((o) => o.docId === 'c1_2026-11'), false); // fatura liquidada intocada
    assert.equal(ops.find((o) => o.collection === 'cardPurchases').data.invoiceId, 'c1_2026-12');
  });
  it('cartão bloqueado/inexistente ou assinatura pausada: nada é gravado', async () => {
    const blocked = mk();
    blocked.io.getById = async (u, c, id) => (c === 'creditCards' ? { ...cardX, status: 'blocked' } : (c === 'subscriptions' ? subCard() : { id, kind: 'expense' }));
    assert.equal((await registerSubscriptionCharge(uid, 's1', blocked.io)).ok, false);
    assert.equal(blocked.atomic.length, 0);
    const paused = mk({ sub: subCard({ status: 'paused' }) });
    assert.equal((await registerSubscriptionCharge(uid, 's1', paused.io)).ok, false);
    assert.equal(paused.atomic.length, 0);
  });
  it('cadastro valida o cartão; assinatura no cartão não aparece em "próximos vencimentos" (já está na fatura)', async () => {
    const raw = { name: 'Spotify', amountCents: '21,90', periodicity: 'monthly', nextChargeDate: '2026-12-01', accountId: 'a1', categoryId: 'cat', cardId: 'zz', status: 'active' };
    const bad = await createSubscription(uid, raw, { lookupCategory: async () => ({ id: 'cat', kind: 'expense' }), lookupCard: async () => null, create: async () => 'x', writeAudit: async () => ({ ok: true }) });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.cardId);
    const good = await createSubscription(uid, { ...raw, cardId: 'c1' }, { lookupCategory: async () => ({ id: 'cat', kind: 'expense' }), lookupCard: async () => cardX, create: async () => 'x', writeAudit: async () => ({ ok: true }) });
    assert.equal(good.ok, true);
    const up = upcomingDue({ today: '2026-11-19', subscriptions: [
      { id: 'a', name: 'Direta', status: 'active', nextChargeDate: '2026-11-20', amountCents: 1000, accountId: 'a1' },
      { id: 'b', name: 'No cartão', status: 'active', nextChargeDate: '2026-11-21', amountCents: 2000, cardId: 'c1' },
    ] });
    assert.deepEqual(up.map((i) => i.label), ['Direta']);
  });
  it('consolidado de fatura: 1x na fatura do mês (dia de fechamento), só em fatura aberta/inexistente; liquidadas intactas', async () => {
    const { io, atomic } = mk();
    const ok = await registerInvoiceConsolidation(uid, 'c1', { referenceMonth: '2026-12', amountCents: '1.234,56' }, io);
    assert.equal(ok.ok, true);
    const buy = atomic.at(-1).find((o) => o.collection === 'cardPurchases').data;
    assert.deepEqual([buy.amountCents, buy.installmentsTotal, buy.invoiceId, buy.notes], [123456, 1, 'c1_2026-12', 'Lançamento consolidado da fatura']);
    assert.match(buy.description, /Consolidado da fatura 12\/2026/);
    for (const status of ['paid', 'closed', 'cancelled']) {
      const m = mk({ invoices: [{ id: 'c1_2026-12', cardId: 'c1', referenceMonth: '2026-12', status }] });
      const r = await registerInvoiceConsolidation(uid, 'c1', { referenceMonth: '2026-12', amountCents: '10,00' }, m.io);
      assert.equal(r.ok, false, status);
      assert.ok(r.errors.referenceMonth);
      assert.equal(m.atomic.length, 0);
    }
    const open = mk({ invoices: [{ id: 'c1_2026-12', cardId: 'c1', referenceMonth: '2026-12', status: 'open' }] });
    assert.equal((await registerInvoiceConsolidation(uid, 'c1', { referenceMonth: '2026-12', amountCents: '10,00', description: 'Mercado' }, open.io)).ok, true);
    assert.equal((await registerInvoiceConsolidation(uid, 'c1', { referenceMonth: '2026-13', amountCents: '10,00' }, mk().io)).ok, false);
    assert.equal((await registerInvoiceConsolidation(uid, 'zz', { referenceMonth: '2026-12', amountCents: '10,00' }, { ...mk().io, getById: async () => null })).ok, false);
  });
  it('delta do consolidado = extrato − já lançado (devedores, assinaturas, avulsos), em centavos inteiros', () => {
    assert.equal(consolidationDeltaCents(30000, 100000), 70000);
    assert.equal(consolidationDeltaCents(100000, 100000), null);
    assert.equal(consolidationDeltaCents(120000, 100000), null);
    assert.equal(consolidationDeltaCents(1.5, 100), null);
  });
  it('excluir cartão com assinaturas vinculadas é bloqueado', async () => {
    const r = await deleteCard(uid, 'c1', { getById: async () => cardX, list: async () => [], count: async (u, c) => (c === 'subscriptions' ? 1 : 0) });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /1 assinaturas/);
  });
});

describe('devedor QUITADO pode receber nova dívida e nova compra (reabre no mesmo lote)', () => {
  const paid = () => debtor({ lentCents: 100000, receivedCents: 100000, status: 'paid' });

  it('nova dívida parcelada: lança as parcelas, soma ao emprestado e volta a `open`', async () => {
    const atomic = [];
    const io = { getById: async () => paid(), commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => `n${i}`); }, groupId: () => 'g' };
    const r = await createDebtPlan(uid, { debtorId: 'd1', description: 'Nova', totalCents: '300,00', installments: 3, firstDueDate: '2026-12-10' }, io);
    assert.equal(r.ok, true);
    assert.equal(atomic[0].filter((o) => o.collection === 'debts').length, 3);
    assert.deepEqual(atomic[0].at(-1), { type: 'update', collection: 'debtors', docId: 'd1', action: 'debt-plan', data: { status: 'open' }, increments: { lentCents: 30000 } });
  });

  it('devedor cancelado continua barrado, com mensagem para reabrir', async () => {
    const io = { getById: async () => debtor({ status: 'cancelled' }), commitAtomic: async () => { throw new Error('não deveria gravar'); } };
    const r = await createDebtPlan(uid, { debtorId: 'd1', description: 'Nova', totalCents: '10,00', installments: 1, firstDueDate: '2026-12-10' }, io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /Reabra o devedor cancelado/);
  });

  it('nova compra de cartão vinculada reabre o quitado no mesmo lote', async () => {
    const { io, atomic } = makeIo({ debtors: [paid()] });
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    const upd = atomic.at(-1).find((o) => o.collection === 'debtors');
    assert.deepEqual([upd.data, upd.increments], [{ status: 'open' }, { lentCents: 30000 }]);
  });

  it('depois de reaberto o recebimento volta a funcionar (devedor open aceita pagamento)', () => {
    assert.equal(applyPaymentToDebtor(paid(), 100).ok, false); // quitado: nada a receber
    assert.deepEqual(applyPaymentToDebtor({ ...paid(), lentCents: 130000, status: 'open' }, 30000), { ok: true, receivedCents: 130000, status: 'paid' });
  });
});
