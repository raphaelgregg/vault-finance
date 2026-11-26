/**
 * Gerador do playbook (VF-DOC-01) — sem dependências.
 *
 *  1. `docs/playbook/referencia-gerada.md`: fatos EXTRAÍDOS do código (rotas, coleções e campos das Rules, operações do
 *     servidor, variáveis de ambiente, scripts npm, testes, CSP, tarefas do PLAN.md…). Nunca editar à mão.
 *  2. `docs/playbook/index.json`: todos os `.md` de `docs/playbook/` (front matter + seções) — é o que a página
 *     `/playbook` (admin) consome via `/api/docs`.
 *
 * Uso:  npm run docs:build   (regenera)   ·   npm run docs:check   (falha se algo estiver defasado — roda nos testes/CI).
 * O conteúdo é DETERMINÍSTICO (sem datas nem hashes de commit), por isso "defasado" significa de fato "o código mudou".
 * Uma GitHub Action (`.github/workflows/playbook.yml`) roda este script e comita o resultado na `claude-dev`.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontMatter, metaList, splitSections } from '../js/utils/markdown.js';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const PLAYBOOK_DIR = join(ROOT, 'docs', 'playbook');
export const REFERENCE_FILE = join(PLAYBOOK_DIR, 'referencia-gerada.md');
export const INDEX_FILE = join(PLAYBOOK_DIR, 'index.json');

/** Ordem das categorias na página (as demais vão ao fim, em ordem alfabética). */
export const CATEGORY_ORDER = ['Começar aqui', 'Operação', 'Segurança', 'Funcionalidades', 'Testes', 'Runbooks', 'Referência'];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));
const list = (rel, filter = () => true) => (exists(rel) ? readdirSync(join(ROOT, rel)).filter(filter).sort() : []);
const walk = (rel, out = []) => {
  for (const name of list(rel)) {
    const full = join(rel, name);
    if (['node_modules', '.git'].includes(name)) continue;
    if (statSync(join(ROOT, full)).isDirectory()) walk(full, out); else out.push(full.split('\\').join('/'));
  }
  return out;
};
const esc = (text) => String(text).replace(/\|/g, '\\|');
const code = (text) => `\`${text}\``;
const table = (head, rows) => (rows.length
  ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => esc(c)).join(' | ')} |`)].join('\n')
  : '_Nenhum item._');

// ---------------------------------------------------------------------------------------------------------------
// Extração de fatos
// ---------------------------------------------------------------------------------------------------------------

export function extractPages() {
  const appJs = read('js/app.js');
  const modules = new Set([...appJs.matchAll(/^\s*'?([\w-]+)'?: \(\) => import\('\.\/modules\/([\w-]+)\.js'\)/gm)].map((m) => m[1]));
  const vercel = JSON.parse(read('vercel.json'));
  const nav = read('js/utils/nav.js');
  const navIds = new Map([...nav.matchAll(/\{ id: '([\w-]+)', label: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  return list('pages', (f) => f.endsWith('.html')).map((file) => {
    const id = file.replace(/\.html$/, '');
    const html = read(`pages/${file}`);
    const dataPage = /data-page="([\w-]+)"/.exec(html)?.[1] ?? id;
    const rewrite = vercel.rewrites?.find((r) => r.destination === `/pages/${id}`)?.source ?? '—';
    const moduleFile = modules.has(dataPage) ? `js/modules/${dataPage}.js` : '—';
    const imports = exists(moduleFile) ? [...new Set([...read(moduleFile).matchAll(/from '\.\.\/services\/([\w-]+)\.js'/g)].map((m) => m[1]))].sort() : [];
    return { id, label: navIds.get(id) ?? '(fora do menu)', route: rewrite, module: moduleFile, services: imports };
  });
}

export function extractCollections() {
  const rules = read('firestore.rules');
  const blocks = [...rules.matchAll(/^ {4}match \/users\/\{userId\}\/([\w]+)\/\{\w+\} \{\n([\s\S]*?)\n {4}\}\n/gm)];
  return blocks.map((m) => {
    const body = m[2];
    const allow = (verb) => {
      const re = new RegExp(`allow ([\\w, ]*\\b${verb}\\b[\\w, ]*):([\\s\\S]*?);`, 'm');
      const found = re.exec(body)?.[2] ?? '';
      if (!found) return '—';
      if (/^\s*if false\s*$/.test(found)) return 'negado';
      const who = [/isOwner\(userId\)/.test(found) ? 'dono' : '', /isAdmin\(\)/.test(found) ? 'admin' : ''].filter(Boolean).join('+');
      return who || 'condicional';
    };
    const keys = /keysOk\(\[([^\]]*)\]\)/.exec(body)?.[1] ?? '';
    return {
      name: m[1],
      read: allow('read'),
      write: allow('create'),
      remove: allow('delete'),
      fields: [...keys.matchAll(/'([\w]+)'/g)].map((k) => k[1]).filter((k) => !['createdAt', 'updatedAt'].includes(k)),
    };
  });
}

/** Operações REAIS do registro do servidor (inclui as registradas em laço), não uma busca textual. */
export async function extractOps() {
  const { registry } = await import('../server/finance/index.mjs');
  return [...registry.entries()].map(([name, def]) => ({ name, recentLogin: Boolean(def.recentLogin) })).sort((a, b) => a.name.localeCompare(b.name));
}

export function extractEnv() {
  const files = [...walk('api'), ...walk('server'), ...walk('scripts'), 'js/firebase/config.js'].filter((f) => /\.(m?js)$/.test(f));
  const found = new Map();
  for (const file of files) {
    for (const m of read(file).matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{3,})\b/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(file);
    }
  }
  return [...found.entries()].map(([name, set]) => ({ name, files: [...set].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

export function extractTests() {
  const dirs = ['model', 'services', 'rules', 'integration', 'e2e'];
  return dirs.map((dir) => ({ dir, files: list(`tests/${dir}`, (f) => /\.(m?js)$/.test(f)).length }));
}

export function extractCsp() {
  const vercel = JSON.parse(read('vercel.json'));
  const csp = vercel.headers?.flatMap((h) => h.headers ?? []).find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  return csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return { name, values: values.map((v) => (v.startsWith("'sha256-") ? "'sha256-…'" : v)).join(' ') };
  });
}

export function extractPlanTasks() {
  if (!exists('PLAN.md')) return [];
  const tasks = [];
  for (const line of read('PLAN.md').split('\n')) {
    const m = /^\s*- \[([ x])\] \*\*(VF-[\w-]+) — (.+?)\*\*/.exec(line);
    if (m) tasks.push({ id: m[2], done: m[1] === 'x', title: m[3] });
  }
  return tasks;
}

// ---------------------------------------------------------------------------------------------------------------
// Referência gerada
// ---------------------------------------------------------------------------------------------------------------

export async function buildReference() {
  const pkg = JSON.parse(read('package.json'));
  const pages = extractPages();
  const collections = extractCollections();
  const ops = await extractOps();
  const env = extractEnv();
  const tests = extractTests();
  const csp = extractCsp();
  const tasks = extractPlanTasks();
  const vercel = JSON.parse(read('vercel.json'));
  const workflows = list('.github/workflows', (f) => f.endsWith('.yml')).map((f) => {
    const text = read(`.github/workflows/${f}`);
    return { file: f, name: /^name:\s*(.+)$/m.exec(text)?.[1] ?? f, on: /^on:\s*\n([\s\S]*?)\n\w/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? '' };
  });
  const apiFiles = list('api', (f) => f.endsWith('.mjs'));

  const out = [];
  out.push('---', 'title: Referência gerada do código', 'category: Referência', 'tags: referência, gerado, rotas, rules, operações, variáveis, scripts, csp',
    'summary: Fatos extraídos automaticamente do código (rotas, coleções, operações do servidor, ambiente, scripts, testes, CSP, tarefas).',
    'files: scripts/gen-playbook.mjs', '---', '');
  out.push('# Referência gerada do código', '',
    '> **Este arquivo é GERADO por `npm run docs:build` (`scripts/gen-playbook.mjs`). Não edite à mão:** a próxima geração sobrescreve. '
    + 'Ele reflete o estado atual do código e é atualizado automaticamente a cada push na `claude-dev` (ver [Atualização automática](doc:atualizacao-automatica)).', '');

  out.push('## Páginas e rotas', '', 'Cada página HTML, a rota limpa na Vercel (`vercel.json`), o módulo que a renderiza e os services que ele importa.', '',
    table(['Página', 'Menu', 'Rota', 'Módulo', 'Services'], pages.map((p) => [code(`pages/${p.id}.html`), p.label, code(p.route), p.module === '—' ? '—' : code(p.module), p.services.map(code).join(', ') || '—'])), '');

  out.push('## Funções de servidor (Vercel)', '',
    table(['Arquivo', 'maxDuration', 'includeFiles'], apiFiles.map((f) => [code(`api/${f}`), String(vercel.functions?.[`api/${f}`]?.maxDuration ?? 'padrão'), code(vercel.functions?.[`api/${f}`]?.includeFiles ?? '—')])), '');

  out.push('## Coleções do Firestore e Rules', '',
    'Extraído de `firestore.rules`. "negado" = o cliente não escreve (só o servidor, via Admin SDK). Campos = lista fechada aceita pelas Rules (sem `createdAt`/`updatedAt`).', '',
    table(['Coleção (`users/{uid}/…`)', 'Leitura', 'Criar/editar', 'Excluir', 'Campos'], collections.map((c) => [code(c.name), c.read, c.write, c.remove, c.fields.map(code).join(' ') || '—'])), '');

  out.push('## Operações do servidor (`POST /api/finance`)', '',
    'Registradas com `defineOp` em `server/finance/ops.mjs`. "Login recente" = exige `auth_time` ≤ 5 min (VF-SEC-01).', '',
    table(['Operação', 'Login recente'], ops.map((o) => [code(o.name), o.recentLogin ? 'sim' : '—'])), '');

  out.push('## Variáveis de ambiente (servidor)', '', 'Lidas por `process.env`/`env` em `api/`, `server/` e `scripts/`. Valores NUNCA aparecem aqui.', '',
    table(['Variável', 'Usada em'], env.map((e) => [code(e.name), e.files.map(code).join(', ')])), '');

  out.push('## Scripts npm', '', table(['Script', 'Comando'], Object.entries(pkg.scripts ?? {}).map(([k, v]) => [code(`npm run ${k}`), code(v.length > 110 ? `${v.slice(0, 107)}…` : v)])), '');
  out.push('## Dependências', '', table(['Pacote', 'Versão', 'Tipo'], [
    ...Object.entries(pkg.dependencies ?? {}).map(([k, v]) => [code(k), code(v), 'produção']),
    ...Object.entries(pkg.devDependencies ?? {}).map(([k, v]) => [code(k), code(v), 'desenvolvimento']),
  ]), '', `Motor exigido: ${code(`node ${pkg.engines?.node ?? '—'}`)}.`, '');

  out.push('## Testes', '', table(['Pasta', 'Arquivos'], tests.map((t) => [code(`tests/${t.dir}/`), String(t.files)])), '');
  out.push('## Workflows do GitHub', '', table(['Arquivo', 'Nome', 'Gatilhos'], workflows.map((w) => [code(w.file), w.name, w.on])), '');
  out.push('## Content-Security-Policy (`vercel.json`)', '', table(['Diretiva', 'Valores'], csp.map((d) => [code(d.name), d.values])), '');
  out.push('## Tarefas do PLAN.md', '', `${tasks.filter((t) => t.done).length} concluídas, ${tasks.filter((t) => !t.done).length} abertas.`, '',
    table(['ID', 'Estado', 'Título'], tasks.map((t) => [code(t.id), t.done ? 'concluída' : 'aberta', t.title])), '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Índice (JSON consumido pela página)
// ---------------------------------------------------------------------------------------------------------------

const docIdFor = (rel) => basename(rel, '.md').replace(/^\d+-/, '');

export async function buildIndex() {
  const docs = [];
  const files = walk('docs/playbook').filter((f) => f.endsWith('.md'));
  for (const rel of files) {
    const source = rel === 'docs/playbook/referencia-gerada.md' ? await buildReference() : read(rel);
    const { meta, body } = parseFrontMatter(source);
    if (!meta.title) throw new Error(`${rel}: front matter sem "title".`);
    if (!meta.category) throw new Error(`${rel}: front matter sem "category".`);
    docs.push({
      id: docIdFor(rel), title: meta.title, category: meta.category, tags: metaList(meta.tags), summary: meta.summary ?? '',
      files: metaList(meta.files), page: meta.page ?? '', file: rel, sections: splitSections(body),
    });
  }
  const rank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i; };
  docs.sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category) || a.file.localeCompare(b.file));
  const ids = docs.map((d) => d.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`id de documento repetido: ${dup}`);
  return { version: 1, docs };
}

export const serialize = (value) => `${JSON.stringify(value, null, 1)}\n`;

/** Gera os dois arquivos. Retorna { reference, index } (textos). */
export async function generate() {
  return { reference: await buildReference(), index: serialize(await buildIndex()) };
}

/** Compara o que está no disco com o que o código gera agora. Retorna lista de arquivos defasados. */
export async function stale() {
  const { reference, index } = await generate();
  const out = [];
  const current = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  if (current(REFERENCE_FILE) !== reference) out.push(relative(ROOT, REFERENCE_FILE).split('\\').join('/'));
  // o índice embute a referência gerada: precisa ser calculado depois de gravá-la, mas é puro, então comparamos direto
  if (current(INDEX_FILE) !== index) out.push(relative(ROOT, INDEX_FILE).split('\\').join('/'));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--check')) {
    const old = await stale();
    if (old.length) {
      console.error(`Playbook defasado: ${old.join(', ')}. Rode \`npm run docs:build\` e comite o resultado.`);
      process.exit(1);
    }
    console.info('Playbook em dia.');
  } else {
    const { reference, index } = await generate();
    writeFileSync(REFERENCE_FILE, reference);
    writeFileSync(INDEX_FILE, index);
    console.info(`Playbook gerado: ${relative(ROOT, REFERENCE_FILE)} e ${relative(ROOT, INDEX_FILE)}.`);
  }
}
