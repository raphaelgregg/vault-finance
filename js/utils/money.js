/**
 * Dinheiro SEMPRE em centavos inteiros. Nenhum float em regra financeira.
 *
 * Fonte única de conversão/formatação monetária do app (a implementação paralela e sem uso que existia aqui —
 * toCents/fromCents/formatBRL/isValidCents — foi removida: nenhum arquivo a importava).
 * Puro: sem DOM, sem rede, sem Firebase.
 */

/**
 * Converte entrada do usuário em centavos inteiros.
 * Aceita: 1234 | "1234" | "1234,56" | "1.234,56" | "1234.56" | "R$ 1.234,56".
 * Retorna null quando não é um valor válido.
 */
export function parseMoneyToCents(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.round(input * 100);
  }
  if (typeof input !== 'string') return null;
  let raw = input.trim().replace(/^r\$\s*/i, '').replace(/\s/g, '');
  if (!raw) return null;
  // Formato pt-BR: ponto = milhar, vírgula = decimal.
  if (/,\d{1,2}$/.test(raw)) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else if (raw.includes(',') && !raw.includes('.')) {
    raw = raw.replace(',', '.');
  } else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(raw) || (raw.match(/\./g) ?? []).length > 1) {
    // Só grupos de milhar ("1.234", "12.345", "1.234.567"): o ponto separa milhares, não é decimal — antes
    // "1.234" virava R$ 1,23 e "999.999" virava R$ 1.000,00. ("1.5" e "1234.56" seguem decimais.)
    raw = raw.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Centavos inteiros → string "1234,56" aceita por parseMoneyToCents. Necessário
 * porque o parser trata NÚMEROS como reais (×100): nunca reenvie centavos crus.
 */
export function centsToMoneyString(cents) {
  const value = Number(cents);
  if (!Number.isInteger(value) || value < 0) return null;
  return `${Math.trunc(value / 100)},${String(value % 100).padStart(2, '0')}`;
}

/** Formata centavos para exibição pt-BR: 123456 -> "R$ 1.234,56". */
export function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return '—';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const int = Math.trunc(abs / 100).toLocaleString('pt-BR');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${int},${frac}`;
}
