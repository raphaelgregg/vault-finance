/**
 * VF-2-03h: avanço de nextChargeDate ao registrar cobrança e bloqueio de deleteCategory por assinaturas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerSubscriptionCharge } from '../../js/services/subscriptions.js';
import { deleteCategory } from '../../js/services/categories.js';
import { advanceChargeDate, chargeAnchorDay } from '../../js/core/model.js';
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

describe('advanceChargeDate — dia de cobrança original (VF-COR-09)', () => {
  const chain = (start, periodicity, steps, anchor) => {
    const out = [start];
    for (let i = 0; i < steps; i += 1) out.push(advanceChargeDate(out.at(-1), periodicity, anchor));
    return out;
  };

  it('SEM âncora mantém o comportamento anterior (o dia derivado do ajuste fica no menor dia)', () => {
    assert.deepEqual(chain('2026-01-31', 'monthly', 4), ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28', '2026-05-28']);
  });

  it('COM âncora 31 a assinatura mensal volta ao dia 31 nos meses que o têm', () => {
    assert.deepEqual(chain('2026-01-31', 'monthly', 5, 31), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    assert.deepEqual(chain('2026-01-30', 'monthly', 3, 30), ['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30']);
    assert.deepEqual(chain('2028-01-29', 'monthly', 2, 29), ['2028-01-29', '2028-02-29', '2028-03-29']); // bissexto
  });

  it('virada de ano e recuperação do dia a partir de uma data já ajustada (28/02 com âncora 31 → 31/03)', () => {
    assert.equal(advanceChargeDate('2026-12-31', 'monthly', 31), '2027-01-31');
    assert.equal(advanceChargeDate('2026-02-28', 'monthly', 31), '2026-03-31');
  });

  it('anual de 29/02 volta a 29/02 nos bissextos; semanal ignora a âncora', () => {
    assert.deepEqual(chain('2028-02-29', 'yearly', 4, 29), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    assert.equal(advanceChargeDate('2026-11-24', 'weekly', 31), '2026-12-01');
  });

  it('âncora inválida (0, 32, 1.5, texto, null) cai no dia da própria data', () => {
    for (const bad of [0, 32, 1.5, '31', NaN, null, undefined]) assert.equal(advanceChargeDate('2026-01-31', 'monthly', bad), '2026-02-28', String(bad));
  });

  it('chargeAnchorDay: só dias 29–31 precisam ser lembrados; datas inválidas → null', () => {
    assert.deepEqual(['2026-01-31', '2026-01-30', '2026-01-29', '2026-01-28', '2026-01-01'].map(chargeAnchorDay), [31, 30, 29, null, null]);
    for (const bad of ['2026-02-30', 'x', '', null, undefined]) assert.equal(chargeAnchorDay(bad), null);
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
    assert.equal(buy.docId, 'sub_s1_2026-11-05'); // id determinístico: uma compra por assinatura e data
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

  it('SÓ DEVEDOR (sem cartão) — "Registrar cobrança" FECHA o ciclo: garante a dívida desta data e lança a da PRÓXIMA fatura, avançando a data no MESMO lote', async () => {
    const { io, atomic, updates } = mk(base({ debtorId: 'dv' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via, r.debtorId, r.nextChargeDate, r.launched, r.generatedExpense], [true, 'debtor', 'dv', '2026-12-05', true, false]);
    assert.equal(atomic.length, 2);
    const [thisCycle, next] = atomic;
    const debts = (batch) => batch.filter((o) => o.collection === 'debts');
    assert.deepEqual(debts(thisCycle).map((o) => [o.docId, o.data.dueDate, o.data.principalCents]), [['sub_s1_2026-11-05', '2026-11-05', 5590]]);
    assert.deepEqual(debts(next).map((o) => [o.docId, o.data.dueDate, o.data.principalCents, o.data.description]), [['sub_s1_2026-12-05', '2026-12-05', 5590, 'Netflix']]);
    assert.equal(thisCycle.some((o) => o.collection === 'subscriptions'), false); // a data só avança junto da dívida da próxima fatura
    assert.deepEqual(next.find((o) => o.collection === 'subscriptions'), advance);
    assert.equal(atomic.flat().some((o) => o.collection === 'expenses' || o.collection === 'incomes'), false); // nenhum lançamento em conta
    assert.equal(updates.length, 0);
  });

  it('CICLO: a dívida desta data já existente não é recriada — só a próxima é lançada e a data avança', async () => {
    const m = mk(base({ debtorId: 'dv' }));
    m.io.list = async (u, c) => (c === 'debts' ? [{ id: 'sub_s1_2026-11-05', debtorId: 'dv', dueDate: '2026-11-05', status: 'pending', principalCents: 5590 }] : []);
    const r = await registerSubscriptionCharge(uid, 's1', m.io);
    assert.deepEqual([r.ok, r.launched, m.atomic.length], [true, true, 1]);
    assert.deepEqual(m.atomic[0].filter((o) => o.collection === 'debts').map((o) => o.data.dueDate), ['2026-12-05']);
  });

  it('CICLO: se a dívida da próxima fatura também já existe, só a data avança (nada é recriado nem somado)', async () => {
    const m = mk(base({ debtorId: 'dv' }));
    m.io.list = async (u, c) => (c === 'debts'
      ? [{ id: 'sub_s1_2026-11-05', debtorId: 'dv', dueDate: '2026-11-05', status: 'pending' }, { id: 'sub_s1_2026-12-05', debtorId: 'dv', dueDate: '2026-12-05', status: 'pending' }]
      : []);
    const r = await registerSubscriptionCharge(uid, 's1', m.io);
    assert.deepEqual([r.ok, r.launched], [true, false]);
    assert.deepEqual(m.atomic, [[advance]]);
  });

  it('CONTA + DEVEDOR (sem cartão): também cria a dívida do devedor; a conta segue só como referência (nenhuma despesa)', async () => {
    const { io, atomic } = mk(base({ accountId: 'a1', debtorId: 'dv' }));
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual([r.ok, r.via], [true, 'debtor']);
    assert.equal(atomic.flat().filter((o) => o.collection === 'debts').length, 2); // desta data + da próxima fatura
    assert.equal(atomic.flat().some((o) => o.collection === 'expenses'), false);
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

  it('DUPLICIDADE (cartão): compra da assinatura nessa data já lançada é recusada sem gravar', async () => {
    const m = mk(base({ cardId: 'c1', debtorId: 'dv' }));
    const getById = m.io.getById;
    m.io.getById = async (u, c, id) => (c === 'cardPurchases' && id === 'sub_s1_2026-11-05' ? { id } : getById(u, c, id));
    const r = await registerSubscriptionCharge(uid, 's1', m.io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /05\/11\/2026 desta assinatura já foi lançada/);
    assert.equal(m.atomic.length + m.updates.length, 0);
  });

  it('CORRIDA no lote (dívida ou compra): outra chamada gravou o mesmo id antes → "já lançada", nada duplicado', async () => {
    for (const subscription of [base({ debtorId: 'dv' }), base({ cardId: 'c1', debtorId: 'dv' })]) {
      const raced = mk(subscription);
      raced.io.commitAtomic = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
      const r = await registerSubscriptionCharge(uid, 's1', raced.io);
      assert.deepEqual([r.ok, /já foi lançada/.test(r.errors._form)], [false, true]);
    }
  });
});
