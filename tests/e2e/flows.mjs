/**
 * Cenários E2E (VF-4-04) no navegador contra os emuladores Auth/Firestore.
 * Rodar com `npm run test:e2e` (E2E_SCREENSHOTS=<pasta> salva capturas de tela). Sem `playwright` instalado, sai com aviso (código 0).
 * Cobre: cadastro → conta/categorias → orçamentos, metas, cartões/faturas, devedores
 * (parcelas/recebimentos), dashboard, relatórios (CSV) e a rota de categorias.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, startStatic, newContext, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const server = await startStatic();
const browser = await pw.chromium.launch();
const context = await newContext(browser);
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_FAILED|unpkg|lucide|status of 409 \(Conflict\)/i.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
});

let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const go = async (path) => {
  await page.goto(`${server.base}/pages/${path}.html`);
  await page.waitForSelector('#page-content .panel, #page-content p[role="alert"]', { timeout: 15000 });
};
const text = () => page.locator('#page-content').innerText();
const modalText = () => page.locator('.modal__dialog').innerText();
const row = (needle) => page.locator('tbody tr', { hasText: needle });
const shot = async (name) => { if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };
const closeToasts = () => page.waitForTimeout(150);
const iso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d); // dia civil de Brasília, como o app
const addDays = (days) => iso(new Date(Date.now() + days * 86400000));
const thisMonth = iso(new Date()).slice(0, 7);

try {
  log('cadastro e dashboard vazio');
  await registerUser(page, server.base);
  await page.waitForSelector('#page-content .panel');
  assert.match(await text(), /Saldo total/);
  assert.match(await text(), /Nada a vencer/);

  log('seed: conta e categorias via services');
  const accountId = await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const r = await createAccount(auth.currentUser.uid, { institution: 'Banco E2E', name: 'Corrente', type: 'checking', initialBalanceCents: '1.000,00', color: '#1f7a5c', status: 'active' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.id;
  });
  assert.ok(accountId);
  const cats = await page.evaluate(async () => {
    const { createCategory } = await import('/js/services/categories.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const exp = await createCategory(uid, { name: 'Mercado', kind: 'expense', color: '#c0392b' });
    const inc = await createCategory(uid, { name: 'Salário', kind: 'income', color: '#1f8a5b' });
    if (!exp.ok || !inc.ok) throw new Error(JSON.stringify([exp.errors, inc.errors]));
    return { exp: exp.id, inc: inc.id };
  });
  assert.ok(cats.exp && cats.inc);
  const today = iso(new Date());
  await page.evaluate(async ([a, c, d]) => {
    const { createIncome } = await import('/js/services/incomes.js');
    const { createExpense } = await import('/js/services/expenses.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const i = await createIncome(uid, { description: 'Salário E2E', categoryId: c.inc, amountCents: '5.000,00', expectedDate: d, receivedDate: d, accountId: a, status: 'received', recurrence: 'none' });
    const e = await createExpense(uid, { description: 'Compras E2E', categoryId: c.exp, amountCents: '400,00', purchaseDate: d, dueDate: d, paidDate: d, accountId: a, status: 'paid', recurrence: 'none' });
    if (!i.ok || !e.ok) throw new Error(JSON.stringify([i, e]));
  }, [accountId, cats, today]);

  log('orçamentos: criar, duplicado, gasto derivado, editar limite');
  await go('orcamentos');
  await page.getByRole('button', { name: /Novo orçamento/ }).click();
  await page.selectOption('#categoryId', cats.exp);
  await page.fill('#limitCents', '500,00');
  await page.locator('#budget-form button[type="submit"]').click();
  await page.waitForSelector('tbody tr');
  let r = row('Mercado');
  assert.match(await r.innerText(), /R\$\s?500,00/);
  assert.match(await r.innerText(), /R\$\s?400,00/);
  assert.match(await r.innerText(), /80%/);
  assert.match(await r.innerText(), /Atenção/);
  await page.getByRole('button', { name: /Novo orçamento/ }).click();
  await page.selectOption('#categoryId', cats.exp);
  await page.fill('#limitCents', '100,00');
  await page.locator('#budget-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await modalText(), /Já existe orçamento/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Editar limite de Mercado/ }).click();
  await page.fill('#limitCents', '300,00');
  await page.locator('#budget-form button[type="submit"]').click();
  await page.waitForFunction(() => /133%/.test(document.querySelector('#page-content').innerText));
  assert.match(await row('Mercado').innerText(), /Estourado/);

  await shot('orcamentos');
  log('metas: criar, aportar até concluir, resgatar reativa, excluir bloqueado');
  await go('metas');
  await page.getByRole('button', { name: /Nova meta/ }).click();
  await page.fill('#name', 'Viagem');
  await page.fill('#targetCents', '1.000,00');
  await page.locator('#goal-form button[type="submit"]').click();
  await page.waitForSelector('tbody tr');
  await page.getByRole('button', { name: 'Aportar em Viagem' }).click();
  await page.fill('#amountCents', '400,00');
  await page.selectOption('#accountId', accountId);
  await page.locator('#goal-move-form button[type="submit"]').click();
  await page.waitForFunction(() => /40%/.test(document.querySelector('#page-content').innerText));
  await page.getByRole('button', { name: 'Aportar em Viagem' }).click();
  await page.fill('#amountCents', '700,00');
  await page.selectOption('#accountId', accountId);
  await page.locator('#goal-move-form button[type="submit"]').click();
  await page.waitForFunction(() => /100%/.test(document.querySelector('tbody')?.innerText ?? ''));
  assert.match(await row('Viagem').innerText(), /Concluída/);
  await page.getByRole('button', { name: 'Resgatar de Viagem' }).click();
  await page.fill('#amountCents', '200,00');
  await page.selectOption('#accountId', accountId);
  await page.locator('#goal-move-form button[type="submit"]').click();
  await page.waitForFunction(() => /90%/.test(document.querySelector('tbody')?.innerText ?? ''));
  assert.match(await row('Viagem').innerText(), /Ativa/);
  await page.getByRole('button', { name: 'Excluir Viagem' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForFunction(() => /não pode ser excluída/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.match(await text(), /Viagem/);

  await shot('metas');
  log('cartões: criar, compra 3x, fatura, fechar e pagar, limite');
  await go('cartoes');
  await page.getByRole('button', { name: /Novo cartão/ }).click();
  await page.fill('#name', 'Cartão E2E');
  await page.fill('#brand', 'Visa');
  await page.fill('#limitCents', '2.000,00');
  await page.fill('#closingDay', '10');
  await page.fill('#dueDay', '17');
  await page.locator('#card-form button[type="submit"]').click();
  await page.waitForSelector('tbody tr');
  await page.getByRole('button', { name: 'Nova compra em Cartão E2E' }).click();
  await page.fill('#description', 'Notebook');
  await page.fill('#amountCents', '900,00');
  await page.fill('#installmentsTotal', '3');
  await page.fill('#purchaseDate', '2026-01-05');
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForFunction(() => /R\$\s?1\.100,00/.test(document.querySelector('#page-content').innerText)); // disponível 2000-900
  // excesso de limite
  await page.getByRole('button', { name: 'Nova compra em Cartão E2E' }).click();
  await page.fill('#description', 'Grande');
  await page.fill('#amountCents', '1.100,01');
  await page.fill('#purchaseDate', '2026-01-06');
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await modalText(), /excede o limite disponível/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Faturas e compras de Cartão E2E/ }).click();
  const dialog = page.locator('.modal__dialog');
  await dialog.locator('tbody tr').first().waitFor();
  assert.match(await dialog.innerText(), /01\/2026/);
  assert.match(await dialog.innerText(), /1\/3/);
  assert.match(await dialog.innerText(), /3\/3/);
  await page.getByRole('button', { name: 'Fechar fatura 01/2026' }).click();
  await page.waitForFunction(() => /Fechada/.test(document.querySelector('.modal__dialog')?.innerText ?? ''));
  assert.match(await row('01/2026').first().innerText(), /R\$\s?300,00/);
  await page.getByRole('button', { name: 'Pagar fatura 01/2026' }).click();
  await page.selectOption('#accountId', accountId); // VF-2-03p: a fatura é paga com uma conta bancária
  await page.locator('#invoice-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Paga/.test(document.querySelector('.modal__dialog')?.innerText ?? ''));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /R\$\s?1\.400,00/.test(document.querySelector('#page-content')?.innerText ?? '')); // disponível: 2000 − 600 (2 parcelas em fatura não paga)

  await shot('cartoes');
  log('devedores: criar, parcela, recebimento parcial e quitação');
  await go('devedores');
  await page.getByRole('button', { name: /Novo devedor/ }).click();
  await page.fill('#name', 'Maria');
  // VF-2-03l/m: devedor SEM empréstimo inicial; a dívida à vista soma ao emprestado.
  await page.locator('#debtor-form button[type="submit"]').click();
  await page.waitForSelector('tbody tr');
  await page.getByRole('button', { name: /Parcelas e recebimentos de Maria/ }).click();
  await page.getByRole('button', { name: 'Nova dívida', exact: true }).click();
  await page.fill('#description', 'Parcela única');
  await page.fill('#totalCents', '500,00');
  await page.fill('#firstDueDate', addDays(-3));
  await page.locator('#debt-form button[type="submit"]').click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all'); // o vencimento pode cair no mês anterior
  await page.waitForSelector('.modal__dialog tbody tr');
  assert.match(await modalText(), /Atrasada/); // derivado: vencida e ainda pendente
  await page.getByRole('button', { name: 'Quitar parcela 1' }).click();
  await page.fill('#amountCents', '200,00');
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /R\$\s?200,00/.test(document.querySelector('.modal__dialog')?.innerText ?? ''));
  await page.getByRole('button', { name: 'Quitar parcela 1' }).click();
  await page.fill('#amountCents', '300,01');
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await modalText(), /excede/);
  await page.fill('#amountCents', '300,00');
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Paga/.test(document.querySelector('.modal__dialog')?.innerText ?? ''));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /Quitado/.test(document.querySelector('#page-content').innerText));
  assert.match(await row('Maria').innerText(), /R\$\s?500,00/);

  log('dashboard: saldo derivado com recebimentos, metas e resultado do mês');
  await go('dashboard');
  // 1000 + 5000 − 400 + 500 (recebimentos) − 900 (aporte 400+700 − resgate 200) − 300 (fatura 01/2026 paga com a conta)
  assert.match(await text(), /R\$\s?4\.900,00/);
  assert.match(await text(), /Receitas/);
  assert.match(await text(), /R\$\s?4\.600,00/); // resultado do mês 5000 − 400
  assert.match(await text(), /Fatura|Nada a vencer/);

  await shot('dashboard');
  log('dashboard: período por semestre, ano e todo o período (contas, cartões, devedores e assinaturas sempre visíveis)');
  for (const re of [/Contas/, /Cartões/, /Devedores/, /Assinaturas/, /Pontos de atenção/, /Posição líquida/]) assert.match(await text(), re);
  await page.selectOption('#dashboard-period-mode', 'semester');
  await page.waitForSelector('#dashboard-semester');
  assert.match(await text(), /º semestre de \d{4}/);
  await page.selectOption('#dashboard-semester', '1');
  await page.waitForFunction(() => /1º semestre de/.test(document.querySelector('#page-content').innerText));
  await page.selectOption('#dashboard-period-mode', 'year');
  await page.waitForFunction(() => /Ano \d{4}/.test(document.querySelector('#page-content').innerText));
  assert.match(await text(), /Mês a mês/);
  await page.selectOption('#dashboard-period-mode', 'all');
  await page.waitForFunction(() => /Todo o período/.test(document.querySelector('#page-content').innerText));
  assert.doesNotMatch(await text(), /\bnull\b|undefined|NaN/);
  assert.match(await text(), /R\$\s?4\.900,00/); // saldo em contas não depende do período
  await shot('dashboard-all');
  await page.selectOption('#dashboard-period-mode', 'month');
  await page.waitForSelector('#dashboard-month');
  log('relatórios: período, totais por categoria e CSV');
  await go('relatorios');
  assert.match(await text(), /Mercado/);
  assert.match(await text(), /R\$\s?5\.000,00/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Exportar CSV' }).first().click(),
  ]);
  assert.match(download.suggestedFilename(), /^evolucao-\d{4}-\d{2}-\d{4}-\d{2}\.csv$/);
  await shot('relatorios');
  await page.fill('#rep-from', '2026-12');
  await page.fill('#rep-to', '2026-01');
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await page.waitForSelector('.form__error[role="alert"]');
  assert.match(await text(), /Período inválido/);

  log('configurações: perfil e tema persistem na conta (novo dispositivo)');
  await go('configuracoes');
  await page.fill('#profile-name', 'Nome Persistido');
  await page.selectOption('#settings-theme', 'dark');
  await page.locator('#preferences-form button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.evaluate(() => localStorage.clear()); // simula outro dispositivo: sem cache local
  await go('configuracoes');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.inputValue('#profile-name'), 'Nome Persistido');

  log('rota de categorias e navegação com orçamentos');
  await go('categorias');
  assert.match(await page.locator('#sidebar').innerText(), /Orçamentos/);
  await closeToasts();

  assert.deepEqual(problems, [], `erros de console/página: ${problems.join(' | ')}`);
  console.info('E2E OK');
} catch (error) {
  console.error(`E2E FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-fail.png'));
  if (problems.length) console.error('problemas capturados:', problems);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
