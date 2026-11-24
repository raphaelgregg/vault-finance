/**
 * E2E — ordenação e filtro em tabelas (components/table-tools.js): páginas (Categorias, Contas) e tabela dentro de modal (Dívidas).
 * Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
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
const col = (table, index) => table.locator('tbody tr:not([hidden])').evaluateAll((rows, i) => rows.map((r) => r.cells[i].innerText.trim()), index);

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('seed: categorias, contas e devedor com 3 dívidas (services reais)');
  await page.evaluate(async () => {
    const { createCategory } = await import('/js/services/categories.js');
    const { createAccount } = await import('/js/services/accounts.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    for (const [name, kind] of [['Zebra', 'expense'], ['Água', 'expense'], ['Mercado', 'expense'], ['Salário', 'income']]) await createCategory(uid, { name, kind, color: '#1f8a5b' });
    for (const [name, saldo] of [['Conta A', '1.500,00'], ['Conta B', '200,00'], ['Conta C', '30.000,00']]) await createAccount(uid, { institution: 'Banco', name, type: 'checking', initialBalanceCents: saldo, color: '#1f7a5c', status: 'active' });
    const debtor = await createDebtor(uid, { name: 'Roberta', lentCents: '0,00', loanDate: '2026-11-01' });
    for (const [description, total, due] of [['Sofá', '900,00', '2027-02-10'], ['Carro', '50,00', '2026-12-05'], ['Mesa', '300,00', '2027-01-20']]) {
      await createDebtPlan(uid, { debtorId: debtor.id, description, totalCents: total, installments: 1, firstDueDate: due });
    }
  });

  log('Categorias: clique no cabeçalho ordena (asc → desc → original) e atualiza aria-sort');
  await page.goto(`${app.base}/pages/categorias.html`);
  await page.waitForSelector('table.table tbody tr');
  await page.waitForSelector('.table-tools');
  const table = page.locator('table.table').first();
  const original = await col(table, 0);
  assert.equal(original.length, 4);
  await page.getByRole('button', { name: 'Ordenar por Nome' }).click();
  assert.deepEqual(await col(table, 0), [...original].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  assert.equal(await page.locator('th', { hasText: 'Nome' }).getAttribute('aria-sort'), 'ascending');
  await page.getByRole('button', { name: 'Ordenar por Nome' }).click();
  assert.deepEqual(await col(table, 0), [...original].sort((a, b) => b.localeCompare(a, 'pt-BR')));
  assert.equal(await page.locator('th', { hasText: 'Nome' }).getAttribute('aria-sort'), 'descending');
  await page.getByRole('button', { name: 'Ordenar por Nome' }).click();
  assert.deepEqual(await col(table, 0), original); // 3º clique volta à ordem original
  assert.equal(await page.locator('th', { hasText: 'Nome' }).getAttribute('aria-sort'), 'none');
  assert.equal(await page.getByRole('button', { name: 'Ordenar por Ações' }).count(), 0, 'coluna de ações não ordena');

  log('Categorias: filtro sem acento/caixa, contador e linha "nenhuma correspondência"');
  await page.fill('.table-filter', 'agua');
  assert.deepEqual(await col(table, 0), ['Água']);
  assert.match(await page.locator('.table-count').innerText(), /1 de 4/);
  await page.fill('.table-filter', 'xyz-inexistente');
  assert.equal(await page.locator('.table-empty-note:not([hidden])').count(), 1);
  await page.fill('.table-filter', '');
  assert.equal((await col(table, 0)).length, 4);

  log('Contas: coluna em R$ ordena como NÚMERO (200 < 1.500 < 30.000), não como texto');
  await page.goto(`${app.base}/pages/bancos.html`);
  await page.waitForSelector('table.table tbody tr');
  await page.waitForSelector('.table-tools');
  const heads = await page.locator('table.table thead th').allInnerTexts();
  const saldoCol = heads.findIndex((h) => /Saldo de abertura/i.test(h));
  assert.ok(saldoCol >= 0, `coluna de saldo inicial não encontrada: ${heads.join('|')}`);
  const bancos = page.locator('table.table').first();
  await page.getByRole('button', { name: /Ordenar por Saldo de abertura/i }).click();
  const asc = (await col(bancos, saldoCol)).map((t) => Number(t.replace(/[^\d,-]/g, '').replace(',', '.')));
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.deepEqual(asc.slice(0, 3), [200, 1500, 30000]);

  log('Modal de Dívidas: a tabela dentro do modal também ordena (valor e vencimento) e filtra');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Roberta' }).click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all');
  const modalTable = page.locator('.modal table.table').first();
  await modalTable.waitFor();
  await page.waitForSelector('.modal .table-tools');
  const mHeads = await modalTable.locator('thead th').allInnerTexts();
  const valorCol = mHeads.findIndex((h) => /^valor$/i.test(h.trim()));
  const venceCol = mHeads.findIndex((h) => /Vencimento/i.test(h));
  await page.locator('.modal').getByRole('button', { name: 'Ordenar por Valor' }).click();
  const valores = (await col(modalTable, valorCol)).map((t) => Number(t.replace(/[^\d,]/g, '').replace(',', '.')));
  assert.deepEqual(valores, [50, 300, 900]);
  await page.locator('.modal').getByRole('button', { name: 'Ordenar por Vencimento' }).click();
  const datas = await col(modalTable, venceCol);
  assert.deepEqual(datas, ['05/12/2026', '20/01/2027', '10/02/2027']); // cronológico, não alfabético
  await page.locator('.modal .table-filter').fill('carro');
  assert.equal((await col(modalTable, 1)).length, 1);

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E tabelas OK');
} catch (error) {
  console.error(`E2E tabelas FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-tables-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
