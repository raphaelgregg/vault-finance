/**
 * E2E do playbook (VF-DOC-01): usuário comum é barrado (tela e endpoint 403); administrador vê o sumário, busca sem acento,
 * filtra, navega por links internos e por hash, e nada gera erro de console.
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }
const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };

try {
  await registerUser(page, app.base, 'Playbook Comum');

  log('usuário comum: a página nega e o endpoint responde 403');
  await page.goto(`${app.base}/pages/playbook.html`);
  await page.waitForSelector('#playbook-denied');
  const direct = await page.evaluate(async () => {
    const { auth } = await import('/js/firebase/client.js');
    const res = await fetch('/api/docs', { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken(true)}` } });
    return { status: res.status, body: await res.json() };
  });
  assert.deepEqual([direct.status, direct.body.error], [403, 'forbidden']);
  assert.equal(await page.locator('.pb').count(), 0);
  const configLink = await page.goto(`${app.base}/pages/configuracoes.html`).then(() => page.locator('#link-playbook').count());
  assert.equal(configLink, 0, 'link do playbook não aparece para não-admin');
  app.problems.length = 0; // o 403 provocado acima de propósito aparece no console do navegador: não é falha

  log('administrador: a página carrega com sumário e home por categorias');
  const uid = await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.uid);
  const claim = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true);
  // A claim só entra no token renovado (o link usa o token em cache, sem rede extra).
  await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.getIdToken(true));
  await page.goto(`${app.base}/pages/configuracoes.html`);
  await page.waitForSelector('#link-playbook');
  await page.goto(`${app.base}/pages/playbook.html`);
  await page.waitForSelector('.pb .pb-toc a[data-doc]');
  assert.ok((await page.locator('.pb-toc a[data-doc]').count()) >= 20, 'sumário com todos os documentos');
  assert.match(await page.locator('#playbook-article h2').first().innerText(), /Playbook de manutenção/);
  assert.ok((await page.locator('.pb-card').count()) >= 20);

  log('busca: sem acento e sem caixa, realce, e o resultado abre a seção certa');
  const counted = (text) => page.waitForFunction((t) => (document.querySelector('#playbook-count')?.innerText ?? '').includes(t), text); // espera o debounce da busca
  await page.fill('#playbook-search', 'configuracoes senha politica');
  await counted('configuracoes senha politica');
  await page.waitForSelector('#playbook-results:not([hidden]) .pb-result');
  assert.ok((await page.locator('.pb-result').count()) >= 1);
  assert.ok((await page.locator('.pb-result mark').count()) >= 1, 'termos realçados');
  await page.fill('#playbook-search', 'saldo derivado');
  await counted('saldo derivado');
  await page.waitForSelector('#playbook-results:not([hidden]) .pb-result');
  assert.match(await page.locator('.pb-result').first().innerText(), /Núcleo financeiro|Bancos|Dashboard|Receitas|Despesas|Arquitetura/);
  await page.locator('.pb-result').first().click();
  await page.waitForSelector('#playbook-article:not([hidden]) h2');
  assert.match(page.url(), /#doc\/[a-z0-9-]+/);

  log('nada encontrado: mensagem clara; Esc limpa e volta ao documento');
  await page.fill('#playbook-search', 'zzzxyz inexistente');
  await page.waitForFunction(() => /Nada encontrado/.test(document.querySelector('#playbook-count')?.innerText ?? ''));
  await page.press('#playbook-search', 'Escape');
  await page.waitForSelector('#playbook-results[hidden]', { state: 'attached' });

  log('filtros: categoria + tag listam documentos; tabela e código renderizam sem HTML cru');
  await page.selectOption('#playbook-category', 'Runbooks');
  await page.waitForFunction(() => /documento\(s\) no filtro/.test(document.querySelector('#playbook-results')?.innerText ?? ''));
  assert.equal(await page.locator('.pb-result').count(), 1);
  await page.selectOption('#playbook-category', '');
  await page.goto(`${app.base}/pages/playbook.html#doc/referencia-gerada`);
  await page.waitForSelector('#playbook-article table.pb-table');
  assert.ok((await page.locator('#playbook-article table.pb-table tbody tr').count()) > 20);
  await page.goto(`${app.base}/pages/playbook.html#doc/atualizacao-automatica`);
  await page.waitForSelector('.pb-code pre code');
  assert.equal(await page.locator('#playbook-article script').count(), 0);

  log('link interno entre fichas e atalho "/" focam o destino certo');
  await page.goto(`${app.base}/pages/playbook.html#doc/comecar-aqui`);
  await page.waitForSelector('#playbook-article a.pb-link');
  await page.locator('#playbook-article a.pb-link[href="#doc/seguranca"]').first().click();
  await page.waitForFunction(() => /Segurança/.test(document.querySelector('#playbook-article h2')?.innerText ?? ''));
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'playbook-search');

  assert.deepEqual(app.problems, [], `erros de console: ${app.problems.join(' | ')}`);
  console.info('E2E playbook OK');
} catch (error) {
  console.error(`E2E playbook FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-playbook-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
