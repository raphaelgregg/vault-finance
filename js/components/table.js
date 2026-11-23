/**
 * Tabela genérica com estado vazio informativo.
 * columns: [{ key, label, numeric }], rows: [{ id, ... }]
 */
import { el } from './dom.js';

export function createTable({ columns, rows = [], emptyTitle, emptyText, emptyIcon = 'inbox' }) {
  if (!rows.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [
        el('i', { 'data-lucide': emptyIcon, 'aria-hidden': 'true' }),
      ]),
      el('p', { class: 'empty__title', text: emptyTitle ?? 'Nada por aqui ainda' }),
      el('p', { class: 'empty__text', text: emptyText ?? '' }),
    ]);
  }

  const head = el('tr', {}, columns.map((column) =>
    el('th', { class: column.numeric ? 'num' : '', text: column.label })
  ));

  const body = rows.map((row) =>
    el('tr', {}, columns.map((column) =>
      el('td', {
        class: column.numeric ? 'num' : '',
        text: row[column.key] ?? '—',
      })
    ))
  );

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [head]),
      el('tbody', {}, body),
    ]),
  ]);
}
