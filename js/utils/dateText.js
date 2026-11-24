/**
 * Texto de data no formato brasileiro (DD/MM/AAAA e MM/AAAA) ⇄ ISO (AAAA-MM-DD e AAAA-MM). Puro: sem DOM nem rede.
 * Os campos de data da interface são texto com máscara (o `<input type=date>` nativo segue o idioma do NAVEGADOR e mostra
 * mm/dd/aaaa em navegador em inglês); o VALOR usado pelo app continua ISO, então services, Rules e dados não mudam.
 */
import { parseIsoDate } from './dates.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "AAAA-MM-DD" → "DD/MM/AAAA"; outro texto volta como veio (vazio → ""). */
export function isoToBr(value) {
  const text = String(value ?? '');
  if (!ISO_DATE.test(text)) return text;
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

/** "AAAA-MM" → "MM/AAAA"; outro texto volta como veio. */
export function monthIsoToBr(value) {
  const text = String(value ?? '');
  if (!ISO_MONTH.test(text)) return text;
  const [y, m] = text.split('-');
  return `${m}/${y}`;
}

/** "DD/MM/AAAA" (ou já ISO) → "AAAA-MM-DD" de calendário real; senão null. */
export function brToIso(text) {
  const value = String(text ?? '').trim();
  if (ISO_DATE.test(value)) return parseIsoDate(value) ? value : null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return parseIsoDate(iso) ? iso : null;
}

/** "MM/AAAA" (ou já "AAAA-MM") → "AAAA-MM"; senão null. */
export function brToMonthIso(text) {
  const value = String(text ?? '').trim();
  if (ISO_MONTH.test(value)) return value;
  const m = /^(\d{1,2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const iso = `${m[2]}-${m[1].padStart(2, '0')}`;
  return ISO_MONTH.test(iso) ? iso : null;
}

/**
 * Máscara enquanto digita: só dígitos e "/" são reformatados ("12032026" → "12/03/2026"; "0326" no modo mês → "03/26");
 * texto com qualquer outro caractere (ex.: ISO "2026-03-12" colado) não é alterado. `kind`: 'date' | 'month'.
 */
export function maskDateText(text, kind = 'date') {
  const raw = String(text ?? '');
  if (!/^[\d/]*$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '').slice(0, kind === 'month' ? 6 : 8);
  if (kind === 'month') return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  if (digits.length <= 2) return digits;
  return digits.length <= 4 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
