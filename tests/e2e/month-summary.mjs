/**
 * E2E do resumo do mês (VF-UX-01): Receitas/Despesas mostram o total do mês SELECIONADO (lido por intervalo, não da página
 * carregada) e o Dashboard separa realizado × pendente × total. Rodar com `npm run test:e2e`.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const content = () => page.locator('#page-content').innerText();
const waitText = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#page-content').innerText), re.source);
const go = async (path) => {
  await page.goto(`${app.base}/pages/${path}.html`);
  await page.waitForSelector('#page-content .panel', { timeout: 15000 });
};
const MONTH = '2027-03'; // futuro: nada liquidado, só pendentes (o caso que parecia "zero" no Dashboard)

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('seed: 3 receitas (1+2+3) e 2 despesas (4+5) pendentes no mês, mais 1 receita em outro mês');
  await page.evaluate(async (month) => {
    const { createCategory } = await import('/js/services/categories.js');
    const { createAccount } = await import('/js/services/accounts.js');
    const { createIncome } = await import('/js/services/incomes.js');
    const { createExpense } = await import('/js/services/expenses.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const inc = await createCategory(uid, { name: 'Salário', kind: 'income', color: '#1f8a5b' });
    const exp = await createCategory(uid, { name: 'Mercado', kind: 'expense', color: '#c0392b' });
    const acc = await createAccount(uid, { institution: 'Banco', name: 'Conta', type: 'checking', color: '#2563eb', status: 'active', initialBalanceCents: '10,00' });
    if (!acc.ok) throw new Error('conta: ' + JSON.stringify(acc.errors));
    const must = (r) => { if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
    const accountId = acc.id;
    for (const [i, value] of ['1,00', '2,00', '3,00'].entries()) {
      must(await createIncome(uid, { description: `R${i}`, categoryId: inc.id, amountCents: value, expectedDate: `${month}-1${i}`, accountId, status: 'pending', recurrence: 'none' }));
    }
    must(await createIncome(uid, { description: 'Fora', categoryId: inc.id, amountCents: '99,00', expectedDate: '2027-05-10', accountId, status: 'pending', recurrence: 'none' }));
    for (const [i, value] of ['4,00', '5,00'].entries()) {
      const d = `${month}-2${i}`;
      must(await createExpense(uid, { description: `D${i}`, categoryId: exp.id, amountCents: value, accountId, purchaseDate: d, dueDate: d, status: 'pending', recurrence: 'none' }));
    }
  }, MONTH);

  log('receitas: o resumo cobre o mês selecionado, e muda ao trocar o mês');
  await go('receitas');
  await page.selectOption('#filter-month', MONTH);
  await page.waitForFunction(() => /R\$\s?6,00/.test(document.querySelector('#month-summary')?.innerText ?? ''));
  const summary = await page.locator('#month-summary').innerText();
  assert.match(summary, /março de 2027/i);
  assert.match(summary, /Previsto no mês/);
  assert.match(summary, /A receber[\s\S]*R\$\s?6,00/);
  assert.equal(await page.locator('#page-content tbody tr').count(), 3);
  await page.selectOption('#filter-month', '2027-05');
  await page.waitForFunction(() => /R\$\s?99,00/.test(document.querySelector('#month-summary')?.innerText ?? ''));

  log('despesas: resumo do mês');
  await go('despesas');
  await page.selectOption('#filter-month', MONTH);
  await page.waitForFunction(() => /R\$\s?9,00/.test(document.querySelector('#month-summary')?.innerText ?? ''));
  assert.match(await page.locator('#month-summary').innerText(), /A pagar/);

  log('dashboard: mês futuro mostra realizado zero, pendente e total');
  await go('dashboard');
  await page.fill('#dashboard-month', '03/2027');
  await page.dispatchEvent('#dashboard-month', 'change');
  await page.waitForSelector('#dashboard-overview');
  await page.waitForFunction(() => /Total do período/.test(document.querySelector('#dashboard-overview')?.innerText ?? ''));
  const overview = await page.locator('#dashboard-overview').innerText();
  assert.match(overview, /Realizado[\s\S]*R\$\s?0,00/);
  assert.match(overview, /Pendente[\s\S]*R\$\s?6,00[\s\S]*R\$\s?9,00/);
  assert.match(overview, /Total do período[\s\S]*R\$\s?6,00[\s\S]*R\$\s?9,00[\s\S]*-R\$\s?3,00|Total do período[\s\S]*R\$\s?6,00[\s\S]*R\$\s?9,00/);
  assert.match(await content(), /previsto do período/);

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E resumo do mês OK');
} catch (error) {
  console.error(`E2E resumo do mês FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-month-summary-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-month-summary-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
