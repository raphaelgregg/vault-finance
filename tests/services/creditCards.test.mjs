/**
 * Testes de Cartões, Compras e Faturas (VF-2-03d): modelo, ciclo de fatura, limite, lote atômico.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCard, updateCard, deleteCard, setCardStatus, cancelCard, blockCard, unblockCard,
  registerCardPurchase, deleteCardPurchase, updateCardPurchase, closeInvoice, payInvoice, cancelInvoice, deleteInvoice, getCardLimitUsage,
  getCardStatusOptions, getInvoiceStatusOptions,
} from '../../js/services/creditCards.js';
import {
  SCHEMAS, validateEntity, addMonths, clampDayInMonth, invoiceDatesFor, invoiceMonthForPurchase,
  splitInstallments, cardLimitUsage, invoiceTotalCents,
} from '../../js/core/model.js';
import { toFirestoreData } from '../../js/services/firestore.js';

const uid = 'u1';
const card = (o = {}) => ({ id: 'c1', name: 'Nubank', brand: 'Mastercard', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active', ...o });
const inv = (o = {}) => ({ id: 'c1_2026-11', cardId: 'c1', referenceMonth: '2026-11', status: 'open', ...o });
const rawCard = (o = {}) => ({ name: ' Nubank ', brand: 'Mastercard', limitCents: '5.000,00', closingDay: '10', dueDay: 17, ...o });
const rawBuy = (o = {}) => ({ description: 'Notebook', amountCents: '1.000,00', purchaseDate: '2026-11-05', ...o });

function makeIo({ cards = [card()], invoices = [], purchases = [], accounts = [], categories = [], linked = 0, now = '2026-11-18' } = {}) {
  const calls = { atomic: [], create: [], update: [], remove: [], audit: [] };
  const io = {
    getById: async (u, c, id) => ({ creditCards: cards, invoices, cardPurchases: purchases, accounts, categories }[c] ?? []).find((x) => x.id === id) ?? null,
    list: async (u, c, opts) => {
      if (c === 'cardPurchases') {
        const [[field, , value]] = opts.where;
        return purchases.filter((p) => p[field] === value);
      }
      return invoices;
    },
    count: async () => linked,
    commitAtomic: async (u, ops) => { calls.atomic.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); },
    create: async (u, c, data) => { calls.create.push({ c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ c, id }); },
    writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
    now: () => new Date(`${now}T12:00:00Z`),
  };
  return { io, calls };
}

describe('schemas (espelham as Rules)', () => {
  it('chaves, enums e datas', () => {
    assert.deepEqual(Object.keys(SCHEMAS.creditCards.fields).sort(), ['accountId', 'brand', 'closingDay', 'color', 'dueDay', 'limitCents', 'name', 'status']);
    assert.deepEqual(Object.keys(SCHEMAS.cardPurchases.fields).sort(),
      ['amountCents', 'cardId', 'categoryId', 'debtorId', 'description', 'installmentNumber', 'installmentsTotal', 'invoiceId', 'notes', 'purchaseDate']);
    assert.deepEqual(Object.keys(SCHEMAS.invoices.fields).sort(), ['accountId', 'cardId', 'closingDate', 'dueDate', 'paidAt', 'paidCents', 'referenceMonth', 'status', 'totalCents']);
    assert.deepEqual(SCHEMAS.invoices.dateFields, ['closingDate', 'dueDate', 'paidAt']);
    assert.deepEqual(getCardStatusOptions().map((o) => o.value), ['active', 'blocked', 'cancelled']);
    assert.deepEqual(getInvoiceStatusOptions().map((o) => o.value), ['open', 'closed', 'paid', 'cancelled']);
  });
  it('valida dias 1..31, limite, parcelas 1..48 e referenceMonth', () => {
    const c = { name: 'A', brand: 'B', limitCents: 100, closingDay: 10, dueDay: 17, status: 'active' };
    assert.equal(validateEntity('creditCards', c).ok, true);
    for (const d of [0, 32, 1.5]) assert.ok(validateEntity('creditCards', { ...c, closingDay: d }).errors.closingDay);
    assert.ok(validateEntity('creditCards', { ...c, limitCents: 0 }).errors.limitCents);
    const p = { cardId: 'c', description: 'x', amountCents: 100, purchaseDate: '2026-11-05', installmentsTotal: 3, installmentNumber: 3 };
    assert.equal(validateEntity('cardPurchases', p).ok, true);
    assert.ok(validateEntity('cardPurchases', { ...p, installmentNumber: 4 }).errors.installmentNumber);
    assert.ok(validateEntity('cardPurchases', { ...p, installmentsTotal: 49 }).errors.installmentsTotal);
    const i = { cardId: 'c', referenceMonth: '2026-11', dueDate: '2026-11-17', status: 'open' };
    assert.equal(validateEntity('invoices', i).ok, true);
    for (const m of ['2026-13', '2026-1', '11/2026']) assert.ok(validateEntity('invoices', { ...i, referenceMonth: m }).errors.referenceMonth, m);
    assert.ok(validateEntity('invoices', { ...i, totalCents: -1 }).errors.totalCents);
  });
});

describe('puros do ciclo', () => {
  it('addMonths e clampDayInMonth', () => {
    assert.equal(addMonths('2026-11', 2), '2027-01');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(addMonths('x', 1), null);
    assert.equal(clampDayInMonth('2026-02', 31), '2026-02-28');
    assert.equal(clampDayInMonth('2028-02', 31), '2028-02-29');
  });
  it('invoiceDatesFor: vence no mesmo mês se dueDay > closingDay; senão no seguinte', () => {
    assert.deepEqual(invoiceDatesFor(card(), '2026-11'), { closingDate: '2026-11-10', dueDate: '2026-11-17' });
    assert.deepEqual(invoiceDatesFor(card({ closingDay: 25, dueDay: 5 }), '2026-12'), { closingDate: '2026-12-25', dueDate: '2027-01-05' });
    assert.deepEqual(invoiceDatesFor(card({ closingDay: 31, dueDay: 10 }), '2026-02'), { closingDate: '2026-02-28', dueDate: '2026-03-10' });
  });
  it('invoiceMonthForPurchase: no fechamento ainda conta; depois vai para o mês seguinte', () => {
    assert.equal(invoiceMonthForPurchase(card(), '2026-11-10'), '2026-11');
    assert.equal(invoiceMonthForPurchase(card(), '2026-11-11'), '2026-12');
    assert.equal(invoiceMonthForPurchase(card(), '2026-12-20'), '2027-01');
    assert.equal(invoiceMonthForPurchase(card({ closingDay: 31 }), '2026-02-28'), '2026-02');
    assert.equal(invoiceMonthForPurchase(card(), '2026-02-30'), null);
  });
  it('splitInstallments: resto na primeira, soma exata', () => {
    assert.deepEqual(splitInstallments(10000, 3), [3334, 3333, 3333]);
    assert.equal(splitInstallments(100, 1)[0], 100);
    assert.equal(splitInstallments(2, 3), null);
  });
  it('cardLimitUsage ignora faturas pagas/canceladas; invoiceTotalCents soma', () => {
    const purchases = [{ amountCents: 100, invoiceId: 'a' }, { amountCents: 200, invoiceId: 'b' }, { amountCents: 50 }];
    const r = cardLimitUsage({ limitCents: 1000 }, purchases, [{ id: 'a', status: 'paid' }, { id: 'b', status: 'closed' }]);
    assert.deepEqual(r, { usedCents: 250, availableCents: 750 });
    assert.equal(cardLimitUsage({ limitCents: 100 }, [{ amountCents: 500 }], []).availableCents, 0);
    assert.equal(invoiceTotalCents(purchases), 350);
  });
});

describe('cartões — CRUD e status', () => {
  it('cria ativo, ignora status enviado, normaliza e audita', async () => {
    const { io, calls } = makeIo({ accounts: [{ id: 'acc1' }] });
    const r = await createCard(uid, rawCard({ status: 'cancelled', accountId: 'acc1' }), io);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.create[0].data, { name: 'Nubank', brand: 'Mastercard', limitCents: 500000, closingDay: 10, dueDay: 17, accountId: 'acc1', status: 'active' });
    assert.equal(calls.audit[0].action, 'create');
  });
  it('rejeita conta inexistente e dados inválidos', async () => {
    const { io, calls } = makeIo();
    assert.ok((await createCard(uid, rawCard({ accountId: 'zz' }), io)).errors.accountId);
    assert.ok((await createCard(uid, rawCard({ closingDay: 40 }), io)).errors.closingDay);
    assert.equal(calls.create.length, 0);
  });
  it('edita preservando status e rejeita limite abaixo do usado e cartão cancelado', async () => {
    const purchases = [{ id: 'p', cardId: 'c1', amountCents: 300000, invoiceId: 'c1_2026-11' }];
    const m = makeIo({ purchases, invoices: [inv()] });
    assert.equal((await updateCard(uid, 'c1', rawCard({ limitCents: '3.000,00' }), m.io)).ok, true);
    assert.equal(m.calls.update[0].data.status, 'active');
    assert.ok((await updateCard(uid, 'c1', rawCard({ limitCents: '2.999,99' }), m.io)).errors.limitCents);
    assert.equal((await updateCard(uid, 'c1', rawCard(), makeIo({ cards: [card({ status: 'cancelled' })] }).io)).ok, false);
  });
  it('bloqueia/desbloqueia/cancela; cancelado é terminal; cancelar exige limite livre', async () => {
    const a = makeIo();
    assert.equal((await blockCard(uid, 'c1', a.io)).ok, true);
    assert.equal(a.calls.audit[0].action, 'block');
    const b = makeIo({ cards: [card({ status: 'blocked' })] });
    assert.equal((await unblockCard(uid, 'c1', b.io)).ok, true);
    assert.equal(b.calls.audit[0].action, 'unblock');
    assert.equal((await cancelCard(uid, 'c1', a.io)).ok, true);
    assert.equal((await unblockCard(uid, 'c1', makeIo({ cards: [card({ status: 'cancelled' })] }).io)).ok, false);
    const used = makeIo({ purchases: [{ cardId: 'c1', amountCents: 100, invoiceId: 'c1_2026-11' }], invoices: [inv()] });
    assert.equal((await cancelCard(uid, 'c1', used.io)).ok, false);
    assert.equal(used.calls.update.length, 0);
    assert.equal((await setCardStatus(uid, 'c1', 'x', a.io)).ok, false);
  });
  it('exclusão: bloqueia com vínculos e fail-closed; exclui quando livre', async () => {
    const ok = makeIo({ invoices: [] });
    assert.equal((await deleteCard(uid, 'c1', ok.io)).ok, true);
    assert.deepEqual(ok.calls.atomic.at(-1).map((o) => [o.type, o.collection, o.docId]), [['delete', 'creditCards', 'c1']]);
    assert.match((await deleteCard(uid, 'c1', makeIo({ linked: 2, invoices: [] }).io)).errors._form, /compras/);
    const f = makeIo();
    f.io.count = async () => { throw new Error('x'); };
    const orig = console.error; console.error = () => {};
    const r = await deleteCard(uid, 'c1', f.io);
    console.error = orig;
    assert.equal(r.ok, false);
    assert.equal(f.calls.remove.length, 0);
  });
  it('getCardLimitUsage derivado', async () => {
    const m = makeIo({ purchases: [{ cardId: 'c1', amountCents: 120000, invoiceId: 'c1_2026-11' }], invoices: [inv()] });
    assert.deepEqual(await getCardLimitUsage(uid, 'c1', m.io), { usedCents: 120000, availableCents: 380000 });
    assert.equal(await getCardLimitUsage(uid, 'zz', m.io), null);
  });
});

describe('exclusão de cartão e fatura (VF-2-03t)', () => {
  const invC = (o = {}) => inv({ id: 'c1_2026-10', referenceMonth: '2026-10', ...o });
  it('faturas canceladas/zeradas NÃO bloqueiam: saem junto com o cartão, no mesmo lote, com auditoria', async () => {
    const invoices = [invC({ status: 'cancelled', totalCents: 0 }), invC({ id: 'c1_2026-11', status: 'cancelled' }), invC({ id: 'c1_2026-12', status: 'open' }), invC({ id: 'c1_2027-01', status: 'closed', totalCents: 0 })];
    const m = makeIo({ invoices, linked: 0 });
    const r = await deleteCard(uid, 'c1', m.io);
    assert.deepEqual([r.ok, r.removedInvoices], [true, 4]);
    assert.deepEqual(m.calls.atomic.at(-1).map((o) => `${o.collection}:${o.docId}`), ['invoices:c1_2026-10', 'invoices:c1_2026-11', 'invoices:c1_2026-12', 'invoices:c1_2027-01', 'creditCards:c1']);
    assert.equal(m.calls.remove.length, 0); // nada fora do lote
  });
  it('mantém o bloqueio: compras, assinaturas vinculadas, fatura fechada/paga COM movimentação; leitura falha = fail-closed', async () => {
    const blockers = [
      [makeIo({ linked: 3, invoices: [] }), /3 compras/],
      [makeIo({ invoices: [invC({ status: 'paid', totalCents: 5000, paidCents: 5000 })] }), /1 faturas com movimentação/],
      [makeIo({ invoices: [invC({ status: 'closed', totalCents: 100 })] }), /faturas com movimentação/],
    ];
    for (const [m, re] of blockers) {
      assert.match((await deleteCard(uid, 'c1', m.io)).errors._form, re);
      assert.equal(m.calls.atomic.length, 0);
    }
    const subs = makeIo({ invoices: [] });
    subs.io.count = async (u, c) => (c === 'subscriptions' ? 2 : 0);
    assert.match((await deleteCard(uid, 'c1', subs.io)).errors._form, /2 assinaturas/);
    const f = makeIo({ invoices: [] });
    f.io.list = async () => { throw new Error('x'); };
    const orig = console.error; console.error = () => {};
    assert.equal((await deleteCard(uid, 'c1', f.io)).ok, false);
    console.error = orig;
    assert.equal(f.calls.atomic.length, 0);
  });
  it('excluir fatura: cancelada ou aberta vazia, definitivamente e no lote; bloqueia com compras, fechada/paga e leitura falha', async () => {
    for (const status of ['cancelled', 'open']) {
      const m = makeIo({ invoices: [invC({ status })], linked: 0 });
      assert.deepEqual(await deleteInvoice(uid, 'c1_2026-10', m.io), { ok: true });
      assert.deepEqual(m.calls.atomic.at(-1), [{ type: 'delete', collection: 'invoices', docId: 'c1_2026-10', before: invC({ status }) }]);
    }
    for (const mk of [makeIo({ invoices: [invC({ status: 'cancelled' })], linked: 2 }), makeIo({ invoices: [invC({ status: 'paid', totalCents: 1 })] }), makeIo({ invoices: [invC({ status: 'closed' })] }), makeIo({ invoices: [] })]) {
      assert.equal((await deleteInvoice(uid, 'c1_2026-10', mk.io)).ok, false);
      assert.equal(mk.calls.atomic.length, 0);
    }
    const f = makeIo({ invoices: [invC({ status: 'cancelled' })] });
    f.io.count = async () => { throw new Error('x'); };
    const orig = console.error; console.error = () => {};
    assert.equal((await deleteInvoice(uid, 'c1_2026-10', f.io)).ok, false);
    console.error = orig;
  });
  it('excluir a fatura cancelada libera o mês: nova compra cria a fatura do mês em vez de pular para o seguinte', async () => {
    const withCancelled = makeIo({ invoices: [invC({ id: 'c1_2026-11', referenceMonth: '2026-11', status: 'cancelled' })] });
    await registerCardPurchase(uid, 'c1', rawBuy({ purchaseDate: '2026-11-05' }), withCancelled.io);
    assert.equal(withCancelled.calls.atomic.flat().find((o) => o.collection === 'cardPurchases').data.invoiceId, 'c1_2026-12'); // pulou (comportamento antigo)
    const freed = makeIo({ invoices: [] });
    await registerCardPurchase(uid, 'c1', rawBuy({ purchaseDate: '2026-11-05' }), freed.io);
    assert.equal(freed.calls.atomic.flat().find((o) => o.collection === 'cardPurchases').data.invoiceId, 'c1_2026-11');
  });
});

describe('registerCardPurchase — lotes atômicos', () => {
  it('falha no lote de parcelas após criar faturas: erro propaga e faturas ficam abertas/reutilizáveis', async () => {
    const { io, calls } = makeIo();
    let n = 0;
    io.commitAtomic = async (u, ops) => { calls.atomic.push(ops); if (++n === 2) throw new Error('falha'); return ops.map((o) => o.docId); };
    await assert.rejects(registerCardPurchase(uid, 'c1', rawBuy(), io), /falha/);
    assert.equal(calls.atomic.length, 2);
  });
  it('compra à vista: cria a fatura do ciclo (lote 1) e a parcela (lote 2)', async () => {
    const { io, calls } = makeIo();
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    assert.equal(calls.atomic.length, 2);
    const [[invoiceOp], [purchaseOp]] = calls.atomic;
    assert.deepEqual(invoiceOp, { type: 'create', collection: 'invoices', docId: 'c1_2026-11',
      data: { cardId: 'c1', referenceMonth: '2026-11', closingDate: '2026-11-10', dueDate: '2026-11-17', status: 'open' } });
    assert.deepEqual(purchaseOp.data, { cardId: 'c1', description: 'Notebook', amountCents: 100000, purchaseDate: '2026-11-05',
      installmentsTotal: 1, installmentNumber: 1, invoiceId: 'c1_2026-11' });
    assert.equal(calls.create.length + calls.update.length, 0);
  });
  it('após o fechamento vai para a fatura seguinte; reutiliza fatura aberta existente', async () => {
    const { io, calls } = makeIo({ invoices: [inv({ id: 'xyz', referenceMonth: '2026-12' })] });
    await registerCardPurchase(uid, 'c1', rawBuy({ purchaseDate: '2026-11-11' }), io);
    assert.equal(calls.atomic.length, 1); // sem fatura nova: só o lote de parcelas
    assert.equal(calls.atomic[0].length, 1);
    assert.equal(calls.atomic[0][0].data.invoiceId, 'xyz');
  });
  it('parcelado 3x: valores somam o total, números 1..3, uma fatura por mês', async () => {
    const { io, calls } = makeIo();
    const r = await registerCardPurchase(uid, 'c1', rawBuy({ amountCents: '100,00', installmentsTotal: 3, categoryId: undefined }), io);
    assert.equal(r.ok, true);
    const [invoices, purchases] = calls.atomic;
    assert.ok(invoices.every((o) => o.collection === 'invoices'));
    assert.ok(purchases.every((o) => o.collection === 'cardPurchases'));
    assert.deepEqual(invoices.map((o) => o.data.referenceMonth), ['2026-11', '2026-12', '2027-01']);
    assert.deepEqual(purchases.map((o) => o.data.amountCents), [3334, 3333, 3333]);
    assert.deepEqual(purchases.map((o) => o.data.installmentNumber), [1, 2, 3]);
    assert.ok(purchases.every((o) => o.data.installmentsTotal === 3));
    assert.deepEqual(r.invoiceMonths, ['c1_2026-11', 'c1_2026-12', 'c1_2027-01']);
  });
  it('pula faturas fechadas/pagas e mantém as parcelas em meses crescentes', async () => {
    const { io, calls } = makeIo({ invoices: [inv({ status: 'closed' })] });
    await registerCardPurchase(uid, 'c1', rawBuy({ installmentsTotal: 2 }), io);
    const months = calls.atomic[0].map((o) => o.data.referenceMonth);
    assert.deepEqual(months, ['2026-12', '2027-01']);
  });
  it('valida categoria (despesa/ambos) quando informada', async () => {
    const okIo = makeIo({ categories: [{ id: 'cat1', kind: 'expense' }] });
    assert.equal((await registerCardPurchase(uid, 'c1', rawBuy({ categoryId: 'cat1' }), okIo.io)).ok, true);
    assert.equal(okIo.calls.atomic.at(-1)[0].data.categoryId, 'cat1');
    const bad = makeIo({ categories: [{ id: 'cat1', kind: 'income' }] });
    assert.ok((await registerCardPurchase(uid, 'c1', rawBuy({ categoryId: 'cat1' }), bad.io)).errors.categoryId);
    assert.ok((await registerCardPurchase(uid, 'c1', rawBuy({ categoryId: 'zz' }), makeIo().io)).errors.categoryId);
  });
  it('respeita o limite disponível (compras em faturas não pagas contam)', async () => {
    const purchases = [{ cardId: 'c1', amountCents: 450000, invoiceId: 'c1_2026-11' }];
    const m = makeIo({ purchases, invoices: [inv()] });
    assert.ok((await registerCardPurchase(uid, 'c1', rawBuy({ amountCents: '500,01' }), m.io)).errors.amountCents);
    assert.equal(m.calls.atomic.length, 0);
    assert.equal((await registerCardPurchase(uid, 'c1', rawBuy({ amountCents: '500,00' }), m.io)).ok, true);
    // fatura paga libera limite
    const paid = makeIo({ purchases, invoices: [inv({ status: 'paid' })] });
    assert.equal((await registerCardPurchase(uid, 'c1', rawBuy({ amountCents: '4.000,00' }), paid.io)).ok, true);
  });
  it('rejeita cartão inexistente/bloqueado/cancelado e dados inválidos sem gravar', async () => {
    const run = (setup, raw = rawBuy(), id = 'c1') => { const m = makeIo(setup); return registerCardPurchase(uid, id, raw, m.io).then((r) => ({ r, calls: m.calls })); };
    assert.equal((await run({}, rawBuy(), 'zz')).r.ok, false);
    assert.equal((await run({ cards: [card({ status: 'blocked' })] })).r.ok, false);
    assert.equal((await run({ cards: [card({ status: 'cancelled' })] })).r.ok, false);
    assert.ok((await run({}, rawBuy({ amountCents: '0' }))).r.errors.amountCents);
    assert.ok((await run({}, rawBuy({ purchaseDate: 'hoje' }))).r.errors.purchaseDate);
    assert.ok((await run({}, rawBuy({ installmentsTotal: 49 }))).r.errors.installmentsTotal);
    assert.ok((await run({}, rawBuy({ amountCents: '0,02', installmentsTotal: 3 }))).r.errors.amountCents);
    const { calls } = await run({ cards: [card({ status: 'blocked' })] });
    assert.equal(calls.atomic.length, 0);
  });
  it('datas gravadas em meio-dia UTC pela camada de serviço', () => {
    const { dueDate, closingDate } = toFirestoreData({ dueDate: '2026-11-17', closingDate: '2026-11-10' });
    assert.equal(dueDate.toDate().toISOString(), '2026-11-17T12:00:00.000Z');
    assert.equal(closingDate.toDate().toISOString(), '2026-11-10T12:00:00.000Z');
  });
});

describe('faturas — fechar, pagar e excluir compra', () => {
  const closable = (o = {}) => inv({ closingDate: '2026-11-10', ...o });
  it('fecha a partir do fechamento gravando totalCents derivado e auditoria `close`', async () => {
    const purchases = [{ id: 'p1', invoiceId: 'c1_2026-11', amountCents: 3334 }, { id: 'p2', invoiceId: 'c1_2026-11', amountCents: 100 }, { id: 'p3', invoiceId: 'outra', amountCents: 999 }];
    const m = makeIo({ invoices: [closable()], purchases });
    assert.deepEqual(await closeInvoice(uid, 'c1_2026-11', m.io), { ok: true, totalCents: 3434 });
    assert.deepEqual(m.calls.update[0], { c: 'invoices', id: 'c1_2026-11', data: { status: 'closed', totalCents: 3434 } });
    assert.equal(m.calls.audit[0].action, 'close');
  });
  it('não fecha antes do fechamento, nem fatura não aberta/inexistente', async () => {
    const early = makeIo({ invoices: [closable()], now: '2026-11-09' });
    assert.equal((await closeInvoice(uid, 'c1_2026-11', early.io)).ok, false);
    assert.equal((await closeInvoice(uid, 'c1_2026-11', makeIo({ invoices: [closable({ status: 'closed' })] }).io)).ok, false);
    assert.equal((await closeInvoice(uid, 'zz', makeIo().io)).ok, false);
    assert.equal(early.calls.update.length, 0);
  });
  it('pagar fatura chama invoice.pay NO SERVIDOR (conta, total e saldo decididos na transação); nada é gravado direto', async () => {
    const m = makeIo({ invoices: [closable({ status: 'closed', totalCents: 5000 })], accounts: [{ id: 'a1', status: 'active' }] });
    const ops = [];
    const finance = async (op, params, options) => { ops.push({ op, params, options }); return { ok: true, paidCents: 5000, status: 'paid' }; };
    const r = await payInvoice(uid, 'c1_2026-11', { accountId: 'a1', date: '2026-11-20', operationId: 'op-9' }, { ...m.io, finance });
    assert.deepEqual([r.ok, r.paidCents], [true, 5000]);
    assert.deepEqual(ops.map((o) => [o.op, o.params, o.options.operationId]), [['invoice.pay', { invoiceId: 'c1_2026-11', accountId: 'a1', date: '2026-11-20' }, 'op-9']]);
    assert.equal(m.calls.update.length, 0);
    // limite liberado: compras de fatura paga saem do usado (regra de leitura, no cliente)
    assert.equal(cardLimitUsage(card(), [{ invoiceId: 'c1_2026-11', amountCents: 5000 }], [{ id: 'c1_2026-11', status: 'paid' }]).usedCents, 0);
  });
  it('pagar fatura: conta ausente e data inválida param antes do servidor; erros do servidor (saldo, já paga, zerada) são repassados', async () => {
    const ops = [];
    const server = (response) => async (op, params) => { ops.push(op); return response; };
    const base = makeIo({ invoices: [closable()] }).io;
    assert.ok((await payInvoice(uid, 'c1_2026-11', {}, { ...base, finance: server({ ok: true }) })).errors.accountId);
    assert.ok((await payInvoice(uid, 'c1_2026-11', { accountId: 'a1', date: '2026-02-30' }, { ...base, finance: server({ ok: true }) })).errors.date);
    assert.deepEqual(ops, []);
    for (const [code, message] of [['INSUFFICIENT_BALANCE', 'Saldo insuficiente'], ['INVALID_STATE', 'Esta fatura já foi paga.'], ['ACCOUNT_NOT_ACTIVE', 'A conta precisa estar ativa.']]) {
      const x = await payInvoice(uid, 'c1_2026-11', { accountId: 'a1' }, { ...base, finance: server({ ok: false, code, errors: { _form: message } }) });
      assert.deepEqual([x.ok, x.code, x.errors._form], [false, code, message]);
    }
  });
  it('cancela fatura aberta sem compras (R$ 0,00); bloqueia com compras, fechada ou falha de leitura', async () => {
    const m = makeIo({ invoices: [closable()], linked: 0 });
    assert.deepEqual(await cancelInvoice(uid, 'c1_2026-11', m.io), { ok: true });
    assert.deepEqual(m.calls.update[0].data, { status: 'cancelled' });
    assert.equal(m.calls.audit[0].action, 'cancel');
    for (const mk of [makeIo({ invoices: [closable()], linked: 2 }), makeIo({ invoices: [closable({ status: 'closed' })] }), makeIo({ invoices: [] })]) {
      assert.equal((await cancelInvoice(uid, 'c1_2026-11', mk.io)).ok, false);
      assert.equal(mk.calls.update.length, 0);
    }
    const boom = makeIo({ invoices: [closable()] });
    boom.io.count = async () => { throw new Error('x'); };
    const orig = console.error; console.error = () => {};
    assert.equal((await cancelInvoice(uid, 'c1_2026-11', boom.io)).ok, false);
    console.error = orig;
    assert.equal(boom.calls.update.length, 0);
  });
  it('exclui compra só com fatura aberta', async () => {
    const p = { id: 'p1', invoiceId: 'c1_2026-11', amountCents: 1 };
    const ok = makeIo({ purchases: [p], invoices: [inv()] });
    assert.equal((await deleteCardPurchase(uid, 'p1', ok.io)).ok, true);
    assert.equal(ok.calls.audit[0].action, 'delete');
    const closed = makeIo({ purchases: [p], invoices: [inv({ status: 'closed' })] });
    assert.equal((await deleteCardPurchase(uid, 'p1', closed.io)).ok, false);
    assert.equal(closed.calls.remove.length, 0);
    assert.equal((await deleteCardPurchase(uid, 'zz', ok.io)).ok, false);
  });
});

describe('corrigir compra lançada (troca atômica)', () => {
  const buy = (o = {}) => ({ id: 'p1', cardId: 'c1', description: 'Fatura Dez', amountCents: 73597, purchaseDate: '2026-11-01', installmentsTotal: 1, installmentNumber: 1, invoiceId: 'c1_2026-11', ...o });

  it('corrige descrição e mantém a fatura: exclui e recria no MESMO lote, sem tocar no valor', async () => {
    const m = makeIo({ purchases: [buy()], invoices: [inv()] });
    const r = await updateCardPurchase(uid, 'p1', { description: 'Mercado' }, m.io);
    assert.equal(r.ok, true);
    assert.equal(m.calls.atomic.length, 1);
    const [del, create] = m.calls.atomic[0];
    assert.deepEqual([del.type, del.docId, create.type], ['delete', 'p1', 'create']);
    assert.equal(create.data.description, 'Mercado');
    assert.equal(create.data.amountCents, 73597);
    assert.equal(create.data.invoiceId, 'c1_2026-11');
  });

  it('mudar a data de compra à vista move para a fatura do novo ciclo (cria a fatura antes, em lote próprio)', async () => {
    // fechamento dia 10: compra em 15/11 entra na fatura de 12/2026
    const m = makeIo({ purchases: [buy()], invoices: [inv()] });
    const r = await updateCardPurchase(uid, 'p1', { purchaseDate: '2026-11-15' }, m.io);
    assert.deepEqual([r.ok, r.invoiceMonth], [true, '2026-12']);
    assert.equal(m.calls.atomic.length, 2);
    assert.deepEqual([m.calls.atomic[0][0].type, m.calls.atomic[0][0].docId], ['create', 'c1_2026-12']);
    assert.equal(m.calls.atomic[1][1].data.invoiceId, 'c1_2026-12');
  });

  it('reaproveita fatura aberta existente e pula as não abertas', async () => {
    const m = makeIo({ purchases: [buy()], invoices: [inv(), inv({ id: 'c1_2026-12', referenceMonth: '2026-12', status: 'closed' }), inv({ id: 'c1_2027-01', referenceMonth: '2027-01' })] });
    const r = await updateCardPurchase(uid, 'p1', { purchaseDate: '2026-11-15' }, m.io);
    assert.deepEqual([r.ok, r.invoiceMonth], [true, '2027-01']);
    assert.equal(m.calls.atomic.length, 1); // sem fatura nova
    assert.equal(m.calls.atomic[0][1].data.invoiceId, 'c1_2027-01');
  });

  it('bloqueia: fatura fechada/paga, devedor, assinatura, parcelada com data alterada, compra inexistente', async () => {
    const cases = [
      [makeIo({ purchases: [buy()], invoices: [inv({ status: 'closed' })] }), {}],
      [makeIo({ purchases: [buy({ debtorId: 'd1' })], invoices: [inv()] }), {}],
      [makeIo({ purchases: [buy({ notes: 'Assinatura' })], invoices: [inv()] }), {}],
      [makeIo({ purchases: [buy({ installmentsTotal: 3 })], invoices: [inv()] }), { purchaseDate: '2026-11-20' }],
    ];
    for (const [m, raw] of cases) {
      assert.equal((await updateCardPurchase(uid, 'p1', raw, m.io)).ok, false);
      assert.equal(m.calls.atomic.length, 0);
    }
    assert.equal((await updateCardPurchase(uid, 'zz', {}, makeIo().io)).ok, false);
  });

  it('parcela de compra parcelada aceita corrigir descrição sem mudar a data', async () => {
    const m = makeIo({ purchases: [buy({ installmentsTotal: 3, installmentNumber: 2 })], invoices: [inv()] });
    const r = await updateCardPurchase(uid, 'p1', { description: 'TV', purchaseDate: '2026-11-01' }, m.io);
    assert.equal(r.ok, true);
    assert.deepEqual([m.calls.atomic[0][1].data.installmentNumber, m.calls.atomic[0][1].data.installmentsTotal], [2, 3]);
  });

  it('valida a descrição (vazia é rejeitada e nada é gravado)', async () => {
    const m = makeIo({ purchases: [buy()], invoices: [inv()] });
    const r = await updateCardPurchase(uid, 'p1', { description: '  ' }, m.io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.description);
    assert.equal(m.calls.atomic.length, 0);
  });
});
