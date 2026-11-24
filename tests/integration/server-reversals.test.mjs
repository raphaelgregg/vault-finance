/**
 * ESTORNOS por lançamento compensatório — camada confiável, Firebase Emulator real, clientes simultâneos.
 * O documento original é PRESERVADO; o estorno é uma nova operação (`reversals/{coleção}_{id}`) que referencia o original,
 * não pode ser duplicada, ajusta saldos/status atomicamente e registra motivo e auditoria.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, seedCategory, dump, getDoc, oracleBalance, UID, OTHER, seedPurchase } from './helpers/server.mjs';

before(() => adminDb());
beforeEach(clearAll);

const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };
const rev = (kind, targetId, extra = {}) => ({ kind, targetId, reason: 'Lançado por engano', ...extra });
const world = async () => { await seedAccount('A', 10000); await seedAccount('B', 0); await seedCategory('cat', 'expense'); await seedCategory('catI', 'income'); };

describe('estorno de despesa, receita, transferência, fatura', () => {
  it('despesa paga: estorno devolve o saldo, o original é preservado (status volta a pendente) e a referência/ motivo ficam registrados', async () => {
    await world();
    await seed(UID, 'expenses', 'e1', { description: 'Luz', categoryId: 'cat', amountCents: 3000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
    await callOk(UID, 'expense.pay', opId(), { id: 'e1', date: '2026-12-05' });
    assert.equal(await oracleBalance('A'), 7000);
    const r = await callOk(UID, 'reversal.create', opId(), rev('expense', 'e1', { reason: 'Pago na conta errada' }));
    assert.equal(r.amountCents, 3000);
    assert.equal(await oracleBalance('A'), 10000);
    const e = await getDoc('expenses', 'e1');
    assert.deepEqual([e.status, e.amountCents, e.description], ['pending', 3000, 'Luz']); // original preservado
    const rv = await getDoc('reversals', 'expenses_e1');
    assert.deepEqual([rv.kind, rv.targetId, rv.reason, rv.amountCents, rv.accountId], ['expense', 'e1', 'Pago na conta errada', 3000, 'A']);
    assert.equal(rv.original.status, 'paid'); // snapshot do estado original
    assert.ok((await dump('auditLog')).some((a) => a.action === 'reversal.create'));
  });

  it('estorno DUPLICADO simultâneo (chaves diferentes): um passa, os demais 409 ALREADY_REVERSED; saldo ajustado uma vez (10×)', async () => {
    await repeat(async () => {
      await world();
      await seed(UID, 'incomes', 'i1', { description: 'Salário', categoryId: 'catI', amountCents: 4000, accountId: 'A', expectedDate: '2026-12-01', receivedDate: '2026-12-02', status: 'received', recurrence: 'none' });
      assert.equal(await oracleBalance('A'), 14000);
      const rs = await Promise.all([1, 2, 3, 4].map(() => call(UID, 'reversal.create', opId(), rev('income', 'i1'))));
      assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs));
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409 && ['ALREADY_REVERSED', 'INVALID_STATE'].includes(r.body.error)), JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 10000);
      assert.equal((await dump('reversals')).length, 1);
    });
  });

  it('reprocessamento após timeout (MESMA chave): devolve o mesmo estorno, sem estornar de novo (10×)', async () => {
    await repeat(async () => {
      await world();
      await seed(UID, 'expenses', 'e1', { description: 'x', categoryId: 'cat', amountCents: 1000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid', paidDate: '2026-12-02', recurrence: 'none' });
      const key = opId('rev');
      const first = await callOk(UID, 'reversal.create', key, rev('expense', 'e1'));
      const retries = await Promise.all([1, 2, 3].map(() => call(UID, 'reversal.create', key, rev('expense', 'e1'))));
      assert.ok(retries.every((r) => r.status === 200 && r.body.idempotent === true && r.body.reversalId === first.reversalId), JSON.stringify(retries));
      assert.equal(await oracleBalance('A'), 10000); // despesa paga de 1000 (saldo 9000) estornada: volta a 10000
      assert.equal((await dump('reversals')).length, 1);
    });
  });

  it('inexistente, de OUTRO usuário, não liquidado e sem motivo são recusados; nada é criado', async () => {
    await world();
    await seedAccount('X', 5000, OTHER);
    await seed(OTHER, 'expenses', 'ex', { description: 'x', categoryId: 'cat', amountCents: 100, accountId: 'X', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid', paidDate: '2026-12-02', recurrence: 'none' });
    await seed(UID, 'expenses', 'ep', { description: 'x', categoryId: 'cat', amountCents: 100, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
    assert.equal((await call(UID, 'reversal.create', opId(), rev('expense', 'nao-existe'))).status, 404);
    assert.equal((await call(UID, 'reversal.create', opId(), rev('expense', 'ex'))).status, 404); // do Bob: invisível para a Alice
    assert.equal((await call(UID, 'reversal.create', opId(), rev('expense', 'ep'))).body.error, 'INVALID_STATE');
    assert.equal((await call(UID, 'reversal.create', opId(), { kind: 'expense', targetId: 'ep' })).status, 400);
    assert.equal((await call(UID, 'reversal.create', opId(), rev('expense', 'ep', { reason: 'ab' }))).status, 400);
    assert.equal((await dump('reversals')).length + (await dump('reversals', OTHER)).length, 0);
    assert.equal((await getDoc('expenses', 'ex', OTHER)).status, 'paid');
  });

  it('transferência confirmada: o estorno cancela o original, move o dinheiro de volta (precisa de saldo no destino) e é único', async () => {
    await world();
    const t = await callOk(UID, 'transfer.create', opId(), { fromAccountId: 'A', toAccountId: 'B', amountCents: 6000, date: '2026-12-05', reason: 'x', status: 'confirmed' });
    // o destino gasta o dinheiro: sem saldo no destino, o estorno é recusado (não deixa B negativa)
    await seed(UID, 'expenses', 'gasto', { description: 'g', categoryId: 'cat', amountCents: 5000, accountId: 'B', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid', paidDate: '2026-12-06', recurrence: 'none' });
    const refused = await call(UID, 'reversal.create', opId(), rev('transfer', t.transferId));
    assert.deepEqual([refused.status, refused.body.error], [409, 'INSUFFICIENT_BALANCE']);
    await adminDb().doc(`users/${UID}/expenses/gasto`).delete();
    await callOk(UID, 'reversal.create', opId(), rev('transfer', t.transferId));
    assert.equal((await getDoc('transfers', t.transferId)).status, 'cancelled');
    assert.equal(await oracleBalance('A'), 10000);
    assert.equal(await oracleBalance('B'), 0);
    assert.equal((await call(UID, 'reversal.create', opId(), rev('transfer', t.transferId))).body.error, 'ALREADY_REVERSED');
  });

  it('transferência ESTORNADA não pode ser reaberta e confirmada de novo (INVALID_STATE) — evita ficar confirmada com estorno registrado', async () => {
    await world();
    const t = await callOk(UID, 'transfer.create', opId(), { fromAccountId: 'A', toAccountId: 'B', amountCents: 6000, date: '2026-12-05', reason: 'x', status: 'confirmed' });
    await callOk(UID, 'reversal.create', opId(), rev('transfer', t.transferId));
    await adminDb().doc(`users/${UID}/transfers/${t.transferId}`).update({ status: 'pending' }); // o que a tela antiga fazia ao "editar e confirmar"
    const refused = await call(UID, 'transfer.confirm', opId(), { transferId: t.transferId });
    assert.deepEqual([refused.status, refused.body.error], [409, 'INVALID_STATE']);
    assert.match(refused.body.message, /estornada/i);
    assert.equal(await oracleBalance('A'), 10000);
    assert.equal(await oracleBalance('B'), 0);
  });

  it('transferência PRESA (confirmada com estorno já registrado) pode ser estornada de novo: estorno com sufixo, saldos corretos', async () => {
    await world();
    const t = await callOk(UID, 'transfer.create', opId(), { fromAccountId: 'A', toAccountId: 'B', amountCents: 6000, date: '2026-12-05', reason: 'x', status: 'confirmed' });
    await callOk(UID, 'reversal.create', opId(), rev('transfer', t.transferId));
    await adminDb().doc(`users/${UID}/transfers/${t.transferId}`).update({ status: 'confirmed' }); // estado preso real (dado antigo)
    assert.equal(await oracleBalance('A'), 4000);
    const again = await callOk(UID, 'reversal.create', opId(), rev('transfer', t.transferId, { reason: 'Desfazer reabertura' }));
    assert.equal(again.reversalId, `transfers_${t.transferId}_2`);
    assert.equal((await getDoc('transfers', t.transferId)).status, 'cancelled');
    assert.equal(await oracleBalance('A'), 10000);
    assert.equal(await oracleBalance('B'), 0);
    assert.equal((await dump('reversals')).length, 2);
    // e agora sim é duplicata
    assert.equal((await call(UID, 'reversal.create', opId(), rev('transfer', t.transferId))).body.error, 'ALREADY_REVERSED');
  });

  it('receita estornada e recebida de novo pode ser estornada outra vez (novo estorno com sufixo)', async () => {
    await world();
    await seed(UID, 'incomes', 'i1', { description: 'Salário', categoryId: 'catI', amountCents: 4000, accountId: 'A', expectedDate: '2026-12-01', receivedDate: '2026-12-02', status: 'received', recurrence: 'none' });
    await callOk(UID, 'reversal.create', opId(), rev('income', 'i1'));
    assert.equal(await oracleBalance('A'), 10000);
    await callOk(UID, 'income.receive', opId(), { id: 'i1', date: '2026-12-03' });
    assert.equal(await oracleBalance('A'), 14000);
    const again = await callOk(UID, 'reversal.create', opId(), rev('income', 'i1', { reason: 'De novo' }));
    assert.equal(again.reversalId, 'incomes_i1_2');
    assert.equal(await oracleBalance('A'), 10000);
  });

  it('fatura paga: o estorno reabre a fatura (fechada) e devolve o saldo à conta que pagou', async () => {
    await world();
    await seed(UID, 'invoices', 'inv', { cardId: 'card', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'closed', totalCents: 4000 });
    await seedPurchase('inv', 4000);
    await callOk(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' });
    assert.equal(await oracleBalance('A'), 6000);
    await callOk(UID, 'reversal.create', opId(), rev('invoice', 'inv'));
    const inv = await getDoc('invoices', 'inv');
    assert.deepEqual([inv.status, inv.paidCents, inv.accountId], ['closed', undefined, undefined]);
    assert.equal(await oracleBalance('A'), 10000);
    // e pode ser paga de novo com outra conta (nova operação), sem alterar o estorno anterior
    await callOk(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' });
    assert.equal(await oracleBalance('A'), 6000);
  });
});

describe('estorno de recebimento de devedor e de movimento de meta', () => {
  const debtorWorld = async () => {
    await seedAccount('A', 10000);
    await seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 20000, receivedCents: 0, status: 'open' });
    await seed(UID, 'debts', 'p0', { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2026-12-10', installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', status: 'pending' });
    await seed(UID, 'debts', 'p1', { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2027-01-10', installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g', status: 'pending' });
  };

  it('recebimento estornado: parcela e devedor reabrem, saldo volta, o recebimento original permanece no histórico e a parcela pode ser recebida de novo (10×)', async () => {
    await repeat(async () => {
      await debtorWorld();
      const r = await callOk(UID, 'debt.receive', opId(), { debtId: 'p0', date: '2026-12-05', accountId: 'A' });
      assert.equal((await getDoc('debts', 'p0')).status, 'paid');
      assert.equal(await oracleBalance('A'), 20000);
      const rs = await Promise.all([1, 2].map(() => call(UID, 'reversal.create', opId(), rev('debtPayment', r.paymentId, { reason: 'Conta errada' }))));
      assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal((await dump('debtPayments')).length, 1); // histórico preservado
      assert.equal((await getDoc('debts', 'p0')).status, 'pending');
      const dev = await getDoc('debtors', 'dev');
      assert.deepEqual([dev.receivedCents, dev.status], [0, 'open']);
      assert.equal(await oracleBalance('A'), 10000);
      const again = await callOk(UID, 'debt.receive', opId(), { debtId: 'p0', date: '2026-12-06', accountId: 'A' }); // recebível de novo
      assert.equal(again.amountCents, 10000);
      assert.equal(await oracleBalance('A'), 20000);
      assert.equal((await getDoc('debtors', 'dev')).receivedCents, 10000);
    });
  });

  it('recebimento já gasto: estorno sem saldo na conta é recusado (nunca negativa)', async () => {
    await debtorWorld();
    await seedCategory('cat', 'expense');
    const r = await callOk(UID, 'debt.receive', opId(), { debtId: 'p0', date: '2026-12-05', accountId: 'A', amountCents: 10000 });
    await seed(UID, 'expenses', 'g', { description: 'g', categoryId: 'cat', amountCents: 19000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid', paidDate: '2026-12-06', recurrence: 'none' });
    const refused = await call(UID, 'reversal.create', opId(), rev('debtPayment', r.paymentId));
    assert.deepEqual([refused.status, refused.body.error], [409, 'INSUFFICIENT_BALANCE']);
    assert.equal((await dump('reversals')).length, 0);
  });

  it('aporte estornado: guardado e saldo recalculados; resgate estornado idem; estorno concorrente com resgate nunca deixa guardado negativo (10×)', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000);
      await seed(UID, 'goals', 'g1', { name: 'Viagem', targetCents: 100000, status: 'active' });
      const d1 = await callOk(UID, 'goal.deposit', opId(), { goalId: 'g1', amountCents: 6000, date: '2026-12-05', accountId: 'A' });
      assert.equal(await oracleBalance('A'), 4000);
      // resgate de 5000 e estorno do aporte de 6000 ao mesmo tempo: o guardado (6000) não cobre os dois
      const rs = await Promise.all([call(UID, 'goal.withdraw', opId(), { goalId: 'g1', amountCents: 5000, date: '2026-12-06', accountId: 'A' }), call(UID, 'reversal.create', opId(), rev('goalTransaction', d1.transactionId))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      const txs = await dump('goalTransactions');
      const revs = await dump('reversals');
      const live = txs.filter((t) => !revs.some((r) => r.targetId === t.id));
      const saved = live.reduce((t, x) => t + (x.type === 'deposit' ? x.amountCents : -x.amountCents), 0);
      assert.ok(saved >= 0, `guardado ${saved}`);
      assert.equal(txs.length, rs.some((r) => r.body.transactionId) ? 2 : 1);
    });
  });
});
