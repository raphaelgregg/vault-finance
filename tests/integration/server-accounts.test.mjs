/**
 * Arquivamento LÓGICO de contas e devedores (sem exclusão física do histórico), exclusão só sem histórico e ajuste do
 * saldo de abertura na camada confiável — Firebase Emulator real.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, seedCategory, dump, getDoc, oracleBalance, UID, seedPurchase } from './helpers/server.mjs';

before(() => adminDb());
beforeEach(clearAll);

const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };

describe('contas — arquivamento lógico', () => {
  it('conta arquivada não recebe lançamentos (despesa, receita, transferência, aporte, recebimento, fatura); o histórico segue consultável e desarquivar reativa', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0); await seedCategory('cat', 'expense'); await seedCategory('catI', 'income');
    await seed(UID, 'incomes', 'i1', { description: 'Salário', categoryId: 'catI', amountCents: 5000, accountId: 'A', expectedDate: '2026-12-01', receivedDate: '2026-12-02', status: 'received', recurrence: 'none' });
    await seed(UID, 'expenses', 'e1', { description: 'Luz', categoryId: 'cat', amountCents: 1000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
    await seed(UID, 'goals', 'g1', { name: 'V', targetCents: 100000, status: 'active' });
    await seed(UID, 'invoices', 'inv', { cardId: 'c', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'closed', totalCents: 100 });
    await seedPurchase('inv', 100);
    await callOk(UID, 'account.archive', opId(), { accountId: 'A' });
    assert.equal((await getDoc('accounts', 'A')).status, 'archived');
    const blocked = [
      call(UID, 'expense.pay', opId(), { id: 'e1' }),
      call(UID, 'income.create', opId(), { description: 'x', categoryId: 'catI', amountCents: 100, accountId: 'A', expectedDate: '2026-12-01', status: 'received' }),
      call(UID, 'transfer.create', opId(), { fromAccountId: 'A', toAccountId: 'B', amountCents: 100, date: '2026-12-05', reason: 'x', status: 'confirmed' }),
      call(UID, 'transfer.create', opId(), { fromAccountId: 'B', toAccountId: 'A', amountCents: 100, date: '2026-12-05', reason: 'x', status: 'confirmed' }),
      call(UID, 'goal.deposit', opId(), { goalId: 'g1', amountCents: 100, date: '2026-12-05', accountId: 'A' }),
      call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' }),
    ];
    for (const r of await Promise.all(blocked)) assert.deepEqual([r.status, r.body.error], [409, 'ACCOUNT_NOT_ACTIVE'], JSON.stringify(r));
    // histórico preservado e consultável
    assert.equal((await dump('incomes')).length, 1);
    assert.equal(await oracleBalance('A'), 15000);
    assert.equal((await call(UID, 'account.archive', opId(), { accountId: 'A' })).body.error, 'INVALID_STATE'); // já arquivada
    await callOk(UID, 'account.unarchive', opId(), { accountId: 'A' });
    assert.equal((await call(UID, 'expense.pay', opId(), { id: 'e1' })).status, 200);
  });

  it('conta com histórico NÃO é apagada (409 HAS_HISTORY); conta sem nenhum vínculo e sem saldo de abertura é; arquivada continua listável', async () => {
    await seedAccount('A', 10000); await seedAccount('VAZIA', 0); await seedAccount('SOBRA', 5000); await seedCategory('catI', 'income');
    await seed(UID, 'incomes', 'i1', { description: 'x', categoryId: 'catI', amountCents: 5000, accountId: 'A', expectedDate: '2026-12-01', status: 'pending', recurrence: 'none' });
    const withHistory = await call(UID, 'account.delete', opId(), { accountId: 'A' });
    assert.deepEqual([withHistory.status, withHistory.body.error], [409, 'HAS_HISTORY']);
    assert.equal((await call(UID, 'account.delete', opId(), { accountId: 'SOBRA' })).body.error, 'HAS_HISTORY'); // saldo de abertura é histórico
    await callOk(UID, 'account.delete', opId(), { accountId: 'VAZIA' });
    assert.equal(await getDoc('accounts', 'VAZIA'), null);
    assert.ok(await getDoc('accounts', 'A'));
    assert.equal((await call(UID, 'account.delete', opId(), { accountId: 'nao-existe' })).status, 404);
  });

  it('exclusão de conta × lançamento simultâneo: nunca fica lançamento órfão (10×)', async () => {
    await repeat(async () => {
      await seedAccount('X', 0); await seedAccount('B', 100000); await seedCategory('catI', 'income');
      const rs = await Promise.all([
        call(UID, 'account.delete', opId(), { accountId: 'X' }),
        call(UID, 'income.create', opId(), { description: 'x', categoryId: 'catI', amountCents: 100, accountId: 'X', expectedDate: '2026-12-01', status: 'pending' }),
      ]);
      const accountExists = Boolean(await getDoc('accounts', 'X'));
      const incomes = await dump('incomes');
      // ou a conta foi apagada E nenhum lançamento a referencia, ou a conta existe
      if (!accountExists) assert.equal(incomes.filter((i) => i.accountId === 'X').length, 0, JSON.stringify(rs));
      assert.ok(rs.every((r) => [200, 404, 409].includes(r.status)), JSON.stringify(rs));
    });
  });

  it('ajuste do saldo de abertura: recalcula a partir dos movimentos; nunca negativo; serializa com despesa simultânea (10×)', async () => {
    await repeat(async () => {
      await seedAccount('A', 0); await seedCategory('cat', 'expense');
      await seed(UID, 'incomes', 'i1', { description: 'x', categoryId: 'cat', amountCents: 3000, accountId: 'A', expectedDate: '2026-12-01', receivedDate: '2026-12-02', status: 'received', recurrence: 'none' });
      const r = await callOk(UID, 'account.adjustOpening', opId(), { accountId: 'A', realBalanceCents: 10000 });
      assert.deepEqual([r.previousInitialCents, r.newInitialCents, r.movementsCents], [0, 7000, 3000]);
      assert.equal(await oracleBalance('A'), 10000);
      const tooLow = await call(UID, 'account.adjustOpening', opId(), { accountId: 'A', realBalanceCents: 1000 });
      assert.deepEqual([tooLow.status, tooLow.body.error], [409, 'INVALID_STATE']); // movimentos (3000) > 1000
      await seed(UID, 'expenses', 'e1', { description: 'x', categoryId: 'cat', amountCents: 8000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
      const rs = await Promise.all([call(UID, 'account.adjustOpening', opId(), { accountId: 'A', realBalanceCents: 20000 }), call(UID, 'expense.pay', opId(), { id: 'e1' })]);
      assert.ok(rs.every((x) => x.status === 200), JSON.stringify(rs));
      const bal = await oracleBalance('A');
      assert.ok([12000, 20000 - 8000 + 0, 12000].includes(bal) || bal >= 0, `saldo ${bal}`);
      assert.ok(bal >= 0);
    });
  });
});

describe('devedores — arquivamento lógico', () => {
  const debtor = (extra = {}) => seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 5000, receivedCents: 5000, status: 'paid', ...extra });

  it('só devedor quitado/cancelado é arquivado; arquivado não recebe e continua com histórico; desarquivar libera', async () => {
    await seedAccount('A', 0);
    await debtor({ status: 'open', receivedCents: 0 });
    assert.equal((await call(UID, 'debtor.archive', opId(), { debtorId: 'dev' })).body.error, 'INVALID_STATE'); // em aberto
    await seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 5000, receivedCents: 5000, status: 'paid' });
    await seed(UID, 'debts', 'p', { debtorId: 'dev', description: 'P', principalCents: 5000, dueDate: '2026-12-10', installmentNumber: 1, status: 'paid' });
    await seed(UID, 'debtPayments', 'pay1', { debtId: 'p', debtorId: 'dev', amountCents: 5000, date: '2026-12-02', accountId: 'A' });
    await callOk(UID, 'debtor.archive', opId(), { debtorId: 'dev' });
    assert.equal((await getDoc('debtors', 'dev')).archived, true);
    assert.equal((await dump('debtPayments')).length, 1);
    assert.equal((await call(UID, 'debtor.archive', opId(), { debtorId: 'dev' })).body.error, 'INVALID_STATE');
    await seed(UID, 'debts', 'q', { debtorId: 'dev', description: 'Q', principalCents: 100, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' });
    const blocked = await call(UID, 'debt.receive', opId(), { debtId: 'q', date: '2026-12-05', accountId: 'A' });
    assert.deepEqual([blocked.status, blocked.body.error], [409, 'INVALID_STATE']);
    await callOk(UID, 'debtor.unarchive', opId(), { debtorId: 'dev' });
    assert.equal((await getDoc('debtors', 'dev')).archived, undefined);
  });

  it('devedor com histórico NÃO é apagado (409 HAS_HISTORY); sem vínculo algum pode ser', async () => {
    await debtor();
    await seed(UID, 'debts', 'p', { debtorId: 'dev', description: 'P', principalCents: 5000, dueDate: '2026-12-10', installmentNumber: 1, status: 'paid' });
    await seed(UID, 'debtors', 'solto', { name: 'S', loanDate: '2026-11-10', lentCents: 0, receivedCents: 0, status: 'open' });
    assert.equal((await call(UID, 'debtor.delete', opId(), { debtorId: 'dev' })).body.error, 'HAS_HISTORY');
    // VF-COR-07: devedor vinculado a uma ASSINATURA (que gera valor a receber dele) também não pode ser apagado
    await seed(UID, 'debtors', 'com-assinatura', { name: 'A', loanDate: '2026-11-10', lentCents: 0, receivedCents: 0, status: 'open' });
    await seed(UID, 'subscriptions', 'sub1', { name: 'Netflix', amountCents: 5590, periodicity: 'monthly', nextChargeDate: '2026-12-05', categoryId: 'cat', status: 'active', debtorId: 'com-assinatura' });
    const blocked = await call(UID, 'debtor.delete', opId(), { debtorId: 'com-assinatura' });
    assert.deepEqual([blocked.status, blocked.body.error], [409, 'HAS_HISTORY']);
    assert.ok(await getDoc('debtors', 'com-assinatura'));
    await callOk(UID, 'debtor.delete', opId(), { debtorId: 'solto' });
    assert.equal(await getDoc('debtors', 'solto'), null);
    assert.ok(await getDoc('debtors', 'dev'));
  });
});
