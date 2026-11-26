/**
 * Busca do playbook (VF-DOC-01) — pura, sem DOM/rede. Indexa cada SEÇÃO dos documentos e responde a consultas com
 * todos os termos (AND), sem diferenciar maiúsculas nem acentos, com pontuação por onde o termo aparece
 * (título da seção > tags > título do documento > corpo) e um trecho em volta do primeiro acerto.
 */
import { parseInline, inlineText } from './markdown.js';

/** Minúsculas e sem acentos: "Configurações" → "configuracoes". */
export const fold = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Termos da consulta (≥ 2 caracteres, sem repetição). */
export function queryTerms(query) {
  return [...new Set(fold(query).split(/[^a-z0-9_./:-]+/).filter((t) => t.length >= 2))];
}

/** Markdown da seção → texto corrido para busca (sem marcação). */
export function plainText(md) {
  return String(md ?? '')
    .split('\n')
    .filter((line) => !/^\s*\|?\s*:?-{2,}/.test(line))
    .map((line) => inlineText(parseInline(line.replace(/^\s*(#{1,6}|>|[-*]|\d+\.)\s+/, '').replace(/^\s*```.*$/, '')))
      .replace(/\|/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

/** Índice a partir do JSON do playbook: um registro por seção. */
export function buildIndex(playbook) {
  const entries = [];
  for (const doc of playbook?.docs ?? []) {
    for (const section of doc.sections ?? []) {
      const text = plainText(section.md);
      entries.push({
        docId: doc.id, docTitle: doc.title, category: doc.category, tags: doc.tags ?? [],
        sectionId: section.id, heading: section.heading, text,
        f: { heading: fold(section.heading), title: fold(doc.title), tags: fold((doc.tags ?? []).join(' ')), text: fold(text), files: fold((doc.files ?? []).join(' ')) },
      });
    }
  }
  return entries;
}

const countOf = (haystack, needle) => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && n < 20; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
};

/** Trecho de ~`size` caracteres em volta do primeiro termo encontrado no texto original (preserva acentos). */
export function snippet(text, terms, size = 160) {
  const folded = fold(text);
  let at = -1;
  for (const term of terms) {
    const idx = folded.indexOf(term);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return String(text).slice(0, size).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - Math.floor(size / 3));
  const piece = String(text).slice(start, start + size).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${start + size < text.length ? '…' : ''}`;
}

/**
 * Pesquisa. `opts`: { category, tag, limit (30) }. Retorna [{ docId, docTitle, category, tags, sectionId, heading,
 * snippet, score }] ordenado por pontuação. Consulta vazia → [] (a interface mostra o sumário).
 */
export function search(index, query, { category = '', tag = '', limit = 30 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const wantTag = fold(tag);
  const results = [];
  for (const entry of index) {
    if (category && entry.category !== category) continue;
    if (wantTag && !entry.f.tags.split(' ').includes(wantTag)) continue;
    let score = 0;
    let ok = true;
    for (const term of terms) {
      const inHeading = entry.f.heading.includes(term);
      const inTags = entry.f.tags.includes(term);
      const inTitle = entry.f.title.includes(term);
      const inFiles = entry.f.files.includes(term);
      const body = countOf(entry.f.text, term);
      if (!inHeading && !inTags && !inTitle && !inFiles && !body) { ok = false; break; }
      score += (inHeading ? 12 : 0) + (inTags ? 8 : 0) + (inTitle ? 5 : 0) + (inFiles ? 4 : 0) + Math.min(body, 6);
      if (entry.f.heading === term) score += 10; // título exato
    }
    if (ok) results.push({ docId: entry.docId, docTitle: entry.docTitle, category: entry.category, tags: entry.tags, sectionId: entry.sectionId, heading: entry.heading, snippet: snippet(entry.text, terms), score });
  }
  return results.sort((a, b) => b.score - a.score || a.docTitle.localeCompare(b.docTitle) || a.heading.localeCompare(b.heading)).slice(0, limit);
}

/** Categorias (na ordem do playbook) e tags (por frequência) para os filtros da interface. */
export function facets(playbook) {
  const categories = [];
  const tagCount = new Map();
  for (const doc of playbook?.docs ?? []) {
    if (!categories.includes(doc.category)) categories.push(doc.category);
    for (const tag of doc.tags ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  return { categories, tags };
}

/**
 * Divide `text` em partes { text, hit } marcando onde os termos (já sem acento/minúsculos) aparecem — para realce na
 * interface sem HTML. Se o mapeamento caractere a caractere não for possível, devolve o texto inteiro sem realce.
 */
export function highlight(text, terms) {
  const source = String(text ?? '');
  const chars = Array.from(source);
  const foldedChars = chars.map((c) => fold(c));
  if (!terms.length || foldedChars.some((c) => c.length !== 1)) return [{ text: source, hit: false }];
  const folded = foldedChars.join('');
  const mark = new Array(chars.length).fill(false);
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      for (let i = at; i < at + term.length; i += 1) mark[i] = true;
    }
  }
  const parts = [];
  chars.forEach((c, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === mark[i]) last.text += c; else parts.push({ text: c, hit: mark[i] });
  });
  return parts;
}
