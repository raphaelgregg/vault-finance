/** Card de estatística dos módulos de movimentação (bancos, receitas, despesas, transferências). */
import { el } from './dom.js';

export function createStatCard(label, value, icon, tone, hint) {
  return el('article', { class: `card${tone ? ` card--${tone}` : ''}` }, [
    el('div', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
    el('div', { class: 'card__content' }, [
      el('p', { class: 'card__label', text: label }),
      el('p', { class: 'card__value', text: value }),
    ]),
    hint ? el('p', { class: 'card__hint', text: hint }) : null,
  ]);
}
