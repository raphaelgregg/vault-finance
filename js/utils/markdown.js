/**
 * Markdown mínimo e SEGURO para o playbook (VF-DOC-01). Puro: não conhece DOM nem rede e nunca gera HTML — devolve
 * tokens que a interface renderiza com `textContent` (sem `innerHTML`, logo sem XSS). Sem dependências.
 *
 * Suporta: títulos (#…######), parágrafos, listas (-, *, 1.) com aninhamento por indentação, blocos de código (```),
 * tabelas (| a | b |), citações (>), régua (---) e inline: `código`, **negrito**, *itálico*, [texto](destino).
 * Destinos de link aceitos: `doc:<id>[#<seção>]` (interno), `#<seção>` (mesma página) e `http(s)://` (externo);
 * qualquer outro vira texto simples.
 */

/** "Seção Nº 1: Visão" → "secao-n-1-visao" (sem acentos; estável para âncoras). */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Front matter simples (`chave: valor` entre `---`). Listas = valores separados por vírgula. Retorna { meta, body }. */
export function parseFrontMatter(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Valor de front matter em lista: "a, b ,c" → ["a","b","c"]. */
export const metaList = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const SAFE_LINK = /^(doc:[a-z0-9-]+(#[a-z0-9-]+)?|#[a-z0-9-]+|https?:\/\/[^\s]+)$/i;

/** Tokens inline: { t: 'text'|'code'|'strong'|'em'|'link', v?, c?, href? }. */
export function parseInline(text) {
  const tokens = [];
  let rest = String(text ?? '');
  let buffer = '';
  const flush = () => { if (buffer) { tokens.push({ t: 'text', v: buffer }); buffer = ''; } };
  while (rest.length) {
    let m;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush(); tokens.push({ t: 'code', v: m[1] }); rest = rest.slice(m[0].length);
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      if (SAFE_LINK.test(m[2])) tokens.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
      else tokens.push({ t: 'text', v: m[1] });
      rest = rest.slice(m[0].length);
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      flush(); tokens.push({ t: 'strong', c: parseInline(m[1]) }); rest = rest.slice(m[0].length);
    } else if ((m = /^\*([^*\s][^*]*)\*/.exec(rest))) {
      flush(); tokens.push({ t: 'em', c: parseInline(m[1]) }); rest = rest.slice(m[0].length);
    } else {
      buffer += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return tokens;
}

/** Texto puro de tokens inline (para busca/títulos). */
export function inlineText(tokens) {
  return tokens.map((t) => (t.c ? inlineText(t.c) : t.v ?? '')).join('');
}

const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** Blocos: heading | p | ul | ol | code | table | quote | hr. Títulos recebem `id` único (slug + sufixo se repetir). */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const used = new Map();
  const uniqueId = (text) => {
    const base = slugify(text) || 'secao';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    let m;
    if ((m = /^```\s*([\w-]*)\s*$/.exec(line))) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ type: 'code', lang: m[1] || '', text: body.join('\n') });
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      const inline = parseInline(m[2]);
      blocks.push({ type: 'heading', level: m[1].length, id: uniqueId(inlineText(inline)), inline });
      i += 1;
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
    } else if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i]).map(parseInline)); i += 1; }
      blocks.push({ type: 'table', head, rows });
    } else if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', inline: parseInline(body.join(' ')) });
    } else if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length && (LIST_RE.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) items.push({ depth: Math.floor(lm[1].length / 2), ordered: /\d/.test(lm[2]), text: lm[3] });
        else items[items.length - 1].text += ` ${lines[i].trim()}`; // continuação do item
        i += 1;
      }
      blocks.push(buildList(items));
    } else {
      const body = [line.trim()];
      i += 1;
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*]|\d+\.)\s)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        body.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ type: 'p', inline: parseInline(body.join(' ')) });
    }
  }
  return blocks;
}

/** Itens planos com `depth` → { type: 'ul'|'ol', items: [{ inline, children?: <lista> }] }. */
function buildList(flat) {
  const build = (start, depth) => {
    const list = { type: flat[start].ordered ? 'ol' : 'ul', items: [] };
    let idx = start;
    while (idx < flat.length && flat[idx].depth >= depth) {
      if (flat[idx].depth === depth) {
        list.items.push({ inline: parseInline(flat[idx].text) });
        idx += 1;
      } else {
        const child = build(idx, flat[idx].depth);
        const last = list.items[list.items.length - 1];
        if (last) last.children = child.list; else list.items.push({ inline: [], children: child.list });
        idx = child.next;
      }
    }
    return { list, next: idx };
  };
  return build(0, flat[0].depth).list;
}

/**
 * Divide o corpo em seções por títulos de nível 2 e 3 (o nível 1 é o título do documento). O texto antes do primeiro
 * título vira a seção "Resumo". Retorna [{ id, heading, level, md }] com `md` = Markdown cru da seção (sem o título).
 */
export function splitSections(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  const used = new Map();
  const uniqueId = (text) => {
    const base = slugify(text) || 'secao';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
  let current = { id: 'resumo', heading: 'Resumo', level: 2, lines: [] };
  used.set('resumo', 1);
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) inCode = !inCode;
    const m = !inCode && /^(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      sections.push(current);
      const heading = inlineText(parseInline(m[2]));
      current = { id: uniqueId(heading), heading, level: m[1].length, lines: [] };
    } else if (!(!inCode && /^#\s/.test(line))) {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ id: s.id, heading: s.heading, level: s.level, md: s.lines.join('\n').trim() }))
    .filter((s) => s.md || s.id !== 'resumo');
}
