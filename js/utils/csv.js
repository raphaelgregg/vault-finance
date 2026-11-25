/**
 * CSV puro (VF-2-03u): sem DOM, sem rede, sem dependências. UTF-8, delimitador `;` ou `,` (detectado no
 * cabeçalho), campos entre aspas com `""` escapado, quebras de linha CRLF/LF e BOM. Também valida/normaliza
 * valores monetários e datas de importação com exatidão (centavos inteiros decididos pelo modelo).
 */

/** Detecta o delimitador pela 1ª linha não vazia (fora de aspas): o mais frequente entre `;` e `,`; empate = `;`. */
export function detectDelimiter(text) {
  const first = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  let semi = 0;
  let comma = 0;
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ';') semi += 1;
    else if (!quoted && ch === ',') comma += 1;
  }
  return comma > semi ? ',' : ';';
}

/**
 * Lê CSV em linhas de campos. Retorna { delimiter, headers, rows: [{ line, values: { coluna: texto } }], errors }.
 * `line` = nº da linha no arquivo (cabeçalho = 1). Linhas totalmente vazias são ignoradas; colunas a mais/menos
 * que o cabeçalho geram erro na linha (não abortam as demais). Aspas não fechadas = erro global.
 */
export function parseCsv(text, { delimiter } = {}) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(src);
  const records = [];
  let field = '';
  let row = [];
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRow = () => {
    row.push(field);
    field = '';
    records.push({ line: startLine, cells: row });
    row = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      startLine = line;
    } else {
      field += ch;
    }
  }
  const errors = [];
  if (quoted) errors.push({ line: startLine, message: 'Aspas não fechadas.' });
  if (field !== '' || row.length) endRow();

  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { delimiter: sep, headers: [], rows: [], errors: [{ line: 1, message: 'Arquivo vazio.' }, ...errors] };
  const headers = nonEmpty[0].cells.map((h) => h.trim());
  const rows = [];
  for (const rec of nonEmpty.slice(1)) {
    if (rec.cells.length !== headers.length) {
      errors.push({ line: rec.line, message: `Esperadas ${headers.length} colunas, encontradas ${rec.cells.length}.` });
      continue;
    }
    rows.push({ line: rec.line, values: Object.fromEntries(headers.map((h, idx) => [h, rec.cells[idx].trim()])) });
  }
  return { delimiter: sep, headers, rows, errors };
}

/** Campo seguro para exportação: aspas quando preciso e proteção contra injeção de fórmula (=, +, -, @, tab, CR).
 * `-` só é neutralizado em TEXTO: número (inclusive negativo) segue intacto (VF-SEC-08). */
export function csvField(value, delimiter = ';') {
  let text = value === null || value === undefined ? '' : String(value);
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  if (/^[=+@\t\r]/.test(text) || (!isNumber && /^-/.test(text) && !/^-\d[\d.]*(,\d+)?$/.test(text))) text = `'${text}`;
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Monta CSV (CRLF, BOM opcional para Excel). `rows`: arrays alinhados a `headers`. */
export function toCsv(headers, rows, { delimiter = ';', bom = true } = {}) {
  const lines = [headers, ...rows].map((r) => r.map((c) => csvField(c, delimiter)).join(delimiter));
  return `${bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}

/**
 * Valor monetário de importação → texto normalizado "1234,56" aceito pelo modelo (centavos exatos) ou null.
 * Aceita: `1234`, `1234,5`, `1234,56`, `1.234,56`, `1.234` (convenção pt-BR: ponto = milhar, = 1234),
 * `1234.56` (ponto decimal com 1–2 casas) e prefixo `R$`. Rejeita negativos, mais de 2 casas decimais,
 * separadores misturados (`1,234.56`) e lixo.
 */
export function normalizeMoneyText(value) {
  const text = String(value ?? '').replace(/^R\$\s*/i, '').trim();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) return text.replace(/\./g, '');
  if (/^\d+(,\d{1,2})?$/.test(text)) return text;
  if (/^\d+\.\d{1,2}$/.test(text)) return text.replace('.', ',');
  return null;
}

/** "AAAA-MM-DD" de calendário real ou null (sem converter fuso). */
export function normalizeDateText(value) {
  const text = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? text : null;
}

/** Comparação de nomes sem acento/caixa/espaços extras (resolução de referências por nome). */
export const normalizeName = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
