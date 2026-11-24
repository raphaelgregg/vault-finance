/**
 * Camada confiável — validação e roteamento SEM banco (os caminhos que recusam antes de tocar o Firestore) e utilitários
 * puros. As garantias transacionais (saldo, idempotência, concorrência) estão em tests/integration (Firebase Emulator).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleFinance, registry } from '../../server/finance/index.mjs';
import { v, requestHash, FinanceError, isTransient } from '../../server/finance/core.mjs';

const verifyIdToken = async (t) => { if (t !== 'good') throw new Error('bad'); return { uid: 'alice' }; };
const call = (over = {}, deps = {}) => handleFinance({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { op: 'transfer.create', operationId: 'op-12345678', params: {}, ...over }, ...over.req }, { db: {}, verifyIdToken, log: () => {}, ...deps });

describe('handleFinance — recusas antes do banco', () => {
  it('método, token ausente/inválido, corpo inválido, operação desconhecida e operationId inválido', async () => {
    assert.equal((await handleFinance({ method: 'GET', headers: {}, body: null }, { db: {}, verifyIdToken, log: () => {} })).status, 405);
    assert.equal((await handleFinance({ method: 'POST', headers: {}, body: {} }, { db: {}, verifyIdToken, log: () => {} })).status, 401);
    assert.equal((await handleFinance({ method: 'POST', headers: { authorization: 'Bearer ruim' }, body: {} }, { db: {}, verifyIdToken, log: () => {} })).status, 401);
    assert.equal((await handleFinance({ method: 'POST', headers: { authorization: 'Bearer good' }, body: '{json quebrado' }, { db: {}, verifyIdToken, log: () => {} })).status, 400);
    assert.ok([400, 404].includes((await call({ op: 'nao.existe' })).status));
    for (const operationId of ['', 'curto', 'espaço no meio 123', 'x'.repeat(101), undefined, 12345678]) assert.equal((await call({ operationId })).status, 400, String(operationId));
  });

  it('parâmetros proibidos (uid, userId, balanceCents, receivedCents) e valores inválidos são recusados (400) sem tocar o banco', async () => {
    for (const forbidden of ['uid', 'userId', 'balanceCents', 'receivedCents']) {
      const r = await call({ params: { [forbidden]: 1, fromAccountId: 'a', toAccountId: 'b', amountCents: 1, date: '2026-12-01', reason: 'x', status: 'confirmed' } });
      assert.deepEqual([r.status, r.body.error], [400, 'FORBIDDEN_PARAM'], forbidden);
    }
    const bad = await call({ params: { fromAccountId: 'a', toAccountId: 'b', amountCents: 10.5, date: '2026-12-01', reason: 'x', status: 'confirmed' } });
    assert.equal(bad.status, 400);
  });

  it('toda operação de dinheiro está registrada no servidor', () => {
    for (const op of ['transfer.create', 'transfer.confirm', 'income.create', 'income.receive', 'expense.create', 'expense.pay', 'invoice.pay', 'goal.deposit', 'goal.withdraw',
      'debt.receive', 'debt.settleBatch', 'debt.cancel', 'debt.cancelMany', 'debt.reschedule', 'reversal.create', 'account.adjustOpening', 'account.archive', 'account.unarchive', 'account.delete', 'debtor.archive', 'debtor.unarchive', 'debtor.delete', 'data.clearOwn']) {
      assert.ok(registry.has?.(op) ?? registry[op], op);
    }
  });
});

describe('validadores e utilitários', () => {
  it('centavos: só inteiros positivos até o teto; datas AAAA-MM-DD reais', () => {
    assert.equal(v.cents(100), 100);
    for (const bad of [0, -1, 1.5, '10', NaN, Infinity, 1e12, null, undefined]) assert.throws(() => v.cents(bad), FinanceError, String(bad));
    assert.equal(v.date('2026-02-28'), '2026-02-28');
    for (const bad of ['2026-02-30', '2026-13-01', '28/02/2026', 20260228, '', null]) assert.throws(() => v.date(bad), FinanceError, String(bad));
  });

  it('requestHash é determinístico, independente da ordem das chaves, e sensível a qualquer mudança', () => {
    const a = requestHash('transfer.create', { x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    assert.equal(a, requestHash('transfer.create', { z: { a: 1, b: 2 }, y: [1, 2], x: 1 }));
    assert.notEqual(a, requestHash('transfer.create', { x: 2, y: [1, 2], z: { a: 1, b: 2 } }));
    assert.notEqual(a, requestHash('transfer.confirm', { x: 1, y: [1, 2], z: { a: 1, b: 2 } }));
    assert.equal(requestHash('o', { a: 1, b: undefined }), requestHash('o', { a: 1 }));
  });

  it('falhas transitórias (contenção/expiração) são repetíveis; erros de negócio não', () => {
    assert.equal(isTransient({ code: 10 }), true);
    assert.equal(isTransient({ code: 14 }), true);
    assert.equal(isTransient({ code: 3, message: '3 INVALID_ARGUMENT: Transaction is invalid or closed.' }), true);
    assert.equal(isTransient({ code: 3, message: 'valor inválido' }), false);
    assert.equal(isTransient(new FinanceError(409, 'INSUFFICIENT_BALANCE', 'x')), false);
  });
});

describe('withRetries — política de repetição do servidor (auditoria VF-ARQ-02)', () => {
  it('repete só falha transitória, no máximo SERVER_ATTEMPTS no total, com backoff linear + jitter; não repete erro de negócio nem INVALID_ARGUMENT comum', async () => {
    const { withRetries, SERVER_ATTEMPTS, retryDelayMs } = await import('../../server/finance/core.mjs');
    assert.equal(SERVER_ATTEMPTS, 4);
    const slept = [];
    const opts = { sleep: async (ms) => { slept.push(ms); }, random: () => 0.5 };
    let calls = 0;
    await assert.rejects(() => withRetries(async () => { calls += 1; throw Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), { code: 3 }); }, opts), /Transaction is invalid/);
    assert.equal(calls, 4);
    assert.deepEqual(slept, [25 * 1 + 20, 25 * 2 + 20, 25 * 3 + 20]); // 45, 70, 95 ms (jitter fixo em 0,5 → 20 ms)
    for (const attempt of [1, 2, 3]) {
      for (const r of [0, 0.999]) { const d = retryDelayMs(attempt, () => r); assert.ok(d >= 25 * attempt && d < 25 * attempt + 40); }
    }
    // sucesso na 3ª tentativa
    let n = 0;
    assert.equal(await withRetries(async () => { n += 1; if (n < 3) throw Object.assign(new Error('x'), { code: 10 }); return 'ok'; }, { sleep: async () => {} }), 'ok');
    // não repete: erro de negócio, INVALID_ARGUMENT de outro motivo, erro desconhecido
    for (const error of [new FinanceError(409, 'INSUFFICIENT_BALANCE', 'x'), Object.assign(new Error('3 INVALID_ARGUMENT: valor inválido'), { code: 3 }), new Error('boom')]) {
      let c = 0;
      await assert.rejects(() => withRetries(async () => { c += 1; throw error; }, { sleep: async () => {} }));
      assert.equal(c, 1, error.message);
    }
  });
});
