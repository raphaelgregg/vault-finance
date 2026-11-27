/**
 * E2E da navegação sem recarregar (VF-PERF-02): trocar de página não recarrega o documento; título, menu e `data-page`
 * acompanham; voltar/avançar funcionam; navegações concorrentes valem a mais recente; modal fecha ao sair; "#novo" abre o
 * formulário; carga direta e atualizar continuam funcionando; listeners globais da página saem junto com ela.
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }
const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const settled = (id) => page.waitForFunction((pid) => document.body.dataset.page === pid && !document.body.dataset.navigating
  && (document.querySelector('#page-content .page-root')?.children.length ?? 0) > 0, id, { timeout: 30000 });
const state = () => page.evaluate(() => ({
  marker: window.__vfMarker, page: document.body.dataset.page, title: document.title, heading: document.querySelector('.topbar__title')?.textContent,
  current: [...document.querySelectorAll('#sidebar [aria-current="page"]')].map((a) => a.getAttribute('href')), path: location.pathname,
}));
const click = (id) => page.locator(`#sidebar a[href="${id}.html"]`).click();

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .hero, #page-content .panel');
  await settled('dashboard');
  await page.evaluate(() => { window.__vfMarker = Math.random(); });
  const marker = (await state()).marker;
  assert.ok(marker > 0);

  log('cada troca de página NÃO recarrega o documento (marcador sobrevive) e título, menu e data-page acompanham');
  const labels = { despesas: 'Despesas', receitas: 'Receitas', bancos: 'Bancos', categorias: 'Categorias', transferencias: 'Transferências', orcamentos: 'Orçamentos', assinaturas: 'Assinaturas', devedores: 'Devedores', metas: 'Metas', cartoes: 'Cartões', relatorios: 'Relatórios', configuracoes: 'Configurações', dashboard: 'Dashboard' };
  for (const [id, label] of Object.entries(labels)) {
    await click(id);
    await settled(id);
    const s = await state();
    assert.equal(s.marker, marker, `${id}: o documento foi recarregado`);
    assert.deepEqual([s.page, s.heading, s.current], [id, label, [`${id}.html`]], id);
    assert.ok(s.title.startsWith(`${label} —`), `${id}: título "${s.title}"`);
    assert.match(s.path, new RegExp(`${id}(\\.html)?$`), `${id}: endereço ${s.path}`);
  }
  assert.ok((await page.evaluate(() => performance.getEntriesByName('vf:nav').length)) >= 5, 'marcas de tempo vf:nav');

  log('voltar e avançar do navegador trocam o conteúdo sem recarregar');
  await click('despesas'); await settled('despesas');
  await click('receitas'); await settled('receitas');
  await page.goBack(); await settled('despesas');
  assert.equal((await state()).marker, marker);
  assert.equal((await state()).heading, 'Despesas');
  await page.goForward(); await settled('receitas');
  assert.equal((await state()).heading, 'Receitas');
  assert.equal((await state()).marker, marker);

  log('cliques concorrentes: vale a última página; a anterior não escreve por cima');
  await page.evaluate(() => {
    document.querySelector('#sidebar a[href="despesas.html"]').click();
    document.querySelector('#sidebar a[href="bancos.html"]').click();
    document.querySelector('#sidebar a[href="transferencias.html"]').click();
  });
  await settled('transferencias');
  await page.waitForTimeout(1500); // dá tempo de uma página antiga terminar de carregar e tentar escrever
  const text = await page.locator('#page-content').innerText();
  assert.match(text, /Nova transferência/);
  assert.doesNotMatch(text, /Nova despesa|Nova conta/);
  assert.equal((await state()).heading, 'Transferências');

  log('modal aberto fecha ao navegar; "Lançar" (#novo) abre o formulário sem recarregar e sem deixar #novo no endereço');
  await click('despesas'); await settled('despesas');
  await page.getByRole('button', { name: /Nova despesa/ }).first().click();
  await page.waitForSelector('.modal');
  await page.evaluate(() => document.querySelector('#sidebar a[href="receitas.html"]').click());
  await settled('receitas');
  assert.equal(await page.locator('.modal').count(), 0, 'modal da página anterior ficou aberto');
  assert.equal(await page.evaluate(() => document.body.classList.contains('modal-open')), false);
  await page.evaluate(() => document.querySelector('.quick-menu a[href="despesas.html#novo"]').click());
  await settled('despesas');
  await page.waitForSelector('.modal');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal((await state()).marker, marker);
  await page.keyboard.press('Escape');

  log('carga direta e atualizar (F5) continuam funcionando — o documento é novo');
  await page.goto(`${app.base}/pages/metas.html`);
  await settled('metas');
  assert.equal((await state()).marker, undefined, 'carga direta cria um documento novo');
  assert.equal((await state()).heading, 'Metas');
  await page.reload();
  await settled('metas');
  assert.equal((await state()).heading, 'Metas');

  log('administrador: o playbook navega por hash sem ser sequestrado e seus listeners globais saem com a página');
  const uid = await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.uid);
  const claim = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true);
  await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.getIdToken(true));
  await page.goto(`${app.base}/pages/configuracoes.html`);
  await settled('configuracoes');
  await page.evaluate(() => { window.__vfMarker = 42; });
  await page.waitForSelector('#link-playbook');
  await page.click('#link-playbook');
  await settled('playbook');
  await page.waitForSelector('.pb .pb-toc a[data-doc]');
  assert.equal((await state()).marker, 42);
  assert.equal((await state()).heading, 'Playbook');
  await page.locator('.pb-toc a[data-doc="arquitetura"]').click();
  await page.waitForFunction(() => /#doc\/arquitetura/.test(location.hash));
  assert.equal((await state()).page, 'playbook');
  await page.goBack();
  await page.waitForFunction(() => !/#doc\//.test(location.hash));
  assert.equal((await state()).page, 'playbook');
  await click('despesas'); await settled('despesas');
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.id), '', 'o atalho "/" do playbook não pode continuar ativo em outras páginas');
  assert.equal(await page.locator('#playbook-search').count(), 0);

  log('sair volta ao login');
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL(/\/(index\.html)?(\?.*)?$/, { timeout: 20000 });

  assert.deepEqual(app.problems.filter((p) => !/status of 403|Failed to load resource/.test(p)), [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E navegação OK');
} catch (error) {
  console.error(`E2E navegação FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-navigation-fail.png' }).catch(() => {});
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
