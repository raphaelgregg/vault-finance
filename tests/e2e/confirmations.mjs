/**
 * E2E — ações terminais pedem confirmação: cancelar receita, despesa e transferência (antes cancelavam com UM clique).
 * "Voltar" não altera nada; confirmar cancela. Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  log('seed: receita, despesa e transferência pendentes (services reais)');
  await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { createCategory } = await import('/js/services/categories.js');
    const { createIncome } = await import('/js/services/incomes.js');
    const { createExpense } = await import('/js/services/expenses.js');
    const { createTransfer } = await import('/js/services/transfers.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const a = await createAccount(uid, { institution: 'Banco', name: 'A', type: 'checking', initialBalanceCents: '1.000,00', color: '#1f7a5c', status: 'active' });
    const b = await createAccount(uid, { institution: 'Banco', name: 'B', type: 'checking', initialBalanceCents: '0,00', color: '#1f7a5c', status: 'active' });
    const inc = await createCategory(uid, { name: 'Renda', kind: 'income', color: '#1f8a5b' });
    const exp = await createCategory(uid, { name: 'Gasto', kind: 'expense', color: '#e67e22' });
    const r1 = await createIncome(uid, { description: 'Freela X', categoryId: inc.id, amountCents: '50,00', expectedDate: today, accountId: a.id, status: 'pending', recurrence: 'none' });
    const r2 = await createExpense(uid, { description: 'Conta Y', categoryId: exp.id, amountCents: '30,00', purchaseDate: today, dueDate: today, accountId: a.id, status: 'pending', recurrence: 'none' });
    const r3 = await createTransfer(uid, { fromAccountId: a.id, toAccountId: b.id, amountCents: '10,00', date: today, reason: 'Reserva Z', status: 'pending' });
    for (const r of [r1, r2, r3]) if (!r.ok) throw new Error(JSON.stringify(r.errors));
  });
  const statusOf = (collection, field, value) => page.evaluate(async ([c, f, v]) => {
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await list(auth.currentUser.uid, c, {})).find((x) => String(x[f]).includes(v))?.status;
  }, [collection, field, value]);

  const cases = [
    { page: 'receitas', open: 'Cancelar Freela X', title: 'Cancelar receita', confirm: 'Cancelar receita', toast: /Receita cancelada/, collection: 'incomes', field: 'description', value: 'Freela X' },
    { page: 'despesas', open: 'Cancelar Conta Y', title: 'Cancelar despesa', confirm: 'Cancelar despesa', toast: /Despesa cancelada/, collection: 'expenses', field: 'description', value: 'Conta Y' },
    { page: 'transferencias', open: 'Cancelar transferência', title: 'Cancelar transferência', confirm: 'Cancelar transferência', toast: /Transferência cancelada/, collection: 'transfers', field: 'reason', value: 'Reserva Z' },
  ];
  for (const c of cases) {
    log(`${c.page}: cancelar pede confirmação; "Voltar" mantém; confirmar cancela`);
    await page.goto(`${app.base}/pages/${c.page}.html`);
    await page.waitForSelector('#page-content table.table tbody tr');
    await page.getByRole('button', { name: c.open, exact: true }).first().click();
    await page.waitForSelector('.modal__dialog');
    assert.equal(await page.locator('.modal__dialog').getAttribute('aria-label'), c.title);
    assert.equal(await statusOf(c.collection, c.field, c.value), 'pending', 'abrir o modal não pode cancelar');
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await page.waitForSelector('.modal__dialog', { state: 'detached' });
    assert.equal(await statusOf(c.collection, c.field, c.value), 'pending', '"Voltar" não pode cancelar');
    await page.getByRole('button', { name: c.open, exact: true }).first().click();
    await page.locator('.modal__dialog').getByRole('button', { name: c.confirm, exact: true }).click();
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.toast')?.innerText ?? ''), c.toast.source);
    assert.equal(await statusOf(c.collection, c.field, c.value), 'cancelled');
  }
  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E confirmações OK');
} catch (error) {
  console.error(`E2E confirmações FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-confirmations-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
