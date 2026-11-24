/**
 * VF-2-03h: avanço de nextChargeDate ao registrar cobrança e bloqueio de deleteCategory por assinaturas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerSubscriptionCharge } from '../../js/services/subscriptions.js';
import { deleteCategory } from '../../js/services/categories.js';
import { advanceChargeDate } from '../../js/core/model.js';
import { toFirestoreData } from '../../js/services/firestore.js';

const uid = 'u1';
const sub = (o = {}) => ({ id: 's1', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-11-18', accountId: 'a1', ...o });
function makeIo(current) {
  const calls = { update: [], audit: [] };
  return {
    calls,
    io: {
      getById: async () => current,
      update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
      writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
    },
  };
}

describe('advanceChargeDate (puro)', () => {
  it('semanal soma 7 dias, inclusive virando mês/ano', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'weekly'), '2026-11-25');
    assert.equal(advanceChargeDate('2026-12-29', 'weekly'), '2027-01-05');
  });
  it('mensal mantém o dia, vira o ano e faz clamp ao fim do mês', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'monthly'), '2026-12-18');
    assert.equal(advanceChargeDate('2026-12-15', 'monthly'), '2027-01-15');
    assert.equal(advanceChargeDate('2026-01-31', 'monthly'), '2026-02-28');
    assert.equal(advanceChargeDate('2028-01-31', 'monthly'), '2028-02-29');
    assert.equal(advanceChargeDate('2026-03-31', 'monthly'), '2026-04-30');
  });
  it('anual mantém dia/mês e faz clamp de 29/02', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'yearly'), '2027-11-18');
    assert.equal(advanceChargeDate('2028-02-29', 'yearly'), '2029-02-28');
  });
  it('entradas inválidas retornam null', () => {
    assert.equal(advanceChargeDate('2026-02-30', 'monthly'), null);
    assert.equal(advanceChargeDate('18/11/2026', 'monthly'), null);
    assert.equal(advanceChargeDate('2026-11-18', 'daily'), null);
    assert.equal(advanceChargeDate(undefined, 'weekly'), null);
  });
  it('resultado é gravado em meio-dia UTC pela camada de serviço', () => {
    const { nextChargeDate } = toFirestoreData({ nextChargeDate: advanceChargeDate('2026-11-18', 'monthly') });
    assert.equal(nextChargeDate.toDate().toISOString(), '2026-12-18T12:00:00.000Z');
  });
});

describe('registerSubscriptionCharge', () => {
  it('avança a data, grava só nextChargeDate e audita `charge`', async () => {
    const { io, calls } = makeIo(sub());
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual(r, { ok: true, nextChargeDate: '2026-12-18', via: 'account', generatedExpense: false }); // sem despesa/saldo
    assert.deepEqual(calls.update, [{ c: 'subscriptions', id: 's1', data: { nextChargeDate: '2026-12-18' } }]);
    assert.equal(calls.audit[0].action, 'charge');
    assert.deepEqual(calls.audit[0].after, { nextChargeDate: '2026-12-18' });
  });
  it('respeita a periodicidade (semanal/anual)', async () => {
    assert.equal((await registerSubscriptionCharge(uid, 's1', makeIo(sub({ periodicity: 'weekly' })).io)).nextChargeDate, '2026-11-25');
    assert.equal((await registerSubscriptionCharge(uid, 's1', makeIo(sub({ periodicity: 'yearly' })).io)).nextChargeDate, '2027-11-18');
  });
  it('rejeita pausada, cancelada, inexistente e dados inválidos sem gravar', async () => {
    for (const current of [sub({ status: 'paused' }), sub({ status: 'cancelled' }), null, sub({ nextChargeDate: 'x' }), sub({ periodicity: 'daily' })]) {
      const { io, calls } = makeIo(current);
      assert.equal((await registerSubscriptionCharge(uid, 's1', io)).ok, false);
      assert.equal(calls.update.length + calls.audit.length, 0);
    }
  });
});

describe('deleteCategory — assinaturas vinculadas', () => {
  const run = (counts, extra = {}) => {
    const calls = { remove: 0 };
    const io = {
      getById: async () => ({ id: 'c1', name: 'Streaming' }),
      count: async (u, collection) => counts[collection] ?? 0,
      remove: async () => { calls.remove += 1; },
      writeAudit: async () => ({ ok: true }),
      ...extra,
    };
    return deleteCategory(uid, 'c1', io).then((r) => ({ r, calls }));
  };
  it('bloqueia quando só há assinaturas (qualquer status) e informa o vínculo', async () => {
    const { r, calls } = await run({ subscriptions: 2 });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /assinaturas/);
    assert.equal(calls.remove, 0);
  });
  it('exclui quando não há vínculos', async () => {
    const { r, calls } = await run({});
    assert.equal(r.ok, true);
    assert.equal(calls.remove, 1);
  });
  it('fail-closed se a contagem de assinaturas falhar', async () => {
    const orig = console.error; console.error = () => {};
    const { r, calls } = await run({}, { count: async (u, c) => { if (c === 'subscriptions') throw new Error('x'); return 0; } });
    console.error = orig;
    assert.equal(r.ok, false);
    assert.equal(calls.remove, 0);
  });
});

describe('registerSubscriptionCharge — destinos: cartão, devedor e sem vínculo (VF-COR-07)', () => {
  const cardX = { id: 'c1', name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active' };
  const base = (o = {}) => ({ id: 's1', name: 'Netflix', amountCents: 5590, periodicity: 'monthly', nextChargeDate: '2026-11-05', categoryId: 'cat', status: 'active', ...o });
  const mk = (subscription, debtor = { id: 'dv', name: 'Roberta', status: 'open', lentCents: 0, receivedCents: 0 }) => {
    const atomic = [];
    const updates = [];
    const audits = [];
    return {
      atomic, updates, audits,
      io: {
        getById: async (u, c, id) => ({ subscriptions: [subscription], creditCards: [cardX], categories: [{ id: 'cat', kind: 'expense' }], debtors: debtor ? [debtor] : [] }[c] ?? []).find((x) => x.id === id) ?? null,
        list: async () => [],
        commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); },
        update: async (u, c, id, data) => updates.push({ c, id, data }),
        writeAudit: async (u, e) => { audits.push(e); return { ok: true }; },
        now: () => new Date('2026-11-05T12:00:00Z'),
      },
    };
  };
  const advance = { type: 'update', collection: 'subscriptions', docId: 's1', data: { nextChargeDate: '2026-12-05' }, action: 'charge' };

  it('CARTÃO + DEVEDOR (Netflix da Roberta): a parcela na fatura nasce VINCULADA ao devedor, soma no emprestado e a data avança no MESMO lote', async () => {
    const { io, atomic, updates } = mk(base({ cardId: 'c1', accountId: 'a1', debtorId: 'dv' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via, r.debtorId, r.nextChargeDate], [true, 'card', 'dv', '2026-12-05']);
    const ops = atomic.at(-1);
    const buy = ops.find((o) => o.collection === 'cardPurchases');
    assert.deepEqual([buy.data.debtorId, buy.data.amountCents, buy.data.installmentsTotal], ['dv', 5590, 1]);
    assert.deepEqual(ops.find((o) => o.collection === 'debtors').increments, { lentCents: 5590 });
    assert.deepEqual(ops.find((o) => o.collection === 'subscriptions'), advance); // avanço da data no MESMO lote
    assert.equal(ops.some((o) => o.collection === 'expenses'), false);
    assert.equal(updates.length, 0);
  });

  it('CARTÃO sem devedor: igual a antes — sem vínculo de devedor e sem escrita em devedores', async () => {
    const { io, atomic } = mk(base({ cardId: 'c1', accountId: 'a1' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via], [true, 'card']);
    const ops = atomic.at(-1);
    assert.equal('debtorId' in ops.find((o) => o.collection === 'cardPurchases').data, false);
    assert.equal(ops.some((o) => o.collection === 'debtors'), false);
  });

  it('SÓ DEVEDOR (sem cartão): cria UMA dívida à vista (valor, descrição, vencimento = data da cobrança), soma no emprestado e avança a data no MESMO lote', async () => {
    const { io, atomic, updates } = mk(base({ debtorId: 'dv' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via, r.debtorId, r.nextChargeDate, r.generatedExpense], [true, 'debtor', 'dv', '2026-12-05', false]);
    const ops = atomic.at(-1);
    const debts = ops.filter((o) => o.collection === 'debts');
    assert.equal(debts.length, 1);
    assert.deepEqual(
      [debts[0].data.debtorId, debts[0].data.principalCents, debts[0].data.description, debts[0].data.installmentsTotal, debts[0].data.status],
      ['dv', 5590, 'Netflix', 1, 'pending'],
    );
    assert.equal(debts[0].data.dueDate, '2026-11-05');
    assert.deepEqual(ops.find((o) => o.collection === 'debtors').increments, { lentCents: 5590 });
    assert.deepEqual(ops.find((o) => o.collection === 'subscriptions'), advance); // avanço da data no MESMO lote
    assert.equal(ops.some((o) => o.collection === 'expenses' || o.collection === 'incomes'), false); // nenhum lançamento em conta
    assert.equal(updates.length, 0);
  });

  it('CONTA + DEVEDOR (sem cartão): também cria a dívida do devedor; a conta segue só como referência (nenhuma despesa)', async () => {
    const { io, atomic } = mk(base({ accountId: 'a1', debtorId: 'dv' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via], [true, 'debtor']);
    assert.equal(atomic.at(-1).filter((o) => o.collection === 'debts').length, 1);
    assert.equal(atomic.at(-1).some((o) => o.collection === 'expenses'), false);
  });

  it('SEM VÍNCULO (só acompanhamento): só avança a data e audita; via "none"; nada financeiro', async () => {
    const { io, atomic, updates, audits } = mk(base());
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual(r, { ok: true, nextChargeDate: '2026-12-05', via: 'none', generatedExpense: false });
    assert.equal(atomic.length, 0);
    assert.deepEqual(updates, [{ c: 'subscriptions', id: 's1', data: { nextChargeDate: '2026-12-05' } }]);
    assert.equal(audits[0].action, 'charge');
  });

  it('SÓ CONTA (comportamento anterior): via "account", sem despesa, sem lote', async () => {
    const { io, atomic } = mk(base({ accountId: 'a1' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via, r.generatedExpense], [true, 'account', false]);
    assert.equal(atomic.length, 0);
  });

  it('devedor cancelado ou inexistente: nenhuma cobrança é gravada (nem a data avança) em cartão ou dívida à vista', async () => {
    for (const subscription of [base({ debtorId: 'dv' }), base({ cardId: 'c1', debtorId: 'dv' })]) {
      for (const debtor of [{ id: 'dv', name: 'R', status: 'cancelled', lentCents: 0, receivedCents: 0 }, null]) {
        const { io, atomic, updates } = mk(subscription, debtor);
        const r = await registerSubscriptionCharge(uid, 's1', io);
        assert.equal(r.ok, false, JSON.stringify([subscription.cardId, debtor?.status]));
        assert.equal(atomic.length + updates.length, 0);
      }
    }
  });
});
