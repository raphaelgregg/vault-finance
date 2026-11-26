/** Rotas (VF-2-04): menu, página HTML, rewrite do Vercel e módulo registrado em app.js em sincronia. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_ITEMS } from '../../js/utils/nav.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const appJs = readFileSync(join(root, 'js', 'app.js'), 'utf8');

describe('rotas de navegação', () => {
  for (const item of NAV_ITEMS) {
    it(`${item.id}: página, data-page, rewrite limpo e módulo`, () => {
      const page = join(root, 'pages', `${item.id}.html`);
      assert.ok(existsSync(page), `pages/${item.id}.html`);
      assert.equal(item.href, `${item.id}.html`);
      assert.match(readFileSync(page, 'utf8'), new RegExp(`data-page="${item.id}"`));
      const rewrite = vercel.rewrites.find((r) => r.source === `/${item.id}`);
      // Com `cleanUrls: true` a Vercel serve o arquivo SEM extensão: destino com `.html` dá 404 (VF-2-03y).
      assert.equal(rewrite?.destination, `/pages/${item.id}`, 'rewrite em vercel.json (sem .html)');
      assert.match(appJs, new RegExp(`\\b${item.id}: \\(\\) => import\\('./modules/${item.id}.js'\\)`), 'MODULES em app.js');
      assert.ok(existsSync(join(root, 'js', 'modules', `${item.id}.js`)), 'módulo JS');
    });
  }
});

describe('rota dedicada de manutenção (VF-2-03u)', () => {
  it('manutencao-dados: página, data-page, rewrite limpo e módulo — fora do menu principal', () => {
    const page = join(root, 'pages', 'manutencao-dados.html');
    assert.ok(existsSync(page));
    assert.match(readFileSync(page, 'utf8'), /data-page="manutencao-dados"/);
    assert.equal(vercel.rewrites.find((r) => r.source === '/manutencao-dados')?.destination, '/pages/manutencao-dados');
    assert.match(appJs, /'manutencao-dados': \(\) => import\('\.\/modules\/manutencao-dados\.js'\)/);
    assert.ok(existsSync(join(root, 'js', 'modules', 'manutencao-dados.js')));
    assert.equal(NAV_ITEMS.some((i) => i.id === 'manutencao-dados'), false); // painel interno, sem item de menu
  });
});

describe('rota do playbook (VF-DOC-01)', () => {
  it('playbook: página, data-page, rewrite limpo e módulo — fora do menu principal', () => {
    const page = join(root, 'pages', 'playbook.html');
    assert.ok(existsSync(page));
    assert.match(readFileSync(page, 'utf8'), /data-page="playbook"/);
    assert.equal(vercel.rewrites.find((r) => r.source === '/playbook')?.destination, '/pages/playbook');
    assert.match(appJs, /\bplaybook: \(\) => import\('\.\/modules\/playbook\.js'\)/);
    assert.ok(existsSync(join(root, 'js', 'modules', 'playbook.js')));
    assert.equal(NAV_ITEMS.some((i) => i.id === 'playbook'), false);
  });
});

describe('rewrites × cleanUrls (VF-2-03y)', () => {
  it('nenhum destino termina em .html enquanto cleanUrls estiver ligado (a Vercel responde 404)', () => {
    assert.equal(vercel.cleanUrls, true);
    for (const r of vercel.rewrites) assert.doesNotMatch(r.destination, /\.html$/, `${r.source} → ${r.destination}`);
  });
  it('páginas internas não têm scripts inline nem handlers on* (CSP script-src sem unsafe-inline)', () => {
    const pages = ['index.html', ...NAV_ITEMS.map((i) => `pages/${i.id}.html`), 'pages/manutencao-dados.html', 'pages/playbook.html'];
    for (const file of pages) {
      const html = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>\s*\S/, `${file}: script inline`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${file}: handler inline`);
    }
  });
});
