/**
 * PDF mínimo — puro, sem dependências (VF-FEAT-01), no mesmo espírito de `js/utils/zip.js`.
 *
 * Gera documentos de texto e formas simples com as fontes PADRÃO do PDF (Helvetica e Helvetica-Bold, codificação
 * WinAnsi): não embute fonte, então cobre o português (Latin-1) e símbolos comuns (— – • … “ ” ‘ ’). Caracteres fora
 * dessa faixa viram "?". Não sabe nada de DOM, rede ou domínio financeiro.
 *
 * Coordenadas em pontos (1/72 pol), origem no CANTO SUPERIOR ESQUERDO da página; `y` do texto é a linha de base.
 * Todo o conteúdo do arquivo é ASCII (textos vão em strings hexadecimais), então o deslocamento de cada objeto é exato.
 */
const encoder = new TextEncoder();

/** Larguras (1/1000 em) de ASCII 32..126 — AFM da Helvetica e da Helvetica-Bold. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Larguras de símbolos fora do ASCII (iguais nas duas fontes quando não indicado). */
const SYMBOL_WIDTH = { '—': 1000, '–': 556, '•': 350, '…': 1000, '·': 278, 'º': 365, 'ª': 370, '°': 400, '×': 584, '÷': 584, '€': 556, 'ß': 611, ' ': 278, '“': 333, '”': 333, '‘': 222, '’': 222 };

/** Bytes WinAnsi dos caracteres de 0x80–0x9F que não coincidem com Latin-1. */
const WIN_ANSI_SPECIAL = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Byte WinAnsi de um caractere (desconhecido → "?"; controle → espaço). */
export function winAnsiByte(char) {
  const code = char.codePointAt(0);
  if (code < 32) return 0x20;
  if (code < 127) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  if (WIN_ANSI_SPECIAL.has(code)) return WIN_ANSI_SPECIAL.get(code);
  const base = char.normalize('NFD')[0];
  return base && base.codePointAt(0) < 127 ? base.codePointAt(0) : 0x3f;
}

/** Texto → string hexadecimal WinAnsi (o que vai entre `<…>` no PDF). */
export function toHex(text) {
  let out = '';
  for (const char of String(text ?? '')) out += winAnsiByte(char).toString(16).padStart(2, '0');
  return out;
}

/** Largura de UM caractere em 1/1000 em. Acentuadas valem como a letra base. */
function glyphWidth(char, bold) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  const code = char.codePointAt(0);
  if (code >= 32 && code <= 126) return table[code - 32];
  if (SYMBOL_WIDTH[char] !== undefined) return SYMBOL_WIDTH[char];
  const base = char.normalize('NFD')[0];
  const baseCode = base?.codePointAt(0) ?? 0;
  return baseCode >= 32 && baseCode <= 126 ? table[baseCode - 32] : 556;
}

/** Largura do texto em pontos. */
export function measureText(text, { size = 10, bold = false } = {}) {
  let total = 0;
  for (const char of String(text ?? '')) total += glyphWidth(char, bold);
  return (total * size) / 1000;
}

/** Quebra o texto em linhas que cabem em `maxWidth` (por palavras; palavra maior que a linha é cortada). */
export function wrapText(text, maxWidth, { size = 10, bold = false } = {}) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, { size, bold }) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      let rest = word;
      while (measureText(rest, { size, bold }) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measureText(rest.slice(0, cut), { size, bold }) > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

/** `#rrggbb` → "r g b" (0–1). */
function rgb(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? ''));
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ');
}

const num = (value) => (Math.round(value * 100) / 100).toString();

/** Data/hora no formato do PDF (`D:AAAAMMDDHHmmSSZ`, UTC). */
const pdfDate = (date) => `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

/** Título/autor em UTF-16BE hexadecimal (aceita qualquer caractere). */
function utf16Hex(text) {
  let out = 'FEFF';
  for (let i = 0; i < text.length; i += 1) out += text.charCodeAt(i).toString(16).padStart(4, '0');
  return out;
}

export const PAGE_A4 = Object.freeze({ width: 595.28, height: 841.89 });

export class PdfDocument {
  /** @param {{ title?: string, author?: string, creator?: string, width?: number, height?: number, now?: Date }} [options] */
  constructor({ title = '', author = '', creator = 'Vault Finance', width = PAGE_A4.width, height = PAGE_A4.height, now = new Date() } = {}) {
    this.meta = { title, author, creator, now };
    this.width = width;
    this.height = height;
    this.pages = [];
    this.current = -1;
  }

  get pageCount() { return this.pages.length; }

  /** Cria uma página em branco e a torna a atual. Retorna o índice (0…). */
  addPage() {
    this.pages.push([]);
    this.current = this.pages.length - 1;
    return this.current;
  }

  /** Torna a página `index` a atual (para desenhar rodapés depois de saber o total de páginas). */
  setPage(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) throw new RangeError('Página inexistente.');
    this.current = index;
  }

  measure(text, options) { return measureText(text, options); }

  wrap(text, maxWidth, options) { return wrapText(text, maxWidth, options); }

  #ops() {
    if (this.current < 0) this.addPage();
    return this.pages[this.current];
  }

  /** Texto numa linha. `align`: left | right | center (em relação a `x`). */
  text(text, x, y, { size = 10, bold = false, color = '#000000', align = 'left' } = {}) {
    const value = String(text ?? '');
    if (!value) return;
    const width = measureText(value, { size, bold });
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    this.#ops().push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf 1 0 0 1 ${num(left)} ${num(this.height - y)} Tm <${toHex(value)}> Tj ET`);
  }

  /** Linha reta. */
  line(x1, y1, x2, y2, { width = 0.5, color = '#000000' } = {}) {
    this.#ops().push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }

  /** Retângulo (canto superior esquerdo em x,y). `fill` e/ou `stroke`. */
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    if (!fill && !stroke) return;
    const parts = [];
    if (fill) parts.push(`${rgb(fill)} rg`);
    if (stroke) parts.push(`${rgb(stroke)} RG ${num(lineWidth)} w`);
    parts.push(`${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    this.#ops().push(parts.join(' '));
  }

  /** Serializa o documento (PDF 1.4). Sem páginas, cria uma em branco. */
  toBytes() {
    if (!this.pages.length) this.addPage();
    const pageObj = (i) => 6 + i * 2;
    const objects = new Map();
    objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    objects.set(2, `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const { title, author, creator, now } = this.meta;
    objects.set(5, `<< /Title <${utf16Hex(title)}> /Author <${utf16Hex(author)}> /Creator <${utf16Hex(creator)}> /Producer <${utf16Hex('Vault Finance')}> /CreationDate (${pdfDate(now)}) >>`);
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      objects.set(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`);
      objects.set(pageObj(i) + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });

    const parts = [Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)]; // %PDF-1.4 + comentário binário
    let offset = parts[0].length;
    const offsets = [];
    const total = 5 + this.pages.length * 2;
    for (let id = 1; id <= total; id += 1) {
      offsets[id] = offset;
      const bytes = encoder.encode(`${id} 0 obj\n${objects.get(id)}\nendobj\n`);
      parts.push(bytes);
      offset += bytes.length;
    }
    const xref = [`xref\n0 ${total + 1}\n0000000000 65535 f \n`];
    for (let id = 1; id <= total; id += 1) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
    parts.push(encoder.encode(xref.join('')));

    const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let pos = 0;
    for (const part of parts) { out.set(part, pos); pos += part.length; }
    return out;
  }
}
