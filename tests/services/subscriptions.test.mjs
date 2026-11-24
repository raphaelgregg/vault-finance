/**
 * Testes do serviço de Assinaturas (VF-2-03a): modelo, cálculos, CRUD com `io` injetado.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubscription,
  chargeDocId,
  updateSubscription,
  deleteSubscription,
  setSubscriptionStatus,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  getPeriodicityOptions,
  getSubscriptionStatusOptions,
} from '../../js/services/subscriptions.js';
import {
  buildEntity,
  validateEntity,
  SCHEMAS,
  CATEGORY_KIND_ERROR,
  subscriptionAnnualCents,
  subscriptionMonthlyCents,
  summarizeSubscriptions,
} from '../../js/core/model.js';
import { toFirestoreData, fromFirestoreDoc } from '../../js/services/firestore.js';
import { isDateFieldName } from '../../js/utils/dates.js';

const uid = 'u1';
const raw = (over = {}) => ({
  name: ' Netflix ',
  amountCents: '39,90',
  periodicity: 'monthly',
  nextChargeDate: '2026-12-05',
  accountId: 'a1',
  categoryId: 'c1',
  status: 'active',
  ...over,
});
const okCategory = { lookupCategory: async () => ({ id: 'c1', kind: 'expense', archived: false }) };

function makeIo(extra = {}) {
  const calls = { create: [], update: [], remove: [], audit: [] };
  const io = {
    create: async (u, c, data) => { calls.create.push({ u, c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ u, c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ u, c, id }); },
    writeAudit: async (u, entry) => { calls.audit.push({ u, entry }); return { ok: true }; },
    ...extra,
  };
  return { io, calls };
}

describe('subscriptions — schema (espelha firestore.rules)', () => {
  it('chaves e enums iguais às Rules', () => {
    assert.deepEqual(
      Object.keys(SCHEMAS.subscriptions.fields).sort(),
      ['accountId', 'amountCents', 'cardId', 'categoryId', 'chargeDay', 'debtorId', 'name', 'nextChargeDate', 'notes', 'periodicity', 'status']
    );
    assert.deepEqual(getPeriodicityOptions().map((o) => o.value), ['monthly', 'weekly', 'yearly']);
    assert.deepEqual(getSubscriptionStatusOptions().map((o) => o.value), ['active', 'paused', 'cancelled']);
  });

  it('o campo de data segue a convenção *Date', () => {
    assert.ok(isDateFieldName('nextChargeDate'));
    assert.deepEqual(SCHEMAS.subscriptions.dateFields, ['nextChargeDate']);
  });

  it('buildEntity normaliza centavos e texto; omite notes vazio', () => {
    const { ok, data } = buildEntity('subscriptions', raw({ notes: '' }));
    assert.equal(ok, true);
    assert.equal(data.name, 'Netflix');
    assert.equal(data.amountCents, 3990);
    assert.equal('notes' in data, false);
  });

  it('rejeita valor zero, periodicidade/status inválidos, data inexistente e campo extra', () => {
    const { errors } = validateEntity('subscriptions', raw({
      amountCents: '0', periodicity: 'daily', status: 'x', nextChargeDate: '2026-02-30', extra: 1,
    }));
    assert.deepEqual(
      Object.keys(errors).sort(),
      ['amountCents', 'extra', 'nextChargeDate', 'periodicity', 'status']
    );
  });

  it('rejeita nome vazio, nome > 80 e notes > 500', () => {
    assert.ok(validateEntity('subscriptions', raw({ name: '  ' })).errors.name);
    assert.ok(validateEntity('subscriptions', raw({ name: 'x'.repeat(81) })).errors.name);
    assert.ok(validateEntity('subscriptions', raw({ notes: 'x'.repeat(501) })).errors.notes);
  });

  it('data de cobrança vira meio-dia UTC e volta ao mesmo dia; texto livre não converte', () => {
    const stored = toFirestoreData({ nextChargeDate: '2026-12-05', name: '2026-12-05' });
    assert.equal(stored.nextChargeDate.toDate().toISOString(), '2026-12-05T12:00:00.000Z');
    assert.equal(stored.name, '2026-12-05');
    const back = fromFirestoreDoc('x', stored);
    assert.equal(back.nextChargeDate, '2026-12-05');
  });
});

describe('subscriptions — cálculos', () => {
  it('anual e mensal por periodicidade (centavos inteiros)', () => {
    assert.equal(subscriptionAnnualCents(3990, 'monthly'), 47880);
    assert.equal(subscriptionAnnualCents(1000, 'weekly'), 52000);
    assert.equal(subscriptionAnnualCents(12000, 'yearly'), 12000);
    assert.equal(subscriptionMonthlyCents(3990, 'monthly'), 3990);
    assert.equal(subscriptionMonthlyCents(12000, 'yearly'), 1000);
    assert.equal(subscriptionMonthlyCents(1000, 'weekly'), 4333); // 52000/12 = 4333,33
  });

  it('entradas inválidas valem 0', () => {
    assert.equal(subscriptionAnnualCents(100, 'daily'), 0);
    assert.equal(subscriptionAnnualCents('abc', 'monthly'), 0);
    assert.equal(subscriptionAnnualCents(10.5, 'monthly'), 0);
  });

  it('summarize conta só ativas e não acumula arredondamento', () => {
    const items = [
      { status: 'active', amountCents: 1000, periodicity: 'weekly' },
      { status: 'active', amountCents: 3990, periodicity: 'monthly' },
      { status: 'paused', amountCents: 9999, periodicity: 'monthly' },
      { status: 'cancelled', amountCents: 9999, periodicity: 'yearly' },
    ];
    const s = summarizeSubscriptions(items);
    assert.equal(s.activeCount, 2);
    assert.equal(s.annualCents, 52000 + 47880);
    assert.equal(s.monthlyCents, Math.round(99880 / 12));
    assert.deepEqual(summarizeSubscriptions([]), { activeCount: 0, monthlyCents: 0, annualCents: 0 });
  });
});

describe('subscriptions — service', () => {
  it('create: valida, grava e audita (action create, collection subscriptions)', async () => {
    const { io, calls } = makeIo(okCategory);
    const r = await createSubscription(uid, raw(), io);
    assert.deepEqual([r.ok, r.id], [true, 'new1']);
    assert.equal(calls.create[0].c, 'subscriptions');
    assert.equal(calls.create[0].data.amountCents, 3990);
    assert.deepEqual(
      { a: calls.audit[0].entry.action, c: calls.audit[0].entry.collection, d: calls.audit[0].entry.docId },
      { a: 'create', c: 'subscriptions', d: 'new1' }
    );
  });

  it('create/update: dados inválidos não gravam nem auditam', async () => {
    const { io, calls } = makeIo(okCategory);
    const c = await createSubscription(uid, raw({ amountCents: '-1' }), io);
    const u = await updateSubscription(uid, 'x1', raw({ name: '' }), io);
    assert.equal(c.ok || u.ok, false);
    assert.ok(c.errors.amountCents && u.errors.name);
    assert.deepEqual([calls.create.length, calls.update.length, calls.audit.length], [0, 0, 0]);
  });

  it('categoria de receita é rejeitada; ausente/arquivada também (fail-closed)', async () => {
    for (const category of [
      { id: 'c1', kind: 'income', archived: false },
      null,
    ]) {
      const { io, calls } = makeIo({ lookupCategory: async () => category });
      const r = await createSubscription(uid, raw(), io);
      assert.equal(r.ok, false);
      assert.equal(calls.create.length, 0);
    }
    const { io } = makeIo({ lookupCategory: async () => ({ id: 'c1', kind: 'income' }) });
    const r = await updateSubscription(uid, 'x1', raw(), io);
    assert.equal(r.ok, false);
    assert.equal(r.errors.categoryId, CATEGORY_KIND_ERROR);
  });

  it('update grava e audita com o id', async () => {
    const { io, calls } = makeIo({ ...okCategory, getById: async () => ({ id: 'x1', status: 'active' }) });
    const r = await updateSubscription(uid, 'x1', raw(), io);
    assert.equal(r.ok, true);
    assert.equal(calls.update[0].id, 'x1');
    assert.equal(calls.audit[0].entry.action, 'update');
  });

  it('delete: audita com before; inexistente não remove', async () => {
    const doc = { id: 'x1', name: 'Netflix' };
    const { io, calls } = makeIo({ getById: async () => doc });
    assert.equal((await deleteSubscription(uid, 'x1', io)).ok, true);
    assert.deepEqual(calls.audit[0].entry,
      { action: 'delete', collection: 'subscriptions', docId: 'x1', before: doc });

    const missing = makeIo({ getById: async () => null });
    const r = await deleteSubscription(uid, 'x1', missing.io);
    assert.equal(r.ok, false);
    assert.equal(missing.calls.remove.length, 0);
  });
});

describe('subscriptions — transições de status', () => {
  const withStatus = (status) => makeIo({ getById: async () => ({ id: 'x1', status }) });

  it('ativa → pausada → ativa; pausa/retoma/cancela auditam a ação certa', async () => {
    let h = withStatus('active');
    assert.equal((await pauseSubscription(uid, 'x1', h.io)).ok, true);
    assert.deepEqual(h.calls.update[0].data, { status: 'paused' });
    assert.equal(h.calls.audit[0].entry.action, 'pause');

    h = withStatus('paused');
    assert.equal((await resumeSubscription(uid, 'x1', h.io)).ok, true);
    assert.equal(h.calls.audit[0].entry.action, 'resume');

    h = withStatus('paused');
    assert.equal((await cancelSubscription(uid, 'x1', h.io)).ok, true);
    assert.equal(h.calls.audit[0].entry.action, 'cancel');
  });

  it('cancelada é terminal; mesmo status e status inválido são rejeitados sem escrita', async () => {
    for (const [from, to] of [['cancelled', 'active'], ['cancelled', 'paused'], ['active', 'active'], ['paused', 'paused']]) {
      const h = withStatus(from);
      const r = await setSubscriptionStatus(uid, 'x1', to, h.io);
      assert.equal(r.ok, false, `${from}→${to}`);
      assert.equal(h.calls.update.length + h.calls.audit.length, 0);
    }
    const h = withStatus('active');
    assert.equal((await setSubscriptionStatus(uid, 'x1', 'bogus', h.io)).ok, false);
    assert.equal(h.calls.update.length, 0);
  });

  it('inexistente e falha de leitura (fail-closed) não escrevem', async () => {
    const missing = makeIo({ getById: async () => null });
    assert.equal((await pauseSubscription(uid, 'x1', missing.io)).ok, false);
    assert.equal(missing.calls.update.length, 0);

    const broken = makeIo({ getById: async () => { throw new Error('offline'); } });
    await assert.rejects(() => pauseSubscription(uid, 'x1', broken.io), /offline/);
    assert.equal(broken.calls.update.length, 0);
  });
});

describe('subscriptions — vínculos opcionais: conta, cartão e devedor (VF-COR-07)', () => {
  const raw = { name: 'Netflix', amountCents: '55,90', periodicity: 'monthly', nextChargeDate: '2026-12-05', categoryId: 'cat', status: 'active' };
  const deps = (over = {}) => ({ lookupCategory: async () => ({ id: 'cat', kind: 'expense' }), lookupDebtor: async () => ({ id: 'dv', status: 'open' }), create: async (u, c, data) => { deps.created = data; return 'new1'; }, writeAudit: async () => ({ ok: true }), ...over });

  it('a conta NÃO é obrigatória: schema aceita assinatura sem conta, sem cartão e sem devedor (só acompanhamento)', async () => {
    assert.equal(SCHEMAS.subscriptions.fields.accountId.required, false);
    assert.equal(SCHEMAS.subscriptions.fields.debtorId.required, false);
    const r = await createSubscription('u1', raw, deps());
    assert.deepEqual([r.ok, r.id], [true, 'new1']);
    assert.equal('accountId' in deps.created, false);
    assert.equal('debtorId' in deps.created, false);
  });

  it('com devedor: precisa existir e não estar cancelado; quitado/aberto são aceitos', async () => {
    const ok = await createSubscription('u1', { ...raw, debtorId: 'dv' }, deps());
    assert.equal(ok.ok, true);
    assert.equal(deps.created.debtorId, 'dv');
    assert.equal((await createSubscription('u1', { ...raw, debtorId: 'dv' }, deps({ lookupDebtor: async () => ({ id: 'dv', status: 'paid' }) }))).ok, true);
    const missing = await createSubscription('u1', { ...raw, debtorId: 'dv' }, deps({ lookupDebtor: async () => null }));
    assert.deepEqual([missing.ok, missing.errors.debtorId], [false, 'Devedor não encontrado.']);
    const cancelled = await createSubscription('u1', { ...raw, debtorId: 'dv' }, deps({ lookupDebtor: async () => ({ id: 'dv', status: 'cancelled' }) }));
    assert.equal(cancelled.ok, false);
    assert.ok(cancelled.errors.debtorId);
  });

  it('conta + cartão (comportamento anterior) continua aceito', async () => {
    const r = await createSubscription('u1', { ...raw, accountId: 'a1', cardId: 'c1' }, deps({ lookupCard: async () => ({ id: 'c1', status: 'active' }) }));
    assert.equal(r.ok, true);
    assert.deepEqual([deps.created.accountId, deps.created.cardId], ['a1', 'c1']);
  });

  it('editar removendo conta/cartão/devedor envia null (deleteField) — o vínculo é de fato removido', async () => {
    const updates = [];
    const r = await updateSubscription('u1', 's1', raw, deps({ update: async (u, c, id, data) => { updates.push(data); }, getById: async () => ({ id: 's1' }) }));
    assert.equal(r.ok, true);
    const written = updates[0];
    assert.deepEqual([written.accountId, written.cardId, written.debtorId], [null, null, null]);
  });
});

describe('subscriptions — a dívida do devedor ACOMPANHA a assinatura (VF-COR-10, caminho sem cartão)', () => {
  const raw = { name: 'Netflix', amountCents: '55,90', periodicity: 'monthly', nextChargeDate: '2026-12-05', categoryId: 'cat', status: 'active', debtorId: 'dv' };
  const debt = (id, dueDate, over = {}) => ({ id, debtorId: 'dv', description: 'Netflix', principalCents: 5590, dueDate, status: 'pending', ...over });

  /** Mundo em memória: `launched` = dívidas do devedor; `previous` = assinatura antes da edição; `receipts` = dívidas com recebimento. */
  const mk = ({ launched = [], previous = null, debtorStatus = 'open', receipts = [], commit, finance } = {}) => {
    const committed = [];
    const updates = [];
    const calls = [];
    const deps = {
      lookupCategory: async () => ({ id: 'cat', kind: 'expense' }),
      lookupDebtor: async (u, id) => ({ id, status: debtorStatus }),
      create: async () => 'new1',
      update: async (u, c, id, data) => { updates.push({ c, id, data }); },
      remove: async () => {},
      writeAudit: async () => ({ ok: true }),
      list: async (u, c, q) => (c === 'debts' ? launched.filter((d) => d.debtorId === q.where[0][2]) : []),
      getById: async (u, c, id) => {
        if (c === 'debtors') return { id, name: 'Roberta', status: debtorStatus, lentCents: 0, receivedCents: 0 };
        if (c === 'subscriptions') return previous;
        if (c === 'debts') return launched.find((d) => d.id === id) ?? null;
        return null;
      },
      commitAtomic: commit ?? (async (u, ops) => { committed.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); }),
      finance: finance ?? (async (op, params) => {
        calls.push([op, params]);
        if (receipts.includes(params.debtId)) return { ok: false, code: 'INVALID_STATE', status: 409, errors: { _form: 'A parcela já possui recebimentos.' } };
        return { ok: true };
      }),
    };
    return { deps, committed, updates, calls };
  };
  const debtCreates = (batches) => batches.flat().filter((o) => o.collection === 'debts');

  it('CRIAR com devedor lança UMA dívida na data atual (id determinístico) e NÃO avança a data da assinatura', async () => {
    const { deps, committed, updates } = mk();
    const r = await createSubscription('u1', raw, deps);
    assert.deepEqual([r.ok, r.charge.ok, r.charge.action, r.charge.date], [true, true, 'launched', '2026-12-05']);
    assert.equal(committed.length, 1);
    const [d] = debtCreates(committed);
    assert.deepEqual([d.docId, d.data.dueDate, d.data.principalCents, d.data.description], [chargeDocId('new1', '2026-12-05'), '2026-12-05', 5590, 'Netflix']);
    assert.equal(chargeDocId('new1', '2026-12-05'), 'sub_new1_2026-12-05');
    assert.equal(committed[0].some((o) => o.collection === 'subscriptions'), false); // a data da assinatura continua a mesma
    assert.equal(updates.length, 0);
  });

  it('SÓ a data atual: data no passado não gera retroativas nem futuras', async () => {
    const { deps, committed } = mk();
    await createSubscription('u1', { ...raw, nextChargeDate: '2026-08-05' }, deps);
    assert.deepEqual(debtCreates(committed).map((o) => o.data.dueDate), ['2026-08-05']);
  });

  it('sem devedor, com cartão+devedor (parcela imutável, outro fluxo), pausada ou cancelada: nenhuma dívida à vista é criada', async () => {
    for (const over of [{ debtorId: undefined }, { status: 'paused' }, { status: 'cancelled' }]) {
      const { deps, committed } = mk();
      const r = await createSubscription('u1', { ...raw, ...over }, deps);
      assert.equal(r.ok, true);
      assert.equal(r.charge, undefined, JSON.stringify(over));
      assert.equal(committed.length, 0);
    }
  });

  it('dívida já lançada para essa data (não cancelada): não duplica (ação "exists")', async () => {
    const { deps, committed } = mk({ launched: [debt('sub_new1_2026-12-05', '2026-12-05')] });
    const r = await createSubscription('u1', raw, deps);
    assert.deepEqual([r.charge.ok, r.charge.action, committed.length], [true, 'exists', 0]);
  });

  it('id já usado e CANCELADO (ex.: pausou e retomou): a nova dívida usa uma revisão (_r2), nunca regrava o id', async () => {
    const { deps, committed } = mk({ launched: [debt('sub_new1_2026-12-05', '2026-12-05', { status: 'cancelled' })] });
    const r = await createSubscription('u1', raw, deps);
    assert.equal(r.charge.action, 'launched');
    assert.equal(debtCreates(committed)[0].docId, 'sub_new1_2026-12-05_r2');
  });

  it('corrida no lote (id gravado por outra chamada): vira resultado de falha amigável, a assinatura fica salva', async () => {
    const { deps } = mk({ commit: async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); } });
    const r = await createSubscription('u1', raw, deps);
    assert.deepEqual([r.ok, r.charge.ok], [true, false]);
    assert.match(r.charge.errors._form, /já foi lançada/);
  });

  it('EDITAR data/valor reagenda a MESMA dívida no servidor (sem criar outra); só valor e só data enviam só o que mudou', async () => {
    const previous = { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 };
    const launched = [debt('sub_s1_2026-12-05', '2026-12-05')];
    const both = mk({ previous, launched });
    const r = await updateSubscription('u1', 's1', { ...raw, nextChargeDate: '2026-11-06', amountCents: '70,00' }, both.deps);
    assert.deepEqual([r.ok, r.charge.action, r.charge.date], [true, 'rescheduled', '2026-11-06']);
    assert.deepEqual(both.calls, [['debt.reschedule', { debtId: 'sub_s1_2026-12-05', dueDate: '2026-11-06', principalCents: 7000 }]]);
    assert.equal(both.committed.length, 0); // nenhuma dívida nova
    assert.equal(both.updates.length, 1); // a assinatura foi salva
    const onlyDate = mk({ previous, launched });
    await updateSubscription('u1', 's1', { ...raw, nextChargeDate: '2026-11-06' }, onlyDate.deps);
    assert.deepEqual(onlyDate.calls, [['debt.reschedule', { debtId: 'sub_s1_2026-12-05', dueDate: '2026-11-06' }]]);
    const onlyAmount = mk({ previous, launched });
    await updateSubscription('u1', 's1', { ...raw, amountCents: '60,00' }, onlyAmount.deps);
    assert.deepEqual(onlyAmount.calls, [['debt.reschedule', { debtId: 'sub_s1_2026-12-05', principalCents: 6000 }]]);
  });

  it('editar outro campo (nome) com a dívida já em dia: nenhuma chamada ao servidor nem lote', async () => {
    const { deps, calls, committed, updates } = mk({ previous: { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 }, launched: [debt('sub_s1_2026-12-05', '2026-12-05')] });
    const r = await updateSubscription('u1', 's1', { ...raw, name: 'Netflix 4K' }, deps);
    assert.deepEqual([r.ok, r.charge.action, calls.length, committed.length, updates.length], [true, 'exists', 0, 0, 1]);
  });

  it('vínculo NOVO ao editar (nenhum → devedor): lança a dívida da data atual', async () => {
    const { deps, committed } = mk({ previous: { id: 's1', status: 'active', nextChargeDate: '2026-12-05', amountCents: 5590 } });
    const r = await updateSubscription('u1', 's1', raw, deps);
    assert.equal(r.charge.action, 'launched');
    assert.equal(debtCreates(committed)[0].docId, 'sub_s1_2026-12-05');
  });

  it('REAGENDAR para uma data em que JÁ existe outra cobrança da assinatura: edição abortada, nada muda', async () => {
    const { deps, calls, updates } = mk({
      previous: { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 },
      launched: [debt('sub_s1_2026-12-05', '2026-12-05'), debt('sub_s1_2026-11-06', '2026-11-06')],
    });
    const r = await updateSubscription('u1', 's1', { ...raw, nextChargeDate: '2026-11-06' }, deps);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /06\/11\/2026/);
    assert.equal(calls.length + updates.length, 0);
  });

  it('dívida com RECEBIMENTOS não é reagendada: o servidor recusa e a edição inteira é abortada (assinatura não é salva)', async () => {
    const { deps, updates } = mk({
      previous: { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 },
      launched: [debt('sub_s1_2026-12-05', '2026-12-05')], receipts: ['sub_s1_2026-12-05'],
    });
    const r = await updateSubscription('u1', 's1', { ...raw, nextChargeDate: '2026-11-06' }, deps);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /recebimentos/);
    assert.equal(updates.length, 0);
  });

  it('DESVINCULAR, PAUSAR ou CANCELAR (pela edição) cancela a dívida pendente; com recebimentos ela é mantida e a edição segue', async () => {
    const previous = { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 };
    const launched = [debt('sub_s1_2026-12-05', '2026-12-05')];
    for (const over of [{ debtorId: undefined }, { status: 'paused' }, { status: 'cancelled' }]) {
      const m = mk({ previous, launched });
      const r = await updateSubscription('u1', 's1', { ...raw, ...over }, m.deps);
      assert.deepEqual([r.ok, r.charge.action, m.calls], [true, 'cancelled', [['debt.cancel', { debtId: 'sub_s1_2026-12-05' }]]], JSON.stringify(over));
      assert.equal(m.updates.length, 1);
    }
    const kept = mk({ previous, launched, receipts: ['sub_s1_2026-12-05'] });
    const r = await updateSubscription('u1', 's1', { ...raw, debtorId: undefined }, kept.deps);
    assert.deepEqual([r.ok, r.charge.action, kept.updates.length], [true, 'kept', 1]);
  });

  it('TROCAR de devedor: cancela a dívida do antigo e lança a do novo', async () => {
    const m = mk({
      previous: { id: 's1', status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05', amountCents: 5590 },
      launched: [debt('sub_s1_2026-12-05', '2026-12-05')],
    });
    const r = await updateSubscription('u1', 's1', { ...raw, debtorId: 'dv2' }, m.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(m.calls, [['debt.cancel', { debtId: 'sub_s1_2026-12-05' }]]);
    const created = debtCreates(m.committed)[0];
    assert.deepEqual([created.data.debtorId, created.data.dueDate], ['dv2', '2026-12-05']);
  });

  it('STATUS: pausar/cancelar cancela a dívida pendente; retomar lança de novo (id com revisão); cartão não mexe em dívida', async () => {
    const current = { id: 's1', name: 'Netflix', amountCents: 5590, status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05' };
    const launched = [debt('sub_s1_2026-12-05', '2026-12-05')];
    for (const fn of [pauseSubscription, cancelSubscription]) {
      const m = mk({ previous: current, launched });
      const r = await fn('u1', 's1', m.deps);
      assert.deepEqual([r.ok, r.charge.action, m.calls], [true, 'cancelled', [['debt.cancel', { debtId: 'sub_s1_2026-12-05' }]]]);
      assert.equal(m.updates[0].data.status, fn === pauseSubscription ? 'paused' : 'cancelled');
    }
    const paused = mk({ previous: { ...current, status: 'paused' }, launched: [debt('sub_s1_2026-12-05', '2026-12-05', { status: 'cancelled' })] });
    const resumed = await resumeSubscription('u1', 's1', paused.deps);
    assert.equal(resumed.charge.action, 'launched');
    assert.equal(debtCreates(paused.committed)[0].docId, 'sub_s1_2026-12-05_r2');
    const card = mk({ previous: { ...current, cardId: 'c1' }, launched });
    const rc = await pauseSubscription('u1', 's1', card.deps);
    assert.deepEqual([rc.ok, rc.charge, card.calls.length], [true, undefined, 0]);
  });

  it('EXCLUIR a assinatura cancela a dívida pendente (com recebimentos, mantém); falha ao cancelar impede a exclusão', async () => {
    const sub = { id: 's1', name: 'Netflix', amountCents: 5590, status: 'active', debtorId: 'dv', nextChargeDate: '2026-12-05' };
    const launched = [debt('sub_s1_2026-12-05', '2026-12-05')];
    const ok = mk({ previous: sub, launched });
    const r = await deleteSubscription('u1', 's1', ok.deps);
    assert.deepEqual([r.ok, r.charge.action, ok.calls], [true, 'cancelled', [['debt.cancel', { debtId: 'sub_s1_2026-12-05' }]]]);
    const kept = mk({ previous: sub, launched, receipts: ['sub_s1_2026-12-05'] });
    assert.equal((await deleteSubscription('u1', 's1', kept.deps)).charge.action, 'kept');
    const fail = mk({ previous: sub, launched, finance: async () => ({ ok: false, code: 'NETWORK', errors: { _form: 'sem rede' } }) });
    const rf = await deleteSubscription('u1', 's1', fail.deps);
    assert.equal(rf.ok, false);
  });
});
