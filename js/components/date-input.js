/**
 * Campos de data em DD/MM/AAAA (e MM/AAAA), independentes do idioma do navegador.
 * - `brDateInput(props)` / `brMonthInput(props)`: mesmo contrato de `el('input', props)`; o campo é TEXTO com máscara e
 *   `.value` continua sendo ISO (AAAA-MM-DD / AAAA-MM) — leitura E escrita —, então os módulos não mudam de lógica.
 * - `FormData(form)` também traz ISO: o evento `formdata` troca o texto pelo ISO (texto inválido segue como digitado para o
 *   modelo apontar "Data inválida").
 * - `startDateInputs()`: máscara ao digitar e botão de calendário (seletor NATIVO escondido, só para escolher o dia).
 */
import { el } from './dom.js';
import { isoToBr, monthIsoToBr, brToIso, brToMonthIso, maskDateText } from '../utils/dateText.js';

const KINDS = {
  date: { toIso: brToIso, toBr: isoToBr, placeholder: 'DD/MM/AAAA', maxlength: 10, picker: 'date' },
  month: { toIso: brToMonthIso, toBr: monthIsoToBr, placeholder: 'MM/AAAA', maxlength: 7, picker: 'month' },
};

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function build(kind, props = {}) {
  const spec = KINDS[kind];
  const { value, ...rest } = props;
  const input = el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: spec.placeholder, maxlength: spec.maxlength, 'data-br-date': kind, ...rest,
  });
  // `.value` (JS) = ISO ('' se vazio/incompleto/inválido); escrever aceita ISO ou DD/MM/AAAA e mostra em formato brasileiro.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return spec.toIso(nativeValue.get.call(input)) ?? ''; },
    set(next) { nativeValue.set.call(input, spec.toBr(next)); },
  });
  if (value) input.value = value;
  return input;
}

export const brDateInput = (props) => build('date', props);
export const brMonthInput = (props) => build('month', props);

const textOf = (input) => nativeValue.get.call(input);

function enhance(input) {
  if (input.dataset.brEnhanced || input.readOnly) { input.dataset.brEnhanced = '1'; return; }
  input.dataset.brEnhanced = '1';
  const kind = input.dataset.brDate;
  const spec = KINDS[kind];
  const wrap = el('span', { class: 'date-wrap' });
  const picker = el('input', { type: spec.picker, class: 'date-wrap__native', tabindex: '-1', 'aria-hidden': 'true' });
  const button = el('button', { type: 'button', class: 'date-wrap__btn', 'aria-label': kind === 'month' ? 'Escolher mês no calendário' : 'Escolher data no calendário' });
  button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
  button.addEventListener('click', () => {
    if (input.disabled) return;
    picker.value = input.value;
    try { picker.showPicker(); } catch { picker.focus(); }
  });
  picker.addEventListener('change', () => {
    if (!picker.value) return;
    input.value = picker.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  input.replaceWith(wrap);
  wrap.append(input, button, picker);
  const sync = () => { button.disabled = input.disabled; };
  sync();
  new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled'] });
}

let started = false;
export function startDateInputs() {
  if (started || typeof document === 'undefined') return;
  started = true;
  // Máscara: só reformata quando o cursor está no fim (digitação normal); colar/editar no meio não pula o cursor.
  document.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.brDate) return;
    const text = textOf(input);
    const masked = maskDateText(text, input.dataset.brDate);
    if (masked !== text && input.selectionStart === text.length) nativeValue.set.call(input, masked);
    input.setCustomValidity(text && !KINDS[input.dataset.brDate].toIso(masked) && masked.length >= KINDS[input.dataset.brDate].maxlength
      ? `Data inválida. Use ${KINDS[input.dataset.brDate].placeholder}.` : '');
  });
  // new FormData(form): ISO no lugar do texto (inválido segue como digitado → o modelo responde "Data inválida").
  document.addEventListener('formdata', (event) => {
    for (const input of event.target.querySelectorAll?.('input[data-br-date][name]') ?? []) {
      const raw = textOf(input);
      event.formData.set(input.name, raw.trim() === '' ? '' : (input.value || raw.trim()));
    }
  });
  const run = () => document.querySelectorAll('input[data-br-date]:not([data-br-enhanced])').forEach(enhance);
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  run();
}
