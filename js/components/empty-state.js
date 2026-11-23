/** Estado vazio informativo reutilizável (sem botão sem implementação). */
import { el } from './dom.js';

export function createEmptyState({ icon = 'inbox', title, text, phase = 'Fase 3' }) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon' }, [
      el('i', { 'data-lucide': icon, 'aria-hidden': 'true' }),
    ]),
    el('p', { class: 'empty__title', text: title }),
    el('p', { class: 'empty__text', text }),
    el('span', { class: 'badge', text: `Em implementação — ${phase}` }),
  ]);
}
