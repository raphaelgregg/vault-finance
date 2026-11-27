/**
 * VF-PERF-02 — rotas da navegação sem recarregar (`js/utils/pageRoutes.js`) e as regras que mantêm as páginas
 * compatíveis com o anfitrião (`js/components/page-host.js`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageIdFromPath, pageUrl, internalTarget } from '../../js/utils/pageRoutes.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const IDS = ['dashboard', 'despesas', 'receitas', 'manutencao-dados', 'playbook'];
const click = (over = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over });
const ORIGIN = 'https://vault.example';

describe('pageIdFromPath', () => {
  it('reconhece as formas de endereço (limpo, .html e /pages/)', () => {
    for (const p of ['/despesas', '/despesas.html', '/pages/despesas', '/pages/despesas.html', '/despesas/']) assert.equal(pageIdFromPath(p, IDS), 'despesas', p);
    assert.equal(pageIdFromPath('/manutencao-dados', IDS), 'manutencao-dados');
  });
  it('ignora o que não é página do app', () => {
    for (const p of ['/', '/index.html', '/api/finance', '/docs/playbook', '/pages/', '/pages/inexistente.html', '/js/app.js', '/despesas/extra', '', null, undefined]) {
      assert.equal(pageIdFromPath(p, IDS), null, String(p));
    }
  });
});

describe('pageUrl', () => {
  it('segue o estilo do endereço atual', () => {
    assert.equal(pageUrl('receitas', '/pages/despesas.html'), '/pages/receitas.html');
    assert.equal(pageUrl('receitas', '/despesas'), '/receitas');
    assert.equal(pageUrl('receitas'), '/receitas');
  });
});

describe('internalTarget (quais cliques viram navegação interna)', () => {
  const link = (href, over = {}) => ({ href: `${ORIGIN}${href}`, target: '', download: false, ...over });
  const t = (l, c = click()) => internalTarget({ click: c, link: l, origin: ORIGIN, ids: IDS });
  it('clique simples em página do app → { id, hash, search }', () => {
    assert.deepEqual(t(link('/despesas.html#novo')), { id: 'despesas', hash: '#novo', search: '' });
    assert.deepEqual(t(link('/pages/playbook.html?x=1')), { id: 'playbook', hash: '', search: '?x=1' });
  });
  it('deixa o navegador agir: teclas modificadoras, botão do meio, já tratado, target, download, outra origem, outras rotas', () => {
    for (const c of [click({ ctrlKey: true }), click({ metaKey: true }), click({ shiftKey: true }), click({ altKey: true }), click({ button: 1 }), click({ defaultPrevented: true })]) {
      assert.equal(t(link('/despesas'), c), null);
    }
    assert.equal(t(link('/despesas', { target: '_blank' })), null);
    assert.equal(t(link('/despesas', { download: true })), null);
    assert.equal(t({ href: 'https://outro.site/despesas', target: '', download: false }), null);
    assert.equal(t(link('/index.html')), null, 'login não é página interna');
    assert.equal(t(link('/api/docs')), null);
    assert.equal(t({ href: 'blob:https://vault.example/abc', target: '', download: false }), null);
    assert.equal(t({ href: 'nao é url', target: '', download: false }), null);
    assert.equal(t(link('/despesas', { target: '_self' }))?.id, 'despesas');
  });
});

describe('compatibilidade das páginas com o anfitrião', () => {
  const modules = readdirSync(join(root, 'js/modules')).filter((f) => f.endsWith('.js') && f !== 'devedores-parcelas.js');
  it('nenhum módulo procura o <main> global (uma página antiga escreveria na nova): só o contêiner recebido em render()', () => {
    for (const file of modules) {
      const src = readFileSync(join(root, 'js/modules', file), 'utf8');
      assert.doesNotMatch(src, /getElementById\('page-content'\)|\$\('#page-content'\)|\$\('\.content'\)/, `${file} usa o <main> global`);
    }
  });
  it('listeners em document/window só com { signal } (o anfitrião os remove ao sair da página)', () => {
    for (const file of modules) {
      const src = readFileSync(join(root, 'js/modules', file), 'utf8');
      for (const m of src.matchAll(/(?:document|window)\.addEventListener\(/g)) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < src.length && depth > 0) { if (src[i] === '(') depth += 1; else if (src[i] === ')') depth -= 1; i += 1; }
        assert.match(src.slice(m.index, i), /\bsignal\b/, `${file}: ${src.slice(m.index, m.index + 60)}`);
      }
    }
  });
  it('todo módulo registrado em app.js exporta render()', () => {
    const app = readFileSync(join(root, 'js/app.js'), 'utf8');
    for (const m of app.matchAll(/'?([\w-]+)'?: \(\) => import\('\.\/modules\/([\w-]+)\.js'\)/g)) {
      const src = readFileSync(join(root, 'js/modules', `${m[2]}.js`), 'utf8');
      assert.match(src, /export (async )?function render\(/, m[2]);
    }
  });
  it('páginas HTML: sem script inline e com os ids do shell que o anfitrião usa', () => {
    for (const file of readdirSync(join(root, 'pages')).filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(join(root, 'pages', file), 'utf8');
      assert.match(html, /id="page-content"/, file);
      assert.match(html, /data-page="[\w-]+"/, file);
    }
  });
});
