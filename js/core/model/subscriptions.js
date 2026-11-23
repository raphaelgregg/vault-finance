/**
 * Assinaturas — cálculos puros (valores anuais/mensais, resumo, próxima cobrança).
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */
import { parseIsoDate } from '../../utils/dates.js';

/** Cobranças por ano de cada periodicidade (semana = 52, mês = 12). */
const CHARGES_PER_YEAR = Object.freeze({ weekly: 52, monthly: 12, yearly: 1 });

/** Custo anual em centavos inteiros (valor × cobranças por ano). */
export function subscriptionAnnualCents(amountCents, periodicity) {
  const perYear = CHARGES_PER_YEAR[periodicity];
  const amount = Number(amountCents);
  if (!perYear || !Number.isInteger(amount)) return 0;
  return amount * perYear;
}

/** Equivalente mensal em centavos inteiros (anual ÷ 12, arredondado). */
export function subscriptionMonthlyCents(amountCents, periodicity) {
  return Math.round(subscriptionAnnualCents(amountCents, periodicity) / 12);
}

/**
 * Totais das assinaturas ATIVAS: pausadas e canceladas não entram.
 * Retorna { activeCount, monthlyCents, annualCents }. A projeção anual soma os
 * valores anuais exatos (não monthlyCents × 12), evitando acumular arredondamento.
 */
export function summarizeSubscriptions(items = []) {
  let activeCount = 0;
  let annualCents = 0;
  for (const item of items) {
    if (item?.status !== 'active') continue;
    activeCount += 1;
    annualCents += subscriptionAnnualCents(item.amountCents, item.periodicity);
  }
  return { activeCount, monthlyCents: Math.round(annualCents / 12), annualCents };
}

/**
 * Próxima data de cobrança a partir de "YYYY-MM-DD" (puro, UTC, meio-dia).
 * weekly +7 dias; monthly/yearly mantêm o dia e fazem clamp ao último dia do mês
 * destino (31/01 → 28/02; 29/02 → 28/02). O clamp não "lembra" o dia original
 * (31/01 → 28/02 → 28/03). Retorna null para data/periodicidade inválidas.
 */
export function advanceChargeDate(isoDate, periodicity) {
  const base = parseIsoDate(isoDate);
  if (!base || !CHARGES_PER_YEAR[periodicity]) return null;
  if (periodicity === 'weekly') {
    return new Date(base.getTime() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const months = periodicity === 'monthly' ? 1 : 12;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
  const day = Math.min(base.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, day, 12)).toISOString().slice(0, 10);
}
