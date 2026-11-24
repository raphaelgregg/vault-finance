/**
 * Testes do serviço de Assinaturas (VF-2-03a): modelo, cálculos, CRUD com `io` injetado.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubscription,
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
      ['accountId', 'amountCents', 'cardId', 'categoryId', 'debtorId', 'name', 'nextChargeDate', 'notes', 'periodicity', 'status']
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
    const { io, calls } = makeIo(okCategory);
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
