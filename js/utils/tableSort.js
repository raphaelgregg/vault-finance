/**
 * Ordenação e filtro de tabelas — lógica PURA (sem DOM), testável em Node. A camada de DOM é `components/table-tools.js`.
 *
 * Trabalha sobre o TEXTO exibido nas células (o que o usuário vê): detecta o tipo da coluna (valor em R$/número, data
 * dd/mm/aaaa, mês mm/aaaa ou texto) e produz uma chave comparável. Valores vazios ("—", "") ficam sempre por último.
 */

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Minúsculas e sem acentos — usado no filtro de texto. */
export const normalizeText = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const isEmptyValue = (text) => {
  const t = String(text ?? '').trim();
  return t === '' || t === '—' || t === '-' || t === 'null' || t === 'undefined';
};

const MONEY = /^-?\s*(?:R\$)?\s*-?\d{1,3}(?:\.\d{3})*,\d{2}$|^-?\s*(?:R\$)?\s*-?\d+,\d{2}$/;
const NUMBER = /^-?\d+(?:[.,]\d+)?\s*%?$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MONTH = /^(\d{2})\/(\d{4})$/;

/** Chave comparável de um texto para o tipo dado: number → Number; date/month → string ISO; text → texto. */
export function parseValue(text, type) {
  const t = String(text ?? '').trim();
  if (type === 'number') {
    const cleaned = t.replace(/R\$|\s|%/g, '');
    const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const m = DATE.exec(t);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  if (type === 'month') {
    const m = MONTH.exec(t);
    return m ? `${m[2]}-${m[1]}` : null;
  }
  return t;
}

/** Tipo da coluna: o mais específico que TODOS os valores não vazios satisfazem; senão texto. */
export function detectColumnType(values) {
  const filled = values.map((v) => String(v ?? '').trim()).filter((v) => !isEmptyValue(v));
  if (!filled.length) return 'text';
  if (filled.every((v) => DATE.test(v))) return 'date';
  if (filled.every((v) => MONTH.test(v))) return 'month';
  if (filled.every((v) => MONEY.test(v) || NUMBER.test(v))) return 'number';
  return 'text';
}

/** Compara dois textos de uma coluna. Vazios sempre depois (independe da direção). Retorna número (como Array.sort). */
export function compareCells(a, b, type, direction = 'asc') {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const ka = parseValue(a, type);
  const kb = parseValue(b, type);
  let result;
  if (type === 'number') result = (ka ?? 0) - (kb ?? 0);
  else if (type === 'date' || type === 'month') result = String(ka).localeCompare(String(kb));
  else result = collator.compare(String(ka), String(kb));
  return direction === 'desc' ? -result : result;
}

/**
 * Ordena linhas (arrays de textos de célula) pela coluna `column`. Estável; devolve os ÍNDICES na nova ordem.
 * `direction`: 'asc' | 'desc'. Para voltar à ordem original basta não chamar (ou ordenar os índices).
 */
export function sortedIndexes(rows, column, direction = 'asc') {
  const type = detectColumnType(rows.map((r) => r[column]));
  return rows
    .map((row, index) => ({ index, value: row[column] }))
    .sort((x, y) => compareCells(x.value, y.value, type, direction) || x.index - y.index)
    .map((x) => x.index);
}

/** Índices das linhas que contêm TODOS os termos do filtro (sem acento/caixa), em qualquer célula. Filtro vazio → todas. */
export function filterIndexes(rows, query) {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  const all = rows.map((_, index) => index);
  if (!terms.length) return all;
  return all.filter((i) => {
    const haystack = normalizeText(rows[i].join(' '));
    return terms.every((t) => haystack.includes(t));
  });
}
