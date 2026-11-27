/**
 * Resumo do mês selecionado nas listas de Receitas e Despesas (VF-UX-01).
 * Recebe o resumo já calculado (`summarizeMovements`) sobre TODOS os lançamentos do mês, não só a página carregada.
 */
import { el } from './dom.js';
import { createStatCard } from './stat-card.js';
import { formatCents } from '../core/model.js';
import { monthLabel } from '../core/debtorReport.js';

/**
 * @param {{ month: string, summary: object|null, truncated?: boolean, failed?: boolean,
 *   labels: { total: string, settled: string, pending: string, settledIcon: string, tone: 'income'|'expense' } }} options
 */
export function createMonthSummary({ month, summary, truncated = false, failed = false, labels }) {
  const title = `Resumo de ${monthLabel(month)}`;
  if (failed) return el('p', { class: 'notice', role: 'alert', id: 'month-summary', text: `${title}: não foi possível carregar o resumo do mês.` });
  if (!summary) return el('p', { class: 'card__hint', role: 'status', id: 'month-summary', text: `${title}: carregando…` });
  const count = `${summary.count} lançamento${summary.count === 1 ? '' : 's'}${summary.cancelledCount ? ` (+${summary.cancelledCount} cancelado${summary.cancelledCount === 1 ? '' : 's'}, fora dos totais)` : ''}`;
  return el('section', { class: 'panel', id: 'month-summary', 'aria-label': title }, [
    el('div', { class: 'panel__header' }, [el('div', {}, [el('h2', { text: title }), el('p', { class: 'card__hint', text: count })])]),
    truncated ? el('p', { class: 'notice', role: 'status', text: 'O mês tem mais de 1000 lançamentos: os totais podem estar incompletos.' }) : null,
    el('div', { class: 'panel__body' }, [el('div', { class: 'grid grid--cards' }, [
      createStatCard(labels.total, formatCents(summary.totalCents), 'sigma', null, `${labels.settled} + ${labels.pending.toLowerCase()}`),
      createStatCard(labels.settled, formatCents(summary.settledCents), labels.settledIcon, labels.tone, 'Já liquidado'),
      createStatCard(labels.pending, formatCents(summary.pendingCents), 'calendar-clock', null,
        summary.overdueCents > 0 ? `Inclui ${formatCents(summary.overdueCents)} em atraso` : 'Ainda não liquidado'),
    ])]),
  ]);
}

/** Meses oferecidos no filtro: os dos dados carregados + mês atual + próximos `ahead` + o selecionado; mais recente primeiro. Puro. */
export function monthChoices(loaded, { current, selected = null, ahead = 6 } = {}) {
  const set = new Set([...loaded].filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m)));
  if (current) {
    let [y, m] = current.split('-').map(Number);
    for (let i = 0; i <= ahead; i += 1) {
      set.add(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  if (selected) set.add(selected);
  return [...set].sort().reverse();
}
