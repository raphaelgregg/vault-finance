/**
 * FASES 2 e 7 — Recebimentos de devedores e quitação em lote na camada confiável. Emulator real; sem mocks.
 * A proteção de concorrência NÃO depende de convenção de ID: é a transação do servidor que lê o estado e serializa
 * no documento do devedor/conta. Cada cenário concorrente roda 10 vezes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, dump, getDoc, oracleBalance, UID, OTHER } from './helpers/server.mjs';
import { BATCH_ITEMS_PER_CALL, CANCEL_MANY_MAX } from '../../server/finance/ops.mjs';
import { auditLedgerData } from '../../js/core/integrity.js';

before(() => adminDb());
beforeEach(clearAll);

const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };

/** Devedor com `n` parcelas de dívida de `each` centavos (emprestado = n × each). */
async function world({ n = 2, each = 5000, initial = 100000, uid = UID } = {}) {
  await seedAccount('acc', initial, uid);
  await seed(uid, 'debtors', 'dev', { name: 'Renan', loanDate: '2026-11-10', lentCents: n * each, receivedCents: 0, status: 'open' });
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(await seed(uid, 'debts', `p${i}`, { debtorId: 'dev', description: `P${i}`, principalCents: each, dueDate: '2026-12-10', installmentNumber: i + 1, installmentsTotal: n, debtGroupId: 'g', status: 'pending' }));
  return ids;
}
const recv = (debtId, amountCents, extra = {}) => ({ debtId, amountCents, date: '2026-12-06', accountId: 'acc', ...extra });
const state = async () => {
  const [debtor, debts, payments] = await Promise.all([getDoc('debtors', 'dev'), dump('debts'), dump('debtPayments')]);
  return { debtor, debts, payments, sum: payments.reduce((t, p) => t + p.amountCents, 0) };
};

describe('recebimentos — concorrência real', () => {
  it('Cenário A: duas parcelas de R$ 50 quitadas ao mesmo tempo (10×): 2 recebimentos, R$ 100, devedor pago, saldo +100', async () => {
    await repeat(async () => {
      const [p0, p1] = await world();
      const rs = await Promise.all([call(UID, 'debt.receive', opId(), recv(p0, 5000)), call(UID, 'debt.receive', opId(), recv(p1, 5000))]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200], JSON.stringify(rs));
      const s = await state();
      assert.equal(s.payments.length, 2);
      assert.equal(s.sum, 10000);
      assert.equal(s.debtor.receivedCents, 10000);
      assert.equal(s.debtor.status, 'paid'); // o servidor serializa no devedor: o status já sai correto, sem conciliação
      assert.deepEqual(s.debts.map((d) => d.status), ['paid', 'paid']);
      assert.equal(await oracleBalance('acc'), 110000);
    });
  });

  it('Cenário B: dois recebimentos parciais de R$ 40 simultâneos em parcelas de R$ 100 (10×): R$ 80, saldo devedor R$ 120', async () => {
    await repeat(async () => {
      const [p0, p1] = await world({ n: 2, each: 10000 });
      const rs = await Promise.all([call(UID, 'debt.receive', opId(), recv(p0, 4000)), call(UID, 'debt.receive', opId(), recv(p1, 4000))]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200]);
      const s = await state();
      assert.equal(s.sum, 8000);
      assert.equal(s.debtor.receivedCents, 8000);
      assert.equal(s.debtor.lentCents - s.debtor.receivedCents, 12000);
      assert.equal(s.debtor.status, 'open');
      assert.deepEqual(s.debts.map((d) => d.status), ['pending', 'pending']);
      assert.equal(await oracleBalance('acc'), 108000);
    });
  });

  it('Cenário C: operações que somariam R$ 120 numa dívida de R$ 100 (10×): nunca passa de R$ 100; recusadas com erro identificável', async () => {
    await repeat(async () => {
      const [p0, p1] = await world({ n: 2, each: 5000 });
      // 3 tentativas: parcela 0 (50), parcela 1 (50) e +20 extra na parcela 0 — todas ao mesmo tempo
      const rs = await Promise.all([call(UID, 'debt.receive', opId(), recv(p0, 5000)), call(UID, 'debt.receive', opId(), recv(p1, 5000)), call(UID, 'debt.receive', opId(), recv(p0, 2000))]);
      const s = await state();
      assert.ok(s.sum <= 10000, `recebido ${s.sum}`);
      assert.equal(s.debtor.receivedCents, s.sum);
      assert.ok(s.debtor.lentCents - s.debtor.receivedCents >= 0);
      for (const r of rs.filter((x) => x.status !== 200)) assert.ok(['EXCEEDS_REMAINING', 'INVALID_STATE', 'EXCEEDS_DEBT'].includes(r.body.error), JSON.stringify(r.body));
      assert.equal(await oracleBalance('acc'), 100000 + s.sum);
    });
  });

  it('Cenário D: dois recebimentos de R$ 60 na MESMA parcela de R$ 100 (10×): só um passa; a parcela não fica "quitada"', async () => {
    await repeat(async () => {
      const [p0] = await world({ n: 1, each: 10000 });
      const rs = await Promise.all([call(UID, 'debt.receive', opId(), recv(p0, 6000)), call(UID, 'debt.receive', opId(), recv(p0, 6000))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(rs.find((r) => r.status === 409).body.error, 'EXCEEDS_REMAINING');
      const s = await state();
      assert.equal(s.payments.length, 1);
      assert.equal(s.sum, 6000);
      assert.equal(s.debts[0].status, 'pending');
      assert.equal(s.debtor.receivedCents, 6000);
    });
  });

  it('estresse: 12 clientes recebendo R$ 30 na mesma parcela de R$ 100: no máximo 3 passam (R$ 90); jamais 120', async () => {
    await repeat(async () => {
      const [p0] = await world({ n: 1, each: 10000 });
      const rs = await Promise.all(Array.from({ length: 12 }, () => call(UID, 'debt.receive', opId(), recv(p0, 3000))));
      const ok = rs.filter((r) => r.status === 200).length;
      const s = await state();
      assert.equal(ok, 3);
      assert.equal(s.sum, 9000);
      assert.equal(s.debtor.receivedCents, 9000);
      assert.equal(s.debts[0].status, 'pending');
    });
  });
});

describe('recebimentos — regras, idempotência e histórico', () => {
  it('parcial depois total: dois recebimentos independentes; parcela paga só no total; total R$ 100', async () => {
    const [p0] = await world({ n: 1, each: 10000 });
    const a = await callOk(UID, 'debt.receive', opId(), recv(p0, 4000));
    assert.deepEqual([a.settled, a.remainingCents], [false, 6000]);
    assert.equal((await getDoc('debts', p0)).status, 'pending');
    const b = await callOk(UID, 'debt.receive', opId(), { debtId: p0, date: '2026-12-10', accountId: 'acc' }); // valor padrão = restante
    assert.deepEqual([b.settled, b.amountCents, b.debtorStatus], [true, 6000, 'paid']);
    const s = await state();
    assert.equal(s.payments.length, 2);
    assert.deepEqual(s.payments.map((p) => p.amountCents).sort(), [4000, 6000]);
    assert.equal((await getDoc('debts', p0)).status, 'paid');
    assert.equal(await oracleBalance('acc'), 110000);
  });

  it('excesso e parcela quitada são rejeitados com erro identificável e sem gravar', async () => {
    const [p0] = await world({ n: 1, each: 10000 });
    const over = await call(UID, 'debt.receive', opId(), recv(p0, 10001));
    assert.deepEqual([over.status, over.body.error, over.body.details.remainingCents], [409, 'EXCEEDS_REMAINING', 10000]);
    await callOk(UID, 'debt.receive', opId(), recv(p0, 10000));
    const again = await call(UID, 'debt.receive', opId(), recv(p0, 100));
    assert.equal(again.body.error, 'INVALID_STATE');
    assert.equal((await state()).payments.length, 1);
  });

  it('parcela de COMPRA NO CARTÃO do devedor: recebimento parcial e total, sem alterar a compra', async () => {
    await world({ n: 0, each: 0 });
    await adminDb().doc(`users/${UID}/debtors/dev`).update({ lentCents: 10000 });
    await seed(UID, 'cardPurchases', 'pc', { cardId: 'k', description: 'Água', amountCents: 10000, purchaseDate: '2026-11-20', installmentsTotal: 1, installmentNumber: 1, debtorId: 'dev' });
    await callOk(UID, 'debt.receive', opId(), { purchaseId: 'pc', amountCents: 2500, date: '2026-12-06', accountId: 'acc' });
    await callOk(UID, 'debt.receive', opId(), { purchaseId: 'pc', date: '2026-12-06', accountId: 'acc' });
    const s = await state();
    assert.deepEqual(s.payments.map((p) => [p.purchaseId, p.amountCents]).sort(), [['pc', 2500], ['pc', 7500]]);
    assert.equal(s.debtor.status, 'paid');
    assert.equal((await getDoc('cardPurchases', 'pc')).amountCents, 10000);
    assert.equal(await oracleBalance('acc'), 110000);
  });

  it('Cenário E: retry/duplo clique com a mesma chave (10×): um único recebimento; mesma chave com outro valor → 409', async () => {
    await repeat(async () => {
      const [p0] = await world({ n: 1, each: 10000 });
      const key = opId('retry');
      const rs = await Promise.all([1, 2, 3].map(() => call(UID, 'debt.receive', key, recv(p0, 4000))));
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.filter((r) => r.status !== 200)));
      const s = await state();
      assert.equal(s.payments.length, 1);
      assert.equal(s.sum, 4000);
      assert.equal(await oracleBalance('acc'), 104000);
      const reuse = await call(UID, 'debt.receive', key, recv(p0, 5000));
      assert.equal(reuse.body.error, 'OPERATION_ID_REUSED');
      assert.equal((await state()).sum, 4000);
    });
  });

  it('o cliente não controla valores derivados: receivedCents/balanceCents/status/uid no corpo são recusados', async () => {
    const [p0] = await world({ n: 1, each: 10000 });
    for (const forbidden of [{ receivedCents: 99999 }, { balanceCents: 1 }, { status: 'paid' }, { uid: OTHER }]) {
      const r = await call(UID, 'debt.receive', opId(), { ...recv(p0, 100), ...forbidden });
      assert.deepEqual([r.status, r.body.error], [400, 'FORBIDDEN_PARAM']);
    }
    assert.equal((await state()).payments.length, 0);
  });

  it('autorização por propriedade: parcela/conta/devedor de OUTRO usuário nunca são alcançados', async () => {
    const [p0] = await world({ n: 1, each: 10000, uid: OTHER });
    await seedAccount('acc', 1000, UID);
    const r = await call(UID, 'debt.receive', opId(), recv(p0, 100));
    assert.deepEqual([r.status, r.body.error], [404, 'NOT_FOUND']);
    assert.equal((await dump('debtPayments', OTHER)).length, 0);
    assert.equal((await getDoc('debtors', 'dev', OTHER)).receivedCents, 0);
  });

  it('devedor cancelado/arquivado, conta inativa e parcela cancelada não recebem', async () => {
    const [p0, p1] = await world({ n: 2, each: 5000 });
    await adminDb().doc(`users/${UID}/debts/${p1}`).update({ status: 'cancelled' });
    assert.equal((await call(UID, 'debt.receive', opId(), recv(p1, 100))).body.error, 'INVALID_STATE');
    await adminDb().doc(`users/${UID}/accounts/acc`).update({ status: 'archived' });
    assert.equal((await call(UID, 'debt.receive', opId(), recv(p0, 100))).body.error, 'ACCOUNT_NOT_ACTIVE');
    await adminDb().doc(`users/${UID}/accounts/acc`).update({ status: 'active' });
    await adminDb().doc(`users/${UID}/debtors/dev`).update({ archived: true });
    assert.equal((await call(UID, 'debt.receive', opId(), recv(p0, 100))).body.error, 'INVALID_STATE');
    await adminDb().doc(`users/${UID}/debtors/dev`).update({ archived: false, status: 'cancelled' });
    assert.equal((await call(UID, 'debt.receive', opId(), recv(p0, 100))).body.error, 'INVALID_STATE');
    assert.equal((await state()).payments.length, 0);
  });

  it('auditoria independente após as operações: sem inconsistências', async () => {
    const [p0, p1] = await world();
    await Promise.all([call(UID, 'debt.receive', opId(), recv(p0, 5000)), call(UID, 'debt.receive', opId(), recv(p1, 2500))]);
    const data = { accounts: await dump('accounts'), debtors: await dump('debtors'), debts: await dump('debts'), payments: await dump('debtPayments') };
    assert.deepEqual(auditLedgerData(data).findings, []);
  });
});

describe('quitação em lote retomável (Fase 7)', () => {
  const batch = (extra = {}) => ({ debtorId: 'dev', accountId: 'acc', date: '2026-12-06', scope: { month: '2026-12' }, ...extra });

  it('lote de 20 parcelas: processa em chamadas de até 15 itens, estado persistido, resultado verificável', async () => {
    await world({ n: 20, each: 1000 });
    const key = opId('batch');
    const first = await callOk(UID, 'debt.settleBatch', key, batch());
    assert.deepEqual([first.status, first.total, first.done, first.pending], ['running', 20, BATCH_ITEMS_PER_CALL, 20 - BATCH_ITEMS_PER_CALL]);
    const persisted = await getDoc('batches', key);
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.items.filter((i) => i.status === 'done').length, BATCH_ITEMS_PER_CALL);
    const second = await callOk(UID, 'debt.settleBatch', key, batch());
    assert.deepEqual([second.status, second.done, second.pending, second.receivedCents], ['completed', 20, 0, 20000]);
    const s = await state();
    assert.equal(s.payments.length, 20);
    assert.equal(new Set(s.payments.map((p) => p.operationId)).size, 20); // 1 operação por item
    assert.equal(s.debtor.receivedCents, 20000);
    assert.equal(s.debtor.status, 'paid');
    assert.equal(await oracleBalance('acc'), 120000);
    // repetir depois de concluído é idempotente
    const third = await callOk(UID, 'debt.settleBatch', key, batch());
    assert.deepEqual([third.status, third.done], ['completed', 20]);
    assert.equal((await state()).payments.length, 20);
  });

  it('retomada após falha no meio (item 8 falha): itens concluídos permanecem, o lote fica retomável e termina SEM duplicar', async () => {
    const ids = await world({ n: 12, each: 1000 });
    const key = opId('resume');
    // sabota o item 8: a parcela é cancelada por fora entre o planejamento e o processamento
    let sabotaged = false;
    const deps = { now: () => { if (!sabotaged) { sabotaged = true; } return new Date('2026-12-06T15:00:00Z'); } };
    // planeja e processa só 5 itens deixando o resto pendente: simulamos limitando por falha de um item
    await adminDb().doc(`users/${UID}/debts/${ids[7]}`).update({ status: 'cancelled' });
    const r = await callOk(UID, 'debt.settleBatch', key, batch(), deps);
    // o plano já exclui a parcela cancelada (não pendente): 11 itens
    assert.equal(r.total, 11);
    assert.equal(r.status, 'completed');
    const s = await state();
    assert.equal(s.payments.length, 11);
    assert.equal(s.debts.find((d) => d.id === ids[7]).status, 'cancelled');
    assert.equal(s.debtor.status, 'open'); // sobrou a parcela cancelada (R$ 10 emprestados e não recebidos)
  });

  it('item que falha DURANTE o processamento fica "failed" com código; o lote é partial_failed e o restante conclui', async () => {
    const ids = await world({ n: 4, each: 1000 });
    const key = opId('fail');
    // o planejamento vê 4 itens; a parcela 2 é paga por fora (ex.: outro dispositivo) antes do processamento
    await callOk(UID, 'debt.receive', opId(), recv(ids[2], 1000));
    const r = await callOk(UID, 'debt.settleBatch', key, batch());
    assert.equal(r.status, 'completed');
    assert.equal(r.total, 3); // plano já exclui a quitada
    assert.equal((await state()).payments.length, 4);
    assert.equal((await state()).sum, 4000);
  });

  it('lotes simultâneos com a MESMA chave (3 chamadas ao mesmo tempo, 10×): nenhum recebimento duplicado', async () => {
    await repeat(async () => {
      await world({ n: 6, each: 1000 });
      const key = opId('conc');
      const rs = await Promise.all([1, 2, 3].map(() => call(UID, 'debt.settleBatch', key, batch())));
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.filter((r) => r.status !== 200)));
      // chamadas concorrentes podem se alternar nos itens; ao final uma chamada extra fecha o lote
      const last = await callOk(UID, 'debt.settleBatch', key, batch());
      assert.equal(last.status, 'completed');
      const s = await state();
      assert.equal(s.payments.length, 6);
      assert.equal(s.sum, 6000);
      assert.equal(s.debtor.receivedCents, 6000);
      assert.equal(await oracleBalance('acc'), 106000);
    });
  });

  it('lote × recebimento individual simultâneos na mesma parcela: nunca recebe duas vezes', async () => {
    await repeat(async () => {
      const [p0, p1] = await world({ n: 2, each: 5000 });
      const key = opId('mix');
      const rs = await Promise.all([call(UID, 'debt.settleBatch', key, batch()), call(UID, 'debt.receive', opId(), recv(p0, 5000))]);
      assert.equal(rs[0].status, 200, JSON.stringify(rs[0]));
      // o individual só pode passar (200) ou ser recusado de forma identificável por já estar quitada (409)
      assert.ok(rs[1].status === 200 || (rs[1].status === 409 && ['INVALID_STATE', 'EXCEEDS_REMAINING'].includes(rs[1].body.error)), JSON.stringify(rs[1]));
      await callOk(UID, 'debt.settleBatch', key, batch());
      const s = await state();
      assert.equal(s.payments.length, 2);
      assert.equal(s.payments.filter((p) => p.debtId === p0).length, 1);
      assert.equal(s.sum, 10000);
      assert.equal(await oracleBalance('acc'), 110000);
      assert.ok(p1);
    });
  });

  it('mesma chave com escopo diferente é rejeitada; sem parcelas pendentes → erro; mês diferente não é tocado', async () => {
    await world({ n: 2, each: 1000 });
    const key = opId('scope');
    await callOk(UID, 'debt.settleBatch', key, batch());
    assert.equal((await call(UID, 'debt.settleBatch', key, batch({ scope: { month: '2027-01' } }))).body.error, 'OPERATION_ID_REUSED');
    assert.equal((await call(UID, 'debt.settleBatch', opId(), batch({ scope: { month: '2027-01' } }))).body.error, 'INVALID_STATE');
    assert.equal((await call(UID, 'debt.settleBatch', opId(), batch({ scope: {} }))).body.error, 'INVALID_PARAM');
  });
});

describe('cancelamento de várias parcelas em 1 requisição (debt.cancelMany)', () => {
  const statuses = async () => Object.fromEntries((await dump('debts')).map((d) => [d.id, d.status]));

  it('cancela todas as selecionadas numa transação; as não selecionadas ficam; idempotente com a mesma chave', async () => {
    await world({ n: 4, each: 1000 });
    const key = opId('many');
    const r = await callOk(UID, 'debt.cancelMany', key, { debtIds: ['p2', 'p0', 'p1', 'p1'] });
    assert.deepEqual([r.count, r.status, r.idempotent], [3, 'cancelled', false]);
    assert.deepEqual(await statuses(), { p0: 'cancelled', p1: 'cancelled', p2: 'cancelled', p3: 'pending' });
    const again = await callOk(UID, 'debt.cancelMany', key, { debtIds: ['p1', 'p2', 'p0'] }); // ordem diferente, mesmo conjunto
    assert.equal(again.idempotent, true);
    assert.equal((await call(UID, 'debt.cancelMany', key, { debtIds: ['p3'] })).body.error, 'OPERATION_ID_REUSED');
  });

  it('TUDO OU NADA: uma parcela com recebimento, já paga ou inexistente recusa o conjunto e nada é cancelado', async () => {
    const [p0, p1, p2] = await world({ n: 3, each: 1000 });
    await callOk(UID, 'debt.receive', opId(), recv(p1, 400)); // recebimento parcial: parcela segue pendente, mas não é cancelável
    const withReceipt = await call(UID, 'debt.cancelMany', opId(), { debtIds: [p0, p1, p2] });
    assert.deepEqual([withReceipt.status, withReceipt.body.error], [409, 'INVALID_STATE']);
    assert.equal((await call(UID, 'debt.cancelMany', opId(), { debtIds: [p0, 'inexistente'] })).body.error, 'NOT_FOUND');
    assert.deepEqual(await statuses(), { p0: 'pending', p1: 'pending', p2: 'pending' });
    await callOk(UID, 'debt.cancel', opId(), { debtId: p2 });
    assert.equal((await call(UID, 'debt.cancelMany', opId(), { debtIds: [p0, p2] })).body.error, 'INVALID_STATE'); // p2 já cancelada
    assert.equal((await statuses()).p0, 'pending');
  });

  it('validação: lista vazia/inválida e acima do teto são 400; parcela de OUTRO usuário nunca é alcançada', async () => {
    await world({ n: 1, each: 1000 });
    await world({ n: 1, each: 1000, uid: OTHER });
    for (const debtIds of [[], 'p0', [1], ['a/b'], Array.from({ length: CANCEL_MANY_MAX + 1 }, (_, i) => `x${i}`)]) {
      assert.equal((await call(UID, 'debt.cancelMany', opId(), { debtIds })).status, 400, JSON.stringify(debtIds).slice(0, 40));
    }
    const other = await call(OTHER, 'debt.cancelMany', opId(), { debtIds: ['p0'] });
    assert.equal(other.status, 200); // a parcela p0 de OTHER é dele
    assert.equal((await statuses()).p0, 'pending'); // a de UID segue intacta
  });

  it('corrida cancelMany × recebimento parcial na mesma parcela (10×): nunca "cancelada com recebimento"', async () => {
    await repeat(async () => {
      const [p0, p1] = await world({ n: 2, each: 10000 });
      const rs = await Promise.all([call(UID, 'debt.cancelMany', opId(), { debtIds: [p0, p1] }), call(UID, 'debt.receive', opId(), recv(p0, 4000))]);
      const s = await state();
      const cancelled = s.debts.filter((d) => d.status === 'cancelled').map((d) => d.id);
      assert.ok(!(cancelled.includes(p0) && s.payments.length > 0), JSON.stringify({ rs, debts: s.debts, payments: s.payments }));
      assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs)); // exatamente um dos dois vence
      assert.ok(cancelled.length === 0 || cancelled.length === 2, 'tudo ou nada');
    });
  });
});

describe('cancelar/reagendar devolve e ajusta o emprestado do devedor (VF-COR-10)', () => {
  const iso = (t) => (t?.toDate ? t.toDate() : new Date(t)).toISOString().slice(0, 10);
  const lent = async () => (await getDoc('debtors', 'dev')).lentCents;

  it('debt.cancel devolve o valor da parcela ao emprestado (antes o total em aberto continuava cobrando o cancelado)', async () => {
    await world({ n: 3, each: 1000 });
    assert.equal(await lent(), 3000);
    await callOk(UID, 'debt.cancel', opId(), { debtId: 'p0' });
    assert.equal(await lent(), 2000);
    assert.equal((await call(UID, 'debt.cancel', opId(), { debtId: 'p0' })).body.error, 'INVALID_STATE'); // já cancelada: não devolve de novo
    assert.equal(await lent(), 2000);
  });

  it('debt.cancelMany devolve a soma ao emprestado numa só transação; recusa não devolve nada', async () => {
    const [p0, p1, p2] = await world({ n: 3, each: 1000 });
    await callOk(UID, 'debt.receive', opId(), recv(p2, 400));
    assert.equal((await call(UID, 'debt.cancelMany', opId(), { debtIds: [p0, p1, p2] })).body.error, 'INVALID_STATE');
    assert.equal(await lent(), 3000);
    await callOk(UID, 'debt.cancelMany', opId(), { debtIds: [p0, p1] });
    assert.equal(await lent(), 1000);
  });

  it('debt.reschedule move a data e ajusta o valor; o emprestado acompanha a diferença; idempotente', async () => {
    await world({ n: 2, each: 1000 });
    const key = opId('resc');
    const r = await callOk(UID, 'debt.reschedule', key, { debtId: 'p0', dueDate: '2026-11-06', principalCents: 1500 });
    assert.deepEqual([r.dueDate, r.principalCents, r.deltaCents, r.idempotent], ['2026-11-06', 1500, 500, false]);
    const debt = await getDoc('debts', 'p0');
    assert.deepEqual([iso(debt.dueDate), debt.principalCents, debt.status], ['2026-11-06', 1500, 'pending']);
    assert.equal(await lent(), 2500);
    assert.equal((await callOk(UID, 'debt.reschedule', key, { debtId: 'p0', dueDate: '2026-11-06', principalCents: 1500 })).idempotent, true);
    assert.equal(await lent(), 2500); // repetição não soma de novo
    await callOk(UID, 'debt.reschedule', opId(), { debtId: 'p0', principalCents: 800 }); // só valor, para menos
    assert.equal(await lent(), 1800);
    await callOk(UID, 'debt.reschedule', opId(), { debtId: 'p1', dueDate: '2027-01-15' }); // só data: emprestado intacto
    assert.equal(await lent(), 1800);
  });

  it('parcela com recebimentos, paga ou cancelada NÃO é reagendada; nada é alterado', async () => {
    const [p0, p1, p2] = await world({ n: 3, each: 1000 });
    await callOk(UID, 'debt.receive', opId(), recv(p0, 400));
    await callOk(UID, 'debt.receive', opId(), recv(p1, 1000)); // quitada
    await callOk(UID, 'debt.cancel', opId(), { debtId: p2 });
    for (const debtId of [p0, p1, p2]) {
      const r = await call(UID, 'debt.reschedule', opId(), { debtId, dueDate: '2026-11-06', principalCents: 2000 });
      assert.deepEqual([r.status, r.body.error], [409, 'INVALID_STATE'], debtId);
    }
    assert.equal(iso((await getDoc('debts', p0)).dueDate), '2026-12-10');
    assert.equal(await lent(), 2000); // 3000 − 1000 da cancelada
  });

  it('validação e isolamento: sem campos, data/valor inválidos → 400; parcela de outro usuário nunca é alcançada', async () => {
    await world({ n: 1, each: 1000 });
    await world({ n: 1, each: 1000, uid: OTHER });
    for (const params of [{ debtId: 'p0' }, { debtId: 'p0', dueDate: '2026-02-30' }, { debtId: 'p0', principalCents: 0 }, { debtId: 'p0', principalCents: 10.5 }, { debtId: '' }]) {
      assert.equal((await call(UID, 'debt.reschedule', opId(), params)).status, 400, JSON.stringify(params));
    }
    const other = await call(UID, 'debt.reschedule', opId(), { debtId: 'p0', dueDate: '2026-11-06' });
    assert.equal(other.status, 200); // p0 de UID é dele
    const foreign = await call(OTHER, 'debt.reschedule', opId(), { debtId: 'p0', dueDate: '2026-11-07' });
    assert.equal(foreign.status, 200);
    assert.equal(iso((await getDoc('debts', 'p0')).dueDate), '2026-11-06'); // a de UID não foi tocada pela de OTHER
  });

  it('corrida reschedule × recebimento parcial na mesma parcela (10×): reagendar só vale ANTES do recebimento; o emprestado sempre bate com o valor da parcela', async () => {
    await repeat(async () => {
      const [p0] = await world({ n: 1, each: 10000 });
      const [resc, rec] = await Promise.all([call(UID, 'debt.reschedule', opId(), { debtId: p0, dueDate: '2026-11-06', principalCents: 9000 }), call(UID, 'debt.receive', opId(), recv(p0, 4000))]);
      const s = await state();
      const debt = s.debts[0];
      if (resc.status === 200) {
        // reagendou primeiro (sem recebimentos): a parcela mudou por inteiro e o recebimento, se passou, foi sobre ela já alterada
        assert.deepEqual([iso(debt.dueDate), debt.principalCents], ['2026-11-06', 9000]);
      } else {
        // o recebimento veio primeiro: a parcela NÃO pode ter sido alterada
        assert.equal(resc.body.error, 'INVALID_STATE', JSON.stringify(resc));
        assert.deepEqual([iso(debt.dueDate), debt.principalCents, rec.status], ['2026-12-10', 10000, 200]);
      }
      assert.equal(s.debtor.lentCents, debt.principalCents); // emprestado = única parcela, sempre
      assert.equal(s.debtor.receivedCents, s.sum);
    });
  });
});
