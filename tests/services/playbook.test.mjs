/**
 * VF-DOC-01 — playbook: parser de Markdown, busca, cliente, endpoint só de administrador e, principalmente, as
 * GARANTIAS DE ATUALIZAÇÃO AUTOMÁTICA: o índice/referência gerados não podem estar defasados e toda página, coleção,
 * operação do servidor e variável de ambiente precisa estar documentada em alguma ficha (senão estes testes falham).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, parseFrontMatter, parseInline, parseMarkdown, splitSections, metaList } from '../../js/utils/markdown.js';
import { fold, queryTerms, buildIndex, search, snippet, highlight, facets, plainText } from '../../js/utils/playbookSearch.js';
import { fetchPlaybook, DOCS_ENDPOINT } from '../../js/services/playbook.js';
import { handleDocs } from '../../server/docs/playbook.mjs';
import { stale, buildIndex as buildPlaybookIndex, extractPages, extractCollections, extractOps, extractEnv, ROOT } from '../../scripts/gen-playbook.mjs';

describe('markdown (puro e seguro)', () => {
  it('slug sem acentos e front matter', () => {
    assert.equal(slugify('Configurações — Senha Nº 1'), 'configuracoes-senha-n-1');
    const { meta, body } = parseFrontMatter('---\ntitle: X\ntags: a, b ,c\n---\n# Oi\n');
    assert.deepEqual([meta.title, metaList(meta.tags), body.trim()], ['X', ['a', 'b', 'c'], '# Oi']);
  });
  it('inline: código, negrito, itálico e links; destino inseguro vira texto', () => {
    const t = parseInline('Use `npm test` **agora** e *depois* [doc](doc:seguranca#sec-01) [x](javascript:alert(1)) [ext](https://a.b/c)');
    assert.deepEqual(t.filter((x) => x.t !== 'text').map((x) => x.t), ['code', 'strong', 'em', 'link', 'link']);
    assert.ok(!JSON.stringify(t).includes('javascript:'), 'link javascript: descartado');
    assert.equal(t.find((x) => x.t === 'link').href, 'doc:seguranca#sec-01');
  });
  it('blocos: títulos com id único, listas aninhadas, código, tabela, citação, hr', () => {
    const blocks = parseMarkdown('# A\n\n## B\n## B\n\n- um\n  - filho\n- dois\n\n1. x\n2. y\n\n```bash\nnpm test\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> nota\n\n---\n');
    assert.deepEqual(blocks.filter((b) => b.type === 'heading').map((b) => b.id), ['a', 'b', 'b-2']);
    const ul = blocks.find((b) => b.type === 'ul');
    assert.equal(ul.items.length, 2);
    assert.equal(ul.items[0].children.items.length, 1);
    assert.equal(blocks.find((b) => b.type === 'ol').items.length, 2);
    assert.deepEqual([blocks.find((b) => b.type === 'code').lang, blocks.find((b) => b.type === 'code').text], ['bash', 'npm test']);
    assert.equal(blocks.find((b) => b.type === 'table').rows[0].length, 2);
    assert.ok(blocks.some((b) => b.type === 'quote') && blocks.some((b) => b.type === 'hr'));
  });
  it('HTML cru não é interpretado (vira texto) e `# ` dentro de bloco de código não vira seção', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>');
    assert.equal(blocks[0].type, 'p');
    assert.equal(blocks[0].inline[0].t, 'text');
    const sections = splitSections('Intro\n\n## Um\n```bash\n## nao-secao\n```\n### Dois\ntexto');
    assert.deepEqual(sections.map((s) => s.heading), ['Resumo', 'Um', 'Dois']);
  });
});

describe('busca', () => {
  const playbook = { docs: [
    { id: 'a', title: 'Receitas', category: 'Funcionalidades', tags: ['receitas', 'saldo'], files: ['js/modules/receitas.js'], sections: [{ id: 'resumo', heading: 'Resumo', level: 2, md: 'Cadastro de **receitas** e recebimento.' }, { id: 'rules', heading: 'Regras do Firestore', level: 2, md: 'O status `received` só é gravado pelo servidor.' }] },
    { id: 'b', title: 'Segurança', category: 'Segurança', tags: ['seguranca'], files: [], sections: [{ id: 'resumo', heading: 'Resumo', level: 2, md: 'Autenticação e configurações do Firebase.' }] },
  ] };
  const index = buildIndex(playbook);
  it('sem acento, sem caixa, AND entre termos e ordenação por onde acerta', () => {
    assert.equal(fold('Configurações'), 'configuracoes');
    assert.deepEqual(queryTerms('  Receitas  RECEBIDO a '), ['receitas', 'recebido']);
    assert.equal(search(index, 'configuracoes')[0].docId, 'b');
    assert.equal(search(index, 'regras firestore')[0].sectionId, 'rules');
    assert.equal(search(index, 'receitas servidor').length, 1); // AND
    assert.equal(search(index, 'inexistente').length, 0);
    assert.deepEqual(search(index, ''), []);
  });
  it('filtros por categoria e tag; arquivos também são pesquisáveis; facetas', () => {
    assert.equal(search(index, 'receitas', { category: 'Segurança' }).length, 0);
    assert.ok(search(index, 'receitas', { tag: 'saldo' }).length >= 1);
    assert.equal(search(index, 'modules/receitas')[0].docId, 'a');
    assert.deepEqual(facets(playbook).categories, ['Funcionalidades', 'Segurança']);
  });
  it('trecho e realce preservam o texto original (acentos) e não geram HTML', () => {
    const text = 'Configurações do Firebase e das Rules';
    assert.match(snippet(text, ['firebase']), /Firebase/);
    const parts = highlight(text, ['configuracoes']);
    assert.deepEqual(parts.map((p) => [p.text, p.hit]), [['Configurações', true], [' do Firebase e das Rules', false]]);
    assert.equal(plainText('| a | b |\n| --- | --- |\n- **x** `y`'), 'a b\nx y');
  });
});

describe('cliente do playbook', () => {
  const user = { getIdToken: async () => 'TOK' };
  it('envia o Bearer, devolve o playbook e traduz erros', async () => {
    const seen = [];
    const ok = await fetchPlaybook(user, { fetch: async (url, init) => { seen.push([url, init.headers.authorization]); return { ok: true, status: 200, json: async () => ({ ok: true, playbook: { docs: [] } }) }; } });
    assert.deepEqual([ok.ok, seen[0]], [true, [DOCS_ENDPOINT, 'Bearer TOK']]);
    const denied = await fetchPlaybook(user, { fetch: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) }) });
    assert.deepEqual([denied.ok, denied.status], [false, 403]);
    assert.match(denied.error, /administradores/);
    assert.match((await fetchPlaybook(user, { fetch: async () => { throw new Error('x'); } })).error, /Sem conexão/);
    assert.equal((await fetchPlaybook(null)).ok, false);
  });
});

describe('/api/docs — só administradores', () => {
  const env = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_PROJECT_ID: 'demo-vault-finance' };
  const reply = (data, status = 200) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => data });
  const fakeFetch = (caller) => async (url) => {
    if (String(url).includes('accounts:lookup?key=')) return reply({ users: [{ localId: 'u1' }] });
    return reply({ users: [caller] });
  };
  const call = (caller, over = {}) => handleDocs({ method: 'GET', headers: { authorization: 'Bearer t' } }, { env, fetch: fakeFetch(caller), readIndex: async () => JSON.stringify({ version: 1, docs: [{ id: 'x' }] }), ...over });
  it('admin recebe o índice; não-admin 403; desativado 403; sem token 401; método ≠ GET 405', async () => {
    const quiet = console.error; console.error = () => {};
    try {
      const admin = await call({ localId: 'u1', customAttributes: JSON.stringify({ admin: true }) });
      assert.deepEqual([admin.status, admin.body.ok, admin.body.playbook.docs[0].id], [200, true, 'x']);
      assert.equal((await call({ localId: 'u1', customAttributes: '{}' })).status, 403);
      assert.equal((await call({ localId: 'u1', disabled: true, customAttributes: JSON.stringify({ admin: true }) })).status, 403);
      assert.equal((await handleDocs({ method: 'GET', headers: {} }, { env, fetch: fakeFetch({}) })).status, 401);
      assert.equal((await handleDocs({ method: 'POST', headers: {} }, { env })).status, 405);
      assert.equal((await call({ localId: 'u1', customAttributes: JSON.stringify({ admin: true }) }, { readIndex: async () => { throw new Error('nope'); } })).body.error, 'docs_unavailable');
      assert.equal((await handleDocs({ method: 'GET', headers: { authorization: 'Bearer t' } }, { env: { VERCEL_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: 'x' } })).body.error, 'EMULATOR_IN_PRODUCTION');
    } finally { console.error = quiet; }
  });
  it('o conteúdo não é servido como arquivo estático (redirect) e entra no pacote da função', () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    assert.ok(vercel.redirects.some((r) => /docs/.test(r.source)));
    assert.equal(vercel.functions['api/docs.mjs'].includeFiles, 'docs/playbook/index.json');
    assert.equal(vercel.rewrites.find((r) => r.source === '/playbook')?.destination, '/pages/playbook');
  });
});

describe('atualização automática: o playbook não pode ficar defasado', () => {
  it('index.json e referencia-gerada.md batem com o código (rode `npm run docs:build` se falhar)', async () => {
    assert.deepEqual(await stale(), []);
  });
  it('front matter válido; ids únicos; links internos (doc:id#secao) resolvem', async () => {
    const { docs } = await buildPlaybookIndex();
    const sections = new Map(docs.map((d) => [d.id, new Set(d.sections.map((s) => s.id))]));
    assert.ok(docs.length >= 8);
    for (const d of docs) {
      assert.ok(d.title && d.category, d.file);
      const md = d.sections.map((s) => s.md).join('\n');
      for (const m of md.matchAll(/\]\(doc:([a-z0-9-]+)(?:#([a-z0-9-]+))?\)/g)) {
        assert.ok(sections.has(m[1]), `${d.file}: doc:${m[1]} não existe`);
        if (m[2]) assert.ok(sections.get(m[1]).has(m[2]), `${d.file}: seção ${m[1]}#${m[2]} não existe`);
      }
    }
  });
  const prose = async () => (await buildPlaybookIndex()).docs.filter((d) => d.id !== 'referencia-gerada').flatMap((d) => [d.title, d.files.join(' '), d.sections.map((s) => `${s.heading}\n${s.md}`).join('\n')]).join('\n');
  it('toda página, coleção, operação do servidor e variável de ambiente está documentada em uma ficha', async () => {
    const text = await prose();
    const { docs } = await buildPlaybookIndex();
    const cards = new Set(docs.map((d) => d.page).filter(Boolean));
    const missing = [];
    for (const p of extractPages()) if (!cards.has(p.id)) missing.push(`página ${p.id} (front matter "page: ${p.id}")`);
    for (const c of extractCollections()) if (!text.includes(c.name)) missing.push(`coleção ${c.name}`);
    for (const o of await extractOps()) if (!text.includes(o.name)) missing.push(`operação ${o.name}`);
    for (const e of extractEnv()) if (!text.includes(e.name)) missing.push(`variável ${e.name}`);
    assert.deepEqual(missing, [], `Documente no playbook (docs/playbook/*.md): ${missing.join('; ')}`);
  });
  it('toda função de api/ e todo workflow estão documentados', () => {
    const text = readdirSync(join(ROOT, 'docs/playbook'), { recursive: true }).filter((f) => String(f).endsWith('.md')).map((f) => readFileSync(join(ROOT, 'docs/playbook', String(f)), 'utf8')).join('\n');
    const dirs = (rel) => readdirSync(join(ROOT, rel)).filter((f) => statSync(join(ROOT, rel, f)).isFile());
    for (const f of dirs('api')) assert.ok(text.includes(`api/${f}`), `api/${f} sem documentação`);
    for (const f of dirs('.github/workflows')) assert.ok(text.includes(f), `workflow ${f} sem documentação`);
  });
});
