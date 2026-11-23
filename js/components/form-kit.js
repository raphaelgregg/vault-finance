/**
 * Kit de UI para módulos de formulário/tabela (sem regra financeira nem rede).
 * Usado pelos módulos novos (orçamentos, cartões, metas, parcelas); módulos antigos
 * mantêm suas cópias locais (sem refatoração oportunista).
 */
import { el, $, $$, toast } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { describeError } from '../utils/errors.js';
import { todayInAppZone } from '../utils/dates.js';

export function field(label, id, control) {
  return el('div', { class: 'form__field' }, [
    el('label', { for: id, text: label }),
    control,
    el('span', { class: 'form__error', 'data-for': id }),
  ]);
}

export function iconButton(label, icon, onClick, extraClass = '') {
  return el('button', {
    type: 'button',
    class: `btn btn--icon ${extraClass}`.trim(),
    'aria-label': label,
    title: label,
    onClick,
    html: `<i data-lucide="${icon}" aria-hidden="true"></i>`,
  });
}

export function statCard(label, value, icon, hint, tone) {
  return el('article', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
      el('span', { text: label }),
    ]),
    el('div', { class: tone ? `card__value card__value--${tone}` : 'card__value', text: value }),
    hint ? el('p', { class: 'card__hint', text: hint }) : null,
  ]);
}

export function panelHeader({ icon, title, hint, actionLabel, onAction }) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
      el('div', {}, [el('h2', { text: title }), hint ? el('p', { class: 'card__hint', text: hint }) : null]),
      el('div', { class: 'topbar__spacer' }),
      actionLabel
        ? el('button', {
          type: 'button',
          class: 'btn btn--primary',
          onClick: onAction,
          html: `<i data-lucide="plus" aria-hidden="true"></i> ${actionLabel}`,
        })
        : null,
    ]),
  ]);
}

export function emptyBlock(icon, title, text) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
    el('p', { class: 'empty__title', text: title }),
    el('p', { class: 'empty__text', text }),
  ]);
}

/** Célula: `render` pode devolver texto ou um nó DOM (ex.: barra de progresso). */
function cell(column, item) {
  const value = column.render ? column.render(item[column.key], item) : (item[column.key] ?? '—');
  const td = el('td', { class: [column.numeric ? 'num' : '', column.wrap ? 'wrap' : ''].filter(Boolean).join(' ') });
  if (value instanceof Node) td.append(value);
  else td.textContent = value;
  return td;
}

/**
 * Tabela com render por coluna e coluna de ações opcional (`actions(item) → nós`).
 * `compact`: densidade menor (modais largos). Coluna `wrap: true`: o texto pode quebrar linha (descrições longas).
 */
export function dataTable({ columns, rows, actions, compact = false }) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: compact ? 'table table--compact' : 'table' }, [
      el('thead', {}, [el('tr', {}, [
        ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
        actions ? el('th', { text: 'Ações' }) : null,
      ])]),
      el('tbody', {}, rows.map((item) => el('tr', {}, [
        ...columns.map((c) => cell(c, item)),
        actions ? el('td', { class: 'actions' }, actions(item)) : null,
      ]))),
    ]),
  ]);
}

/** Barra de progresso acessível; `percent` pode passar de 100 (a barra trava em 100). */
export function progressBar(percent, state = 'ok', label = '') {
  const width = Math.max(0, Math.min(100, percent));
  return el('div', {
    class: `progress progress--${state}`,
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(width),
    'aria-label': label || 'Progresso',
  }, [el('div', { class: 'progress__bar', style: `width:${width}%` })]);
}

export function confirmModal({ title, message, hint, confirmLabel, onConfirm, danger = true }) {
  const body = el('div', {}, [el('p', { text: message }), hint ? el('p', { class: 'card__hint', text: hint }) : null]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Voltar' }),
    el('button', {
      type: 'button',
      class: danger ? 'btn btn--danger' : 'btn btn--primary',
      text: confirmLabel,
      onClick: async () => { closeModal(); await onConfirm(); },
    }),
  ];
  openModal({ title, body, footer });
}

export function clearErrors(form) {
  $$('.form__error', form).forEach((node) => { node.textContent = ''; });
  $$('.form__field', form).forEach((node) => node.classList.remove('form__field--error'));
}

/** Mostra erros por campo (`.form__error[data-for]`); `_form` vira alerta no próprio formulário. */
export function showErrors(form, errors) {
  for (const [name, message] of Object.entries(errors)) {
    if (name === '_form') continue;
    const errorEl = $(`.form__error[data-for="${name}"]`, form);
    if (errorEl) {
      errorEl.textContent = message;
      $(`#${name}`, form)?.closest('.form__field')?.classList.add('form__field--error');
    }
  }
  if (errors._form) {
    let holder = $('.form__error[data-for="_form"]', form);
    if (!holder) {
      holder = el('p', { class: 'form__error', role: 'alert', 'data-for': '_form' });
      form.append(holder);
    }
    holder.textContent = errors._form;
  }
}

/** Variante dos módulos de movimentação: erros por campo + `_form` em toast (comportamento original). */
export function showFormErrors(form, errors) {
  for (const [name, message] of Object.entries(errors)) {
    const errorEl = $(`.form__error[data-for="${name}"]`, form);
    if (errorEl) errorEl.textContent = message;
    $(`#${name}`, form)?.closest('.form__field')?.classList.add('form__field--error');
  }
  if (errors._form) toast(errors._form, 5000);
}

/**
 * Modal de formulário padrão: trata submit com desabilitação do botão e erros por campo.
 * `submit(formData) → { ok, errors? }`; em sucesso fecha e chama `onDone`.
 */
export function formModal({ title, formId, fields, submitLabel, submit, onDone, focusId }) {
  const form = el('form', { id: formId, novalidate: true }, fields);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: submitLabel }),
  ];
  const modal = openModal({ title, body: form, footer });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    clearErrors(form);
    try {
      const result = await submit(new FormData(form));
      if (result.ok) {
        closeModal();
        await onDone?.(result);
      } else {
        showErrors(form, result.errors ?? {});
      }
    } catch (error) {
      // Falhas assíncronas (ex.: FirebaseError permission-denied) viram mensagem no formulário.
      console.error('[form] falha ao enviar', error);
      const message = describeError(error);
      showErrors(form, { _form: message });
      if (!form.isConnected) toast(message, 6000); // falha após o fechamento (ex.: recarga)
    } finally {
      button.disabled = false;
    }
  });
  if (focusId) $(`#${focusId}`, form)?.focus();
  return modal;
}

export function formatCentsInput(cents) {
  const n = Number(cents);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export function formatDate(value) {
  if (!value || typeof value !== 'string') return '—';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

export function formatMonth(value) {
  if (!value || typeof value !== 'string') return '—';
  const [y, m] = value.split('-');
  return `${m}/${y}`;
}

export function optionLabel(options, value) {
  return options.find((o) => o.value === value)?.label ?? value ?? '—';
}

export function selectOptions(items, selectedValue, { placeholder } = {}) {
  return [
    placeholder ? el('option', { value: '', disabled: true, selected: !selectedValue }, placeholder) : null,
    ...items.map((o) => el('option', { value: o.value, selected: o.value === selectedValue }, o.label)),
  ];
}

/** Hoje em "YYYY-MM-DD" no fuso America/Sao_Paulo (datas só-dia; ver utils/dates.js). */
export const todayIso = () => todayInAppZone();

/** replaceChildren ignorando nulos (replaceChildren(null) inseriria o texto "null"). */
export function mount(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean));
}
