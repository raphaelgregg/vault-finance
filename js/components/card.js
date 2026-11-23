/** Card de indicador (sem cálculo nesta fase — valores são "—"). */
import { el } from './dom.js';

export function createCard({ label, value = '—', hint, icon = 'circle', tone }) {
  const valueClass = tone ? `card__value card__value--${tone}` : 'card__value';
  return el('article', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('span', { class: 'card__icon' }, [
        el('i', { 'data-lucide': icon, 'aria-hidden': 'true' }),
      ]),
      el('span', { text: label }),
    ]),
    el('div', { class: valueClass, text: value }),
    hint ? el('div', { class: 'card__hint', text: hint }) : null,
  ]);
}
