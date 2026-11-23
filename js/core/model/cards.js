/**
 * Cartões, faturas e parcelamento — cálculos puros (datas de fatura, limite usado, divisão de parcelas).
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */
import { isValidIsoDate } from './validation.js';

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" + n meses → "YYYY-MM" (n pode ser negativo); null se inválido. */
export function addMonths(month, n) {
  const m = MONTH_KEY.exec(month ?? '');
  if (!m || !Number.isInteger(n)) return null;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Dia `day` do mês "YYYY-MM" com clamp ao último dia (31 em fevereiro → 28/29). */
export function clampDayInMonth(month, day) {
  const m = MONTH_KEY.exec(month ?? '');
  if (!m || !Number.isInteger(day) || day < 1) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0, 12)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Fechamento e vencimento da fatura do mês de referência. Vence no mesmo mês se
 * dueDay > closingDay; senão, no mês seguinte.
 */
export function invoiceDatesFor(card, referenceMonth) {
  const closingDate = clampDayInMonth(referenceMonth, Number(card?.closingDay));
  const dueMonth = Number(card?.dueDay) > Number(card?.closingDay) ? referenceMonth : addMonths(referenceMonth, 1);
  const dueDate = clampDayInMonth(dueMonth, Number(card?.dueDay));
  return closingDate && dueDate ? { closingDate, dueDate } : null;
}

/** Mês da fatura que recebe uma compra: após o fechamento do mês, vai para o seguinte. */
export function invoiceMonthForPurchase(card, purchaseDate) {
  if (!isValidIsoDate(purchaseDate)) return null;
  const month = purchaseDate.slice(0, 7);
  const closing = clampDayInMonth(month, Number(card?.closingDay));
  if (!closing) return null;
  return purchaseDate > closing ? addMonths(month, 1) : month;
}

/** Divide o total em n parcelas inteiras; o resto vai para a primeira. null se total < n. */
export function splitInstallments(totalCents, n) {
  if (!Number.isInteger(totalCents) || !Number.isInteger(n) || n < 1 || totalCents < n) return null;
  const base = Math.floor(totalCents / n);
  const parts = Array(n).fill(base);
  parts[0] += totalCents - base * n;
  return parts;
}

/**
 * Limite usado = compras de faturas ainda não pagas/canceladas (ou sem fatura).
 * Retorna { usedCents, availableCents } (disponível nunca negativo). Derivado, não gravado.
 */
export function cardLimitUsage(card, purchases = [], invoices = []) {
  const settled = new Set(invoices.filter((i) => i.status === 'paid' || i.status === 'cancelled').map((i) => i.id));
  const usedCents = purchases.reduce(
    (total, p) => (p.invoiceId && settled.has(p.invoiceId) ? total : total + (Number(p.amountCents) || 0)), 0);
  return { usedCents, availableCents: Math.max(0, (Number(card?.limitCents) || 0) - usedCents) };
}

/** Total derivado de uma fatura aberta (soma das parcelas vinculadas). */
export function invoiceTotalCents(purchases = []) {
  return purchases.reduce((total, p) => total + (Number(p?.amountCents) || 0), 0);
}
