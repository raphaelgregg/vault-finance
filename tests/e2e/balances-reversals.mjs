/**
 * VF-COR-02 — Bancos e Dashboard NUNCA apresentam saldo como confiável quando não é possível determinar se há estornos.
 * Matriz: (1) sem estorno · (2) estorno legível · (3) estorno existente com leitura NEGADA (Rules antigas, em tempo de
 * execução) · (4) Firestore offline · (5) nova tentativa após a recuperação · (6) atualização posterior (sem saldo "velho").
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

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const body = async () => (await page.locator('#page-content').innerText()).replace(/\s+/g, ' ');
const cardValue = async (label) => (await page.locator('article.card', { has: page.getByText(label, { exact: true }) }).first().locator('.card__value').innerText()).trim();
const goto = async (path, ready) => { await page.goto(`${app.base}/pages/${path}.html`); await page.waitForSelector(ready, { timeout: 30000 }); };
const failReads = (on) => page.evaluate((v) => localStorage.setItem('failReversals', v ? '1' : '0'), on);
const BANK_READY = '#calc-balances';
const DASH_READY = '#dashboard-month';

try {
  await registerUser(page, app.base, 'Saldos');
  // Falha de conexão SIMULADA nos estornos: ligada/desligada por localStorage (`list` de `reversals` → unavailable)
  await page.context().route('**/js/services/firestore.js', async (route) => {
    const response = await route.fetch();
    const src = (await response.text()).replace('export async function list(uid, collectionName, options = {}) {', "export async function list(uid, collectionName, options = {}) {\n  if (collectionName === 'reversals' && globalThis.localStorage?.getItem('failReversals') === '1') throw Object.assign(new Error('offline'), { code: 'unavailable' });\n  return list_(uid, collectionName, options);\n}\nasync function list_(uid, collectionName, options = {}) {");
    await route.fulfill({ response, body: src });
  });
  await goto('bancos', BANK_READY);
  const uid = await page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); for (let i = 0; i < 50 && !auth.currentUser; i += 1) await new Promise((r) => setTimeout(r, 100)); return auth.currentUser.uid; });
  const put = (c, id, data) => db.doc(`users/${uid}/${c}/${id}`).set({ ...data, ...stamp() });
  const today = new Date().toISOString().slice(0, 10);
  await put('accounts', 'accA', { institution: 'Banco Saldos', name: 'Corrente', type: 'checking', initialBalanceCents: 100000, color: '#000000', status: 'active' });
  await put('categories', 'catI', { name: 'Salário Saldos', kind: 'income', color: '#00aa00' });
  await put('incomes', 'inc1', { description: 'Salário', categoryId: 'catI', amountCents: 30000, expectedDate: noon(today), receivedDate: noon(today), accountId: 'accA', status: 'received', recurrence: 'none' });
  await put('debts', 'p0', { debtorId: 'dev', description: 'Moto', principalCents: 10000, dueDate: noon('2099-12-10'), installmentNumber: 1, status: 'paid' });
  await put('debtors', 'dev', { name: 'Devedor Saldos', loanDate: noon('2026-11-10'), lentCents: 10000, receivedCents: 10000, status: 'paid' });
  await put('debtPayments', 'pay1', { debtId: 'p0', debtorId: 'dev', amountCents: 10000, date: noon(today), accountId: 'accA' });
  const reverse = () => put('reversals', 'debtPayments_pay1', { kind: 'debtPayment', targetCollection: 'debtPayments', targetId: 'pay1', amountCents: 10000, reason: 'Conta errada', date: noon(today), operationId: 'rev-op-00001', accountId: 'accA', debtorId: 'dev', debtId: 'p0', original: {} });
  const assertTrusted = async (where, expected) => {
    assert.equal(await cardValue('Saldo total'), expected, `${where}: Saldo total`);
    assert.equal(await page.locator('#balance-unavailable, #dashboard-balance-unavailable').count(), 0, `${where}: sem aviso de indisponibilidade`);
  };
  const assertNoBalance = async (where, kind) => {
    assert.equal(await cardValue('Saldo total'), '—', `${where}: Saldo total deve ser "—"`);
    const text = await body();
    for (const n of ['R$ 1.300,00', 'R$ 1.400,00']) assert.equal(text.includes(n), false, `${where}: saldo "${n}" não pode aparecer`);
    assert.equal(await page.locator('#balance-unavailable, #dashboard-balance-unavailable').count(), 1, `${where}: aviso explícito`);
    if (kind) assert.match(await page.locator('#balance-unavailable, #dashboard-balance-unavailable').first().innerText(), kind);
  };

  log('1) NENHUM estorno (Rules novas): saldo normal e correto — Bancos e Dashboard (1.000 + 300 + 100 recebido)');
  await setRules(NEW_RULES);
  await goto('bancos', BANK_READY);
  await assertTrusted('Bancos', 'R$ 1.400,00');
  assert.match(await body(), /Saldo atual/); // coluna de saldo atual por conta
  await goto('dashboard', DASH_READY);
  await page.waitForFunction(() => /Saldo total/.test(document.querySelector('#page-content')?.innerText ?? ''));
  await assertTrusted('Dashboard', 'R$ 1.400,00');

  log('2) Estorno existente e LEGÍVEL: o saldo considera o estorno (1.400 → 1.300)');
  await reverse();
  await goto('bancos', BANK_READY);
  await assertTrusted('Bancos', 'R$ 1.300,00');
  await goto('dashboard', DASH_READY);
  await assertTrusted('Dashboard', 'R$ 1.300,00');

  log('3) Estorno existente e leitura NEGADA (Rules antigas): nenhum saldo como confiável — carga inicial');
  await setRules(LEGACY_RULES);
  await goto('bancos', BANK_READY);
  await page.waitForSelector('#balance-unavailable');
  await assertNoBalance('Bancos', /negada/);
  assert.doesNotMatch(await body(), /Saldo atual derivado|Recalcular saldo atual/); // sem "saldo derivado" nem coluna de saldo atual
  assert.doesNotMatch(await body(), /exibindo a soma dos saldos de abertura/);
  await goto('dashboard', DASH_READY);
  await page.waitForSelector('#dashboard-balance-unavailable');
  await assertNoBalance('Dashboard', /negada/);
  const heroSub = await page.locator('.hero__main').innerText(); // Livre/Vinculado ficam sob o saldo total
  assert.match(heroSub, /Livre —/);
  assert.match(heroSub, /Vinculado a metas —/);

  log('4) Firestore OFFLINE: erro explícito, sem saldo calculado com dados incompletos');
  await setRules(NEW_RULES);
  await failReads(true);
  await goto('bancos', BANK_READY);
  await page.waitForSelector('#balance-unavailable');
  await assertNoBalance('Bancos', /conexão/);
  assert.equal(await page.locator('#balance-unavailable').getAttribute('data-kind'), 'error');
  await goto('dashboard', DASH_READY);
  await page.waitForSelector('#dashboard-balance-unavailable');
  await assertNoBalance('Dashboard', /conexão/);

  log('5) NOVA TENTATIVA após a recuperação: o saldo correto volta (sem recarregar a página)');
  await failReads(false);
  await page.click('#retry-dashboard');
  await page.waitForFunction(() => !document.querySelector('#dashboard-balance-unavailable'));
  await assertTrusted('Dashboard', 'R$ 1.300,00');
  await failReads(true);
  await goto('bancos', BANK_READY);
  await page.waitForSelector('#balance-unavailable');
  await failReads(false);
  await page.click('#retry-balances');
  await page.waitForFunction(() => !document.querySelector('#balance-unavailable'));
  await assertTrusted('Bancos', 'R$ 1.300,00');

  log('6) ATUALIZAÇÃO posterior: saldo bom exibido; a próxima leitura falha → o saldo anterior NÃO permanece na tela');
  await goto('bancos', BANK_READY);
  await assertTrusted('Bancos', 'R$ 1.300,00');
  await failReads(true);
  await page.click('#calc-balances'); // "Recalcular saldo atual"
  await page.waitForSelector('#balance-unavailable');
  await assertNoBalance('Bancos (recalcular)', /conexão/);
  await failReads(false);
  await page.click('#retry-balances');
  await page.waitForFunction(() => !document.querySelector('#balance-unavailable'));
  await assertTrusted('Bancos', 'R$ 1.300,00');
  await goto('dashboard', DASH_READY);
  await failReads(true);
  await page.fill('#dashboard-month', new Date().toISOString().slice(0, 7)); // dispara nova carga
  await page.dispatchEvent('#dashboard-month', 'change');
  await page.waitForSelector('#dashboard-balance-unavailable');
  await assertNoBalance('Dashboard (atualização)', /conexão/);
  console.info('E2E saldos × estornos OK');
} catch (error) {
  console.error(`E2E saldos × estornos FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-balances-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await setRules(NEW_RULES).catch(() => {});
  await app.close();
}
