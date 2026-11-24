/**
 * Testes do serviço de Transferências (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTransferStatusOptions,
  confirmTransfer,
  cancelTransfer,
  canTransitionTransfer,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/transfers.js';
import { buildEntity } from '../../js/core/model.js';
import { createTransfer, updateTransfer } from '../../js/services/transfers.js';

describe('transfers service — validação e helpers', () => {
  it('getTransferStatusOptions retorna status esperados', () => {
    const options = getTransferStatusOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['pending', 'confirmed', 'cancelled']);
  });

  it('formatCents formata corretamente', () => {
    assert.equal(formatCents(10000), 'R$ 100,00');
    assert.equal(formatCents(123456), 'R$ 1.234,56');
  });

  it('parseMoneyToCents aceita formatos pt-BR', () => {
    assert.equal(parseMoneyToCents('100,00'), 10000);
    assert.equal(parseMoneyToCents('1.234,56'), 123456);
  });

  it('buildEntity aceita transferência válida', () => {
    const valid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, data } = buildEntity('transfers', valid);
    assert.ok(ok);
    assert.equal(data.amountCents, 10000);
    assert.equal(data.fromAccountId, 'acc1');
    assert.equal(data.toAccountId, 'acc2');
  });

  it('buildEntity rejeita fromAccountId === toAccountId', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc1',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.ok(errors.toAccountId);
    assert.match(errors.toAccountId, /diferente/);
  });

  it('buildEntity exige amountCents > 0', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '0,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.match(errors.amountCents, /maior que zero/);
  });

  it('buildEntity aceita notes opcional', () => {
    const valid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      notes: 'Transferência para reserva',
      status: 'confirmed',
    };
    const { ok, data } = buildEntity('transfers', valid);
    assert.ok(ok);
    assert.equal(data.notes, 'Transferência para reserva');
  });

  it('buildEntity rejeita date inválida', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-02-30',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.ok(errors.date);
  });
});

/** Cliente de API falso: registra chamadas e devolve a resposta programada (o servidor real é testado em tests/integration). */
function fakeFinance(responder = () => ({ ok: true })) {
  const calls = [];
  const finance = async (op, params, options) => { calls.push({ op, params, options }); return responder(op, params, options); };
  return { finance, calls };
}

describe('transfers service — transições de status (VF-2-01 / VF-ARQ-02)', () => {
  const uid = 'u1';
  const transfer = (status) => ({ id: 't1', status, fromAccountId: 'a1', toAccountId: 'a2', amountCents: 10000 });

  function makeIo({ status = 'pending', exists = true, finance } = {}) {
    const calls = { update: [], audit: [], remove: [] };
    return {
      calls,
      io: {
        getById: async () => (exists ? transfer(status) : null),
        update: async (_u, _c, id, data) => { calls.update.push({ id, data }); },
        remove: async (_u, c, id) => { calls.remove.push([c, id]); },
        writeAudit: async (_u, entry) => { calls.audit.push(entry); },
        ...(finance ? { finance } : {}),
      },
    };
  }

  it('canTransitionTransfer: confirmada é terminal (sair dela é estorno); pendente confirma ou cancela', () => {
    assert.equal(canTransitionTransfer('pending', 'confirmed'), true);
    assert.equal(canTransitionTransfer('pending', 'cancelled'), true);
    assert.equal(canTransitionTransfer('confirmed', 'cancelled'), false);
    assert.equal(canTransitionTransfer('confirmed', 'pending'), false);
    assert.equal(canTransitionTransfer('cancelled', 'confirmed'), false);
    assert.equal(canTransitionTransfer('cancelled', 'pending'), false);
    assert.equal(canTransitionTransfer('x', 'confirmed'), false);
  });

  it('confirmar chama o SERVIDOR (transfer.confirm) e não grava nada direto', async () => {
    const api = fakeFinance(() => ({ ok: true, balanceAfterCents: 1 }));
    const { io, calls } = makeIo({ finance: api.finance });
    const r = await confirmTransfer(uid, 't1', { ...io, operationId: 'op-1' });
    assert.equal(r.ok, true);
    assert.deepEqual(api.calls.map((c) => [c.op, c.params, c.options.operationId]), [['transfer.confirm', { transferId: 't1' }, 'op-1']]);
    assert.deepEqual(calls.update, []);
    assert.deepEqual(calls.audit, []);
  });

  it('erro do servidor (saldo insuficiente) é repassado como veio, com código', async () => {
    const api = fakeFinance(() => ({ ok: false, errors: { _form: 'Saldo insuficiente em Banco: disponível R$ 10,00.' }, code: 'INSUFFICIENT_BALANCE', status: 409 }));
    const r = await confirmTransfer(uid, 't1', makeIo({ finance: api.finance }).io);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INSUFFICIENT_BALANCE');
    assert.match(r.errors._form, /Saldo insuficiente/);
  });

  it('cancelar: pendente grava direto (não move dinheiro) com auditoria; confirmada e cancelada são recusadas', async () => {
    const { io, calls } = makeIo({ status: 'pending' });
    assert.deepEqual(await cancelTransfer(uid, 't1', io), { ok: true });
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].data.status, 'cancelled');
    assert.equal(calls.audit[0].action, 'cancel');
    for (const status of ['confirmed', 'cancelled']) {
      const m = makeIo({ status });
      const r = await cancelTransfer(uid, 't1', m.io);
      assert.equal(r.ok, false);
      assert.deepEqual(m.calls.update, []);
    }
    assert.match((await cancelTransfer(uid, 't1', makeIo({ status: 'confirmed' }).io)).errors._form, /estorne/i);
  });

  it('transferência inexistente retorna erro', async () => {
    const { io } = makeIo({ exists: false });
    assert.equal((await cancelTransfer(uid, 'nope', io)).ok, false);
    assert.equal((await updateTransfer(uid, 'nope', { fromAccountId: 'a1', toAccountId: 'a2', amountCents: '10,00', date: '2026-12-02', reason: 'x', status: 'pending' }, io)).ok, false);
  });

  it('editar transferência confirmada é recusado (imutável) sem escrita e sem chamar o servidor', async () => {
    const api = fakeFinance();
    const m = makeIo({ status: 'confirmed', finance: api.finance });
    const r = await updateTransfer(uid, 't1', { fromAccountId: 'a1', toAccountId: 'a2', amountCents: '99,00', date: '2026-12-02', reason: 'x', status: 'confirmed' }, m.io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /estorne/i);
    assert.deepEqual(m.calls.update, []);
    assert.deepEqual(api.calls, []);
  });

  it('transferência cancelada/estornada NÃO pode ser reaberta nem confirmada de novo (ficaria presa); editar mantendo cancelada é permitido', async () => {
    for (const status of ['pending', 'confirmed']) {
      const api = fakeFinance();
      const m = makeIo({ status: 'cancelled', finance: api.finance });
      const r = await updateTransfer(uid, 't1', { fromAccountId: 'a1', toAccountId: 'a2', amountCents: '99,00', date: '2026-12-02', reason: 'x', status }, m.io);
      assert.equal(r.ok, false, status);
      assert.match(r.errors.status, /não pode ser reaberta/i);
      assert.deepEqual(m.calls.update, []);
      assert.deepEqual(api.calls, []);
    }
    const keep = makeIo({ status: 'cancelled' });
    assert.equal((await updateTransfer(uid, 't1', { fromAccountId: 'a1', toAccountId: 'a2', amountCents: '99,00', date: '2026-12-02', reason: 'só nota', status: 'cancelled' }, keep.io)).ok, true);
  });

  it('editar pendente para confirmada: grava como pendente e confirma NO SERVIDOR (o débito só existe após confirmar)', async () => {
    const api = fakeFinance();
    const m = makeIo({ status: 'pending', finance: api.finance });
    const r = await updateTransfer(uid, 't1', { fromAccountId: 'a1', toAccountId: 'a2', amountCents: '99,00', date: '2026-12-02', reason: 'x', status: 'confirmed' }, m.io);
    assert.equal(r.ok, true);
    assert.equal(m.calls.update[0].data.status, 'pending');
    assert.equal(m.calls.update[0].data.amountCents, 9900);
    assert.deepEqual(api.calls.map((c) => c.op), ['transfer.confirm']);
  });
});

describe('transfers service — criação no servidor (VF-ARQ-02)', () => {
  const uid = 'u1';
  const payload = (over = {}) => ({ fromAccountId: 'a1', toAccountId: 'a2', amountCents: '300,00', date: '2026-12-02', reason: 'Reserva', status: 'confirmed', ...over });

  it('confirmada: envia ao servidor valores em centavos inteiros + operationId, sem saldo/total do cliente', async () => {
    const api = fakeFinance(() => ({ ok: true, transferId: 'T9', status: 'confirmed' }));
    const calls = { create: [] };
    const io = { finance: api.finance, create: async (...a) => { calls.create.push(a); return 'x'; } };
    const r = await createTransfer(uid, payload({ operationId: 'op-77' }), io);
    assert.equal(r.ok, true);
    assert.equal(r.id, 'T9');
    assert.equal(api.calls.length, 1);
    const { op, params, options } = api.calls[0];
    assert.equal(op, 'transfer.create');
    assert.equal(options.operationId, 'op-77');
    assert.equal(params.amountCents, 30000);
    assert.equal(params.status, 'confirmed');
    for (const forbidden of ['balanceCents', 'receivedCents', 'uid', 'operationId']) assert.equal(forbidden in params, false);
    assert.deepEqual(calls.create, []); // nenhuma gravação direta
  });

  it('pendente também nasce no servidor; cancelada (não move dinheiro) grava direto', async () => {
    const api = fakeFinance(() => ({ ok: true, transferId: 'T1', status: 'pending' }));
    const writes = [];
    const io = { finance: api.finance, create: async (_u, c, data) => { writes.push([c, data.status]); return 'direct1'; }, writeAudit: async () => {} };
    assert.equal((await createTransfer(uid, payload({ status: 'pending' }), io)).id, 'T1');
    assert.equal((await createTransfer(uid, payload({ status: 'cancelled' }), io)).id, 'direct1');
    assert.deepEqual(api.calls.map((c) => c.op), ['transfer.create']);
    assert.deepEqual(writes, [['transfers', 'cancelled']]);
  });

  it('validação do formulário falha antes de chamar o servidor', async () => {
    const api = fakeFinance();
    const r = await createTransfer(uid, payload({ toAccountId: 'a1' }), { finance: api.finance });
    assert.equal(r.ok, false);
    assert.deepEqual(api.calls, []);
  });

  it('erro do servidor (saldo insuficiente / conta inativa) volta com código e mensagem reais', async () => {
    const api = fakeFinance(() => ({ ok: false, errors: { _form: 'Saldo insuficiente.' }, code: 'INSUFFICIENT_BALANCE', status: 409 }));
    const r = await createTransfer(uid, payload(), { finance: api.finance });
    assert.deepEqual([r.ok, r.code], [false, 'INSUFFICIENT_BALANCE']);
  });
});

describe('transfers service — exclusão', () => {
  const uid = 'u1';
  const io = (status) => {
    const calls = { remove: [], audit: [] };
    return { calls, io: {
      getById: async () => ({ id: 't1', status, fromAccountId: 'a1', toAccountId: 'a2', amountCents: 25000 }),
      remove: async (_u, c, id) => { calls.remove.push([c, id]); },
      writeAudit: async (_u, e) => { calls.audit.push(e); },
    } };
  };
  it('transferência CONFIRMADA não é excluída (histórico): orienta estornar; nada é removido', async () => {
    const { io: deps, calls } = io('confirmed');
    const { deleteTransfer } = await import('../../js/services/transfers.js');
    const r = await deleteTransfer(uid, 't1', deps);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /estorne/i);
    assert.deepEqual(calls.remove, []);
  });
  it('exclui pendente e cancelada (sem efeito no saldo) com auditoria', async () => {
    const { deleteTransfer } = await import('../../js/services/transfers.js');
    for (const status of ['pending', 'cancelled']) {
      const { io: deps, calls } = io(status);
      assert.deepEqual(await deleteTransfer(uid, 't1', deps), { ok: true, reversed: false, amountCents: 25000 });
      assert.deepEqual(calls.remove, [['transfers', 't1']]);
      assert.equal(calls.audit[0].action, 'delete');
    }
  });
});
