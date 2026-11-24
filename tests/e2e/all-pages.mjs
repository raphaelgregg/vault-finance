/**
 * VF-COR-03 — TODAS as telas abrem e renderizam conteúdo (nunca em branco), tanto com as Rules do repositório quanto
 * com as Rules ANTIGAS (sem `reversals`, como as publicadas em produção): sem erro de JavaScript, sem tela vazia, e —
 * com Rules antigas — sem valores dependentes de estorno apresentados como confiáveis.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }
const NEW_RULES = readFileSync(join(root, 'firestore.rules'), 'utf8');
const LEGACY_RULES = readFileSync(join(root, 'tests', 'fixtures', 'firestore.rules.legacy'), 'utf8');
const setRules = async (content) => {
  const res = await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-vault-finance:securityRules', { method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }) });
  assert.equal(res.ok, true, `rules PUT ${res.status}`);
};
initializeApp({ projectId: 'demo-vault-finance' });
const db = getFirestore();
const noon = (iso) => Timestamp.fromDate(new Date(`${iso}T12:00:00.000Z`));
const stamp = () => ({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
const PAGES = ['dashboard', 'bancos', 'categorias', 'receitas', 'despesas', 'transferencias', 'devedores', 'cartoes', 'metas', 'orcamentos', 'assinaturas', 'relatorios', 'configuracoes', 'manutencao-dados'];

const app = await launchApp(pw);
const { page, problems } = app;
let step = 'início';
const content = async () => (await page.locator('#page-content').innerText()).replace(/\s+/g, ' ');
const open = async (name) => {
  await page.goto(`${app.base}/pages/${name}.html`);
  await page.waitForSelector('#page-content', { timeout: 30000 });
  await page.waitForTimeout(1500);
  return content();
};

try {
  await registerUser(page, app.base, 'Todas as telas');
  await page.goto(`${app.base}/pages/bancos.html`);
  const uid = await page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); for (let i = 0; i < 50 && !auth.currentUser; i += 1) await new Promise((r) => setTimeout(r, 100)); return auth.currentUser.uid; });
  const put = (c, id, data) => db.doc(`users/${uid}/${c}/${id}`).set({ ...data, ...stamp() });
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  await put('accounts', 'accA', { institution: 'Banco Telas', name: 'Corrente', type: 'checking', initialBalanceCents: 100000, color: '#000000', status: 'active' });
  await put('categories', 'catI', { name: 'Salário Telas', kind: 'income', color: '#00aa00' });
  await put('categories', 'catE', { name: 'Mercado Telas', kind: 'expense', color: '#aa0000' });
  await put('incomes', 'inc1', { description: 'Salário Telas', categoryId: 'catI', amountCents: 50000, expectedDate: noon(today), receivedDate: noon(today), accountId: 'accA', status: 'received', recurrence: 'none' });
  await put('expenses', 'exp1', { description: 'Mercado Telas', categoryId: 'catE', amountCents: 20000, dueDate: noon(today), paidDate: noon(today), accountId: 'accA', status: 'paid', recurrence: 'none' });
  await put('goals', 'goal1', { name: 'Viagem Telas', targetCents: 100000, status: 'active' });
  await put('goalTransactions', 'gt1', { goalId: 'goal1', type: 'deposit', amountCents: 30000, date: noon(today), accountId: 'accA' });
  await put('debtors', 'dev1', { name: 'Devedor Telas', loanDate: noon(`${month}-01`), lentCents: 40000, receivedCents: 0, status: 'open' });
  await put('debts', 'debt1', { debtorId: 'dev1', description: 'Empréstimo Telas', principalCents: 40000, dueDate: noon(`${month}-28`), installmentNumber: 1, status: 'pending' });

  for (const [label, rules] of [['Rules do repositório', NEW_RULES], ['Rules ANTIGAS (sem reversals)', LEGACY_RULES]]) {
    await setRules(rules);
    for (const name of PAGES) {
      step = `${label} · ${name}`;
      const before = problems.length;
      const text = await open(name);
      assert.ok(text.length > 40, `${step}: tela em branco (conteúdo: "${text}")`);
      const fresh = problems.slice(before).filter((p) => p.startsWith('pageerror') || /Uncaught|TypeError|ReferenceError/.test(p));
      assert.deepEqual(fresh, [], `${step}: erro de JavaScript`);
      console.info(`  ✓ ${step}`);
    }
  }

  step = 'Rules ANTIGAS · Metas: lista visível, guardado/ações dependentes de estorno indisponíveis';
  await setRules(LEGACY_RULES);
  let text = await open('metas');
  assert.match(text, /Viagem Telas/);
  assert.doesNotMatch(text, /R\$ 300,00/, 'guardado da meta não pode ser exibido sem os estornos');
  assert.equal(await page.locator('#goals-reversals-unavailable').count(), 1, 'aviso explícito de limitação');
  assert.equal(await page.getByRole('button', { name: /Aportar em Viagem/ }).count(), 0, 'aporte desativado sem estornos');

  step = 'Rules do repositório · Metas: guardado exibido e aporte disponível';
  await setRules(NEW_RULES);
  text = await open('metas');
  assert.match(text, /R\$ 300,00/);
  assert.equal(await page.locator('#goals-reversals-unavailable').count(), 0);

  step = 'Rules ANTIGAS · Devedores: fechamento indisponível com causa explícita e nova tentativa';
  await setRules(LEGACY_RULES);
  text = await open('devedores');
  assert.match(text, /Devedor Telas/, 'a lista de devedores continua válida');
  assert.equal(await page.locator('#closing-unavailable[data-kind="denied"]').count(), 1);
  assert.doesNotMatch(text, /A receber em \d{2}\/\d{4}\s+R\$/, 'nenhum total de fechamento (o card mostra "—")');
  await setRules(NEW_RULES);
  await page.click('#retry-closing');
  await page.waitForFunction(() => !document.querySelector('#closing-unavailable'));
  assert.match(await content(), /R\$ 400,00/, 'fechamento volta após a recuperação');

  step = 'Rules ANTIGAS · Dashboard: sem saldo e com aviso; Rules do repositório + nova tentativa: saldo volta';
  await setRules(LEGACY_RULES);
  text = await open('dashboard');
  assert.equal(await page.locator('#dashboard-balance-unavailable').count(), 1);
  await setRules(NEW_RULES);
  await page.click('#retry-dashboard');
  await page.waitForFunction(() => !document.querySelector('#dashboard-balance-unavailable'));

  step = 'Consistência entre telas: saldo (1.000 + 500 − 200 − 300 de aporte) igual em Bancos e Dashboard';
  const total = async (name) => {
    await open(name);
    return (await page.locator('article.card', { has: page.getByText('Saldo total', { exact: true }) }).first().locator('.card__value').innerText()).trim();
  };
  assert.equal(await total('bancos'), 'R$ 1.000,00');
  assert.equal(await total('dashboard'), 'R$ 1.000,00');

  step = 'Fluxo real: aportar R$ 100,00 na meta pela interface reflete em Metas, Bancos e Dashboard';
  await open('metas');
  await page.getByRole('button', { name: /Aportar em Viagem/ }).click();
  await page.fill('#amountCents', '100,00');
  await page.selectOption('#accountId', 'accA');
  await page.click('#goal-move-form button[type="submit"]');
  await page.waitForFunction(() => /R\$ 400,00/.test(document.querySelector('#page-content')?.innerText ?? ''), null, { timeout: 15000 });
  assert.equal(await total('bancos'), 'R$ 900,00');
  assert.equal(await total('dashboard'), 'R$ 900,00');

  step = 'Fluxo real: Assinaturas — criar, pausar, retomar e excluir pela interface';
  await open('assinaturas');
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#subscription-form #name', 'Streaming Telas');
  await page.fill('#subscription-form #amountCents', '39,90');
  await page.fill('#subscription-form #nextChargeDate', `${month}-28`);
  await page.selectOption('#subscription-form #accountId', 'accA');
  await page.selectOption('#subscription-form #categoryId', 'catE');
  await page.click('#subscription-form button[type="submit"]');
  await page.waitForFunction(() => /Streaming Telas/.test(document.querySelector('#page-content')?.innerText ?? ''), null, { timeout: 15000 });
  await page.getByRole('button', { name: /Pausar Streaming Telas/ }).click();
  await page.getByRole('button', { name: /Retomar Streaming Telas/ }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Retomar Streaming Telas/ }).click();
  await page.getByRole('button', { name: /Pausar Streaming Telas/ }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Excluir Streaming Telas/ }).click();
  await page.getByRole('button', { name: /^Excluir$/ }).click();
  await page.waitForFunction(() => !/Streaming Telas/.test(document.querySelector('#page-content')?.innerText ?? ''), null, { timeout: 15000 });
  console.info('E2E todas as telas OK');
} catch (error) {
  console.error(`E2E todas as telas FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-allpages-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await setRules(NEW_RULES).catch(() => {});
  await app.close();
}
