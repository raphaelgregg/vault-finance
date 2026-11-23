/**
 * Testes de Parcelas e Recebimentos de devedores (VF-2-03b2): modelo, fluxo atômico e transições.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebt,
  cancelDebt,
  cancelDebts,
  CANCEL_MANY_MAX,
  registerDebtPayment,
  getDebtStatusOptions,
} from '../../js/services/debtPayments.js';
import {
  SCHEMAS,
  validateEntity,
  applyPaymentToDebtor,
  accountBalances,
} from '../../js/core/model.js';
import { commitAtomic } from '../../js/services/firestore.js';

const uid = 'u1';
const debtor = (over = {}) => ({ id: 'dev1', status: 'open', lentCents: 100000, receivedCents: 0, ...over });
const debt = (over = {}) => ({ id: 'd1', debtorId: 'dev1', principalCents: 50000, status: 'pending', ...over });
const account = (over = {}) => ({ id: 'acc1', status: 'active', ...over });
const rawPay = (over = {}) => ({ amountCents: '500,00', date: '2026-11-18', accountId: 'acc1', ...over });

function makeIo({ debts = [debt()], debtors = [debtor()], accounts = [account()], payments = [], listDebts = [] } = {}) {
  const calls = { atomic: [], update: [], create: [], audit: [] };
  const io = {
    getById: async (u, c, id) => {
      const table = { debts, debtors, accounts }[c] ?? [];
      return table.find((x) => x.id === id) ?? null;
    },
    list: async (u, c) => (c === 'debtPayments' ? payments : listDebts),
    commitAtomic: async (u, ops) => { calls.atomic.push(ops); return ['pay1']; },
    create: async (u, c, data) => { calls.create.push({ c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
    writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
  };
  return { io, calls };
}

describe('debts/debtPayments — schema', () => {
  it('chaves e datas espelham as Rules', () => {
    assert.deepEqual(Object.keys(SCHEMAS.debts.fields).sort(),
      ['debtGroupId', 'debtorId', 'description', 'dueDate', 'installmentNumber', 'installmentsTotal', 'principalCents', 'status']);
    assert.deepEqual(Object.keys(SCHEMAS.debtPayments.fields).sort(),
      ['accountId', 'amountCents', 'date', 'debtId', 'debtorId', 'notes', 'operationId', 'purchaseId']);
    assert.deepEqual(SCHEMAS.debts.dateFields, ['dueDate']);
    assert.deepEqual(getDebtStatusOptions().map((o) => o.value), ['pending', 'paid', 'late', 'cancelled']);
  });

  it('installmentNumber: inteiro 1..360', () => {
    const base = { debtorId: 'x', description: 'P1', principalCents: 100, dueDate: '2026-12-01', status: 'pending' };
    for (const n of [0, 361, 1.5, 'abc']) {
      assert.ok(validateEntity('debts', { ...base, installmentNumber: n }).errors.installmentNumber, String(n));
    }
    assert.equal(validateEntity('debts', { ...base, installmentNumber: 360 }).ok, true);
  });
});

describe('applyPaymentToDebtor (puro)', () => {
  it('parcial mantém open; total quita; excesso e inválidos rejeitados', () => {
    assert.deepEqual(applyPaymentToDebtor(debtor(), 30000), { ok: true, receivedCents: 30000, status: 'open' });
    assert.deepEqual(applyPaymentToDebtor(debtor({ receivedCents: 30000 }), 70000), { ok: true, receivedCents: 100000, status: 'paid' });
    assert.equal(applyPaymentToDebtor(debtor(), 100001).ok, false);
    assert.equal(applyPaymentToDebtor(debtor(), 0).ok, false);
    assert.equal(applyPaymentToDebtor(debtor(), 10.5).ok, false);
    assert.equal(applyPaymentToDebtor(debtor({ status: 'cancelled' }), 100).ok, false);
    assert.equal(applyPaymentToDebtor(debtor({ status: 'paid', receivedCents: 100000 }), 1).ok, false);
  });
});

describe('createDebt', () => {
  it('cria pendente, numera sequencialmente e audita', async () => {
    const { io, calls } = makeIo({ listDebts: [{ installmentNumber: 1 }, { installmentNumber: 2 }] });
    const r = await createDebt(uid, { debtorId: 'dev1', description: 'Parcela', principalCents: '500,00', dueDate: '2026-12-10' }, io);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.create[0].data, {
      debtorId: 'dev1', description: 'Parcela', principalCents: 50000, dueDate: '2026-12-10', installmentNumber: 3, status: 'pending',
    });
    assert.equal(calls.audit[0].action, 'create');
  });

  it('ignora status enviado, rejeita devedor inexistente/não aberto', async () => {
    const { io, calls } = makeIo({ debtors: [debtor({ status: 'cancelled' })] });
    const bad = await createDebt(uid, { debtorId: 'dev1', description: 'x', principalCents: '1', dueDate: '2026-12-10' }, io);
    assert.equal(bad.ok, false);
    const none = await createDebt(uid, { debtorId: 'zzz', description: 'x', principalCents: '1', dueDate: '2026-12-10' }, io);
    assert.ok(none.errors.debtorId);
    assert.equal(calls.create.length, 0);
    const { io: io2, calls: c2 } = makeIo();
    await createDebt(uid, { debtorId: 'dev1', description: 'x', principalCents: '1', dueDate: '2026-12-10', installmentNumber: 2, status: 'paid' }, io2);
    assert.equal(c2.create[0].data.status, 'pending');
  });
});

describe('registerDebtPayment — camada confiável (VF-ARQ-02)', () => {
  const server = (response) => {
    const calls = [];
    return { calls, finance: async (op, params, options) => { calls.push({ op, params, options }); return typeof response === 'function' ? response(op, params) : response; } };
  };
  const ok = (over = {}) => ({ ok: true, paymentId: 'pay1', debtId: 'd1', debtorId: 'dev1', amountCents: 50000, settled: true, remainingCents: 0, debtorStatus: 'paid', debtorReceivedCents: 50000, accountId: 'acc1', ...over });

  it('envia debt.receive (centavos inteiros, operationId) e NÃO grava nada no cliente; devolve o resultado confirmado', async () => {
    const { io, calls } = makeIo();
    const api = server(ok());
    const r = await registerDebtPayment(uid, 'd1', rawPay({ operationId: 'op-1' }), { ...io, finance: api.finance });
    assert.deepEqual([r.ok, r.id, r.debtPaid, r.debtorPaid], [true, 'pay1', true, true]);
    assert.deepEqual(api.calls.map((c) => [c.op, c.params, c.options.operationId]), [['debt.receive', { debtId: 'd1', amountCents: 50000, date: '2026-11-18', accountId: 'acc1' }, 'op-1']]);
    assert.equal(calls.atomic.length + calls.create.length + calls.update.length, 0);
  });

  it('recebimento parcial: parcela e devedor seguem abertos (resultado do servidor)', async () => {
    const api = server(ok({ amountCents: 20000, settled: false, remainingCents: 30000, debtorStatus: 'open', debtorReceivedCents: 20000 }));
    const r = await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '200,00' }), { ...makeIo().io, finance: api.finance });
    assert.deepEqual([r.ok, r.debtPaid, r.debtorPaid, r.remainingCents], [true, false, false, 30000]);
    assert.equal(api.calls[0].params.amountCents, 20000);
  });

  it('excesso e demais regras (parcela paga/cancelada, devedor fechado, conta inativa) são do servidor: erro identificável, sem escrita', async () => {
    const m = makeIo();
    for (const [code, message] of [['EXCEEDS_REMAINING', 'O valor excede o restante da parcela.'], ['INVALID_STATE', 'Esta parcela já foi quitada.'], ['EXCEEDS_DEBT', 'O valor excede o pendente do devedor.'], ['ACCOUNT_NOT_ACTIVE', 'A conta precisa estar ativa.']]) {
      const api = server({ ok: false, code, errors: { _form: message } });
      const r = await registerDebtPayment(uid, 'd1', rawPay(), { ...m.io, finance: api.finance });
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.equal(code === 'EXCEEDS_REMAINING' ? r.errors.amountCents : r.errors._form, message);
    }
    assert.equal(m.calls.atomic.length, 0);
  });

  it('parcela inexistente, valor zero e data inválida não chegam ao servidor', async () => {
    const api = server(ok());
    const m = makeIo();
    assert.equal((await registerDebtPayment(uid, 'zzz', rawPay(), { ...m.io, finance: api.finance })).ok, false);
    assert.ok((await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '0' }), { ...m.io, finance: api.finance })).errors.amountCents);
    assert.ok((await registerDebtPayment(uid, 'd1', rawPay({ date: '18/11/2026' }), { ...m.io, finance: api.finance })).errors.date);
    assert.deepEqual(api.calls, []);
  });

  it('o cliente não envia saldo, total recebido, status nem uid', async () => {
    const api = server(ok());
    await registerDebtPayment(uid, 'd1', rawPay(), { ...makeIo().io, finance: api.finance });
    for (const forbidden of ['balanceCents', 'receivedCents', 'status', 'uid', 'userId', 'debtorId']) assert.equal(forbidden in api.calls[0].params, false, forbidden);
  });
});

describe('cancelDebt', () => {
  it('cancela no servidor (debt.cancel); recusa com recebimentos vem do servidor', async () => {
    const calls = [];
    const finance = async (op, params) => { calls.push([op, params]); return { ok: true, debtId: 'd1', status: 'cancelled' }; };
    const m = makeIo();
    assert.equal((await cancelDebt(uid, 'd1', { ...m.io, finance })).ok, true);
    assert.deepEqual(calls, [['debt.cancel', { debtId: 'd1' }]]);
    assert.equal(m.calls.update.length + m.calls.audit.length, 0);
    const refused = await cancelDebt(uid, 'd1', { ...m.io, finance: async () => ({ ok: false, code: 'INVALID_STATE', errors: { _form: 'A parcela já possui recebimentos e não pode ser cancelada.' } }) });
    assert.deepEqual([refused.ok, refused.code], [false, 'INVALID_STATE']);
  });
});

describe('cancelDebts (várias parcelas em 1 requisição)', () => {
  it('envia UMA chamada debt.cancelMany com os ids únicos e a operationId; o cliente não grava nada', async () => {
    const calls = [];
    const finance = async (op, params, opts) => { calls.push([op, params, opts.operationId]); return { ok: true, count: 3, status: 'cancelled' }; };
    const m = makeIo();
    const r = await cancelDebts(uid, ['p1', 'p2', 'p2', 'p3'], { ...m.io, finance, operationId: 'op-12345678' });
    assert.deepEqual([r.ok, r.count, r.operationId], [true, 3, 'op-12345678']);
    assert.deepEqual(calls, [['debt.cancelMany', { debtIds: ['p1', 'p2', 'p3'] }, 'op-12345678']]);
    assert.equal(m.calls.update.length + m.calls.create.length + m.calls.atomic.length + m.calls.audit.length, 0);
  });

  it('recusa do servidor (tudo ou nada) é devolvida com a mensagem e o código', async () => {
    const finance = async () => ({ ok: false, code: 'INVALID_STATE', errors: { _form: 'Há parcela selecionada com recebimentos.' } });
    const r = await cancelDebts(uid, ['p1', 'p2'], { ...makeIo().io, finance });
    assert.deepEqual([r.ok, r.code, r.errors._form], [false, 'INVALID_STATE', 'Há parcela selecionada com recebimentos.']);
  });

  it('seleção vazia ou acima do teto: recusa sem chamar o servidor', async () => {
    let called = false;
    const io = { ...makeIo().io, finance: async () => { called = true; return { ok: true }; } };
    assert.equal((await cancelDebts(uid, [], io)).ok, false);
    assert.equal((await cancelDebts(uid, Array.from({ length: CANCEL_MANY_MAX + 1 }, (_, i) => `p${i}`), io)).ok, false);
    assert.equal(called, false);
  });
});

describe('commitAtomic (lote)', () => {
  it('monta set/update + auditoria no mesmo lote e commita uma vez; datas em Timestamp', async () => {
    const log = [];
    let n = 0;
    const batch = {
      set: (ref, data) => log.push(['set', ref.path, data]),
      update: (ref, data) => log.push(['update', ref.path, data]),
      commit: async () => log.push(['commit']),
    };
    const io = {
      newBatch: () => batch,
      userDoc: (u, c, id) => ({ id, path: `${c}/${id}` }),
      newDocRef: (u, c) => ({ id: `n${++n}`, path: `${c}/n${n}` }),
    };
    const ids = await commitAtomic(uid, [
      { type: 'create', collection: 'debtPayments', data: { amountCents: 100, date: '2026-11-18' } },
      { type: 'update', collection: 'debtors', docId: 'dev1', data: { receivedCents: 100 }, action: 'receive' },
    ], io);
    assert.deepEqual(ids, ['n1', 'dev1']);
    assert.deepEqual(log.map((l) => l[0]), ['set', 'set', 'update', 'set', 'commit']);
    assert.equal(log[0][2].date.toDate().toISOString(), '2026-11-18T12:00:00.000Z');
    assert.equal(log[1][2].action, 'create');
    assert.equal(log[1][2].entity, 'debtPayments');
    assert.equal(log[3][2].action, 'receive');
  });
});

describe('accountBalances com recebimentos', () => {
  it('soma debtPayments na conta de destino', () => {
    const b = accountBalances([{ id: 'a', initialBalanceCents: 1000 }], { debtPayments: [{ accountId: 'a', amountCents: 500 }] });
    assert.equal(b.get('a'), 1500);
  });
});
