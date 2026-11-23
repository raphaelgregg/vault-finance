/**
 * Central de validação do sistema (VF-UI-02) — painel INDEPENDENTE de `/manutencao-dados`, só para administradores.
 * Estado e eventos próprios (não compartilha nada com os demais painéis): dois recursos — popular a conta com dados de
 * demonstração e executar a auditoria funcional automatizada — mais a remoção segura dos dados de demonstração.
 */
import { el, toast } from './dom.js';
import { field } from './form-kit.js';
import { callValidation, VALIDATION_CONFIRM } from '../services/validationCenter.js';

/** Monta o painel. `deps.call` é injetável (testes de unidade). Retorna o elemento `<section id="panel-validation">`. */
export function createValidationCenter({ call = callValidation } = {}) {
  let busy = false;
  const log = el('div', { id: 'validation-log', class: 'maint-log', role: 'log', 'aria-live': 'polite' });
  const status = el('p', { id: 'validation-status', class: 'card__hint', role: 'status', text: 'Verificando dados de demonstração…' });
  const results = el('div', { id: 'validation-results' });
  const write = (text, kind = 'info') => { const line = el('div', { class: `maint-log__line maint-log__line--${kind}` }); line.textContent = text; log.append(line); log.scrollTop = log.scrollHeight; };

  const seedPhrase = el('input', { type: 'text', id: 'validation-seed-phrase', autocomplete: 'off', placeholder: `Digite: ${VALIDATION_CONFIRM.seed}` });
  const cleanPhrase = el('input', { type: 'text', id: 'validation-clean-phrase', autocomplete: 'off', placeholder: `Digite: ${VALIDATION_CONFIRM.cleanup}` });
  const seedBtn = el('button', { type: 'button', id: 'btn-validation-seed', class: 'btn btn--primary', text: 'Popular com dados de demonstração' });
  const auditBtn = el('button', { type: 'button', id: 'btn-validation-audit', class: 'btn btn--secondary', text: 'Executar auditoria funcional' });
  const cleanBtn = el('button', { type: 'button', id: 'btn-validation-clean', class: 'btn btn--danger', text: 'Remover dados de demonstração' });
  const buttons = [seedBtn, auditBtn, cleanBtn];

  const refresh = async () => {
    try {
      const s = await call('status');
      status.textContent = s.seeded ? `Dados de demonstração presentes (${s.items} registros${s.seededAt ? `, criados em ${new Date(s.seededAt).toLocaleString('pt-BR')}` : ''}).` : 'Nenhum dado de demonstração na conta.';
      auditBtn.disabled = !s.seeded; cleanBtn.disabled = !s.seeded; seedBtn.disabled = s.seeded;
    } catch (error) { status.textContent = `Não foi possível consultar o estado: ${error.message}`; }
  };

  const guarded = (button, fn) => async () => {
    if (busy) { toast('Aguarde a operação em andamento.'); return; }
    busy = true; buttons.forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (error) { write(`✖ ${error.message}${error.code ? ` (${error.code})` : ''}`, 'error'); } finally { busy = false; await refresh(); }
  };

  seedBtn.addEventListener('click', guarded(seedBtn, async () => {
    if (seedPhrase.value.trim() !== VALIDATION_CONFIRM.seed) { toast(`Confirmação inválida. Digite exatamente: ${VALIDATION_CONFIRM.seed}`, 5000); return; }
    write('Populando a conta com dados de demonstração (IDs demo_*)…');
    const r = await call('seed', { confirm: seedPhrase.value.trim() });
    write(`✔ ${r.created} registros de demonstração criados.`, 'ok');
    seedPhrase.value = '';
  }));

  auditBtn.addEventListener('click', guarded(auditBtn, async () => {
    write('Executando a auditoria funcional sobre a base de demonstração (operações reais do servidor)…');
    const r = await call('audit');
    results.replaceChildren(el('div', { class: 'table-wrap' }, [el('table', { class: 'table', id: 'validation-table' }, [
      el('thead', {}, [el('tr', {}, ['Cenário', 'Resultado', 'Detalhe'].map((t) => el('th', { text: t })))]),
      el('tbody', {}, r.scenarios.map((s) => el('tr', { 'data-scenario': s.id, 'data-ok': String(s.ok) }, [el('td', { text: s.name }), el('td', { text: s.ok ? '✔ passou' : '✖ FALHOU' }), el('td', { text: s.detail })]))),
    ])]));
    write(`Auditoria concluída: ${r.passed} passaram, ${r.failed} falharam; ${r.realRecordsChecked} registros reais conferidos e intactos.`, r.ok ? 'ok' : 'error');
  }));

  cleanBtn.addEventListener('click', guarded(cleanBtn, async () => {
    if (cleanPhrase.value.trim() !== VALIDATION_CONFIRM.cleanup) { toast(`Confirmação inválida. Digite exatamente: ${VALIDATION_CONFIRM.cleanup}`, 5000); return; }
    const r = await call('cleanup', { confirm: cleanPhrase.value.trim() });
    results.replaceChildren();
    write(`✔ ${r.deleted} registros de demonstração removidos (somente os listados no manifesto; nenhum dado real é tocado).`, 'ok');
    cleanPhrase.value = '';
  }));

  const panel = el('section', { class: 'panel', id: 'panel-validation' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Central de validação do sistema' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: 'Somente administradores. Popula SUA conta com dados de demonstração (IDs demo_*, registrados em um manifesto) para validação visual manual e executa a auditoria funcional automatizada sobre eles. A remoção apaga apenas o que o manifesto lista; registros reais nunca são alterados.' }),
      status,
      field('Confirmação para popular *', 'validation-seed-phrase', seedPhrase), seedBtn,
      auditBtn,
      field('Confirmação para remover *', 'validation-clean-phrase', cleanPhrase), cleanBtn,
      results, log,
    ]),
  ]);
  refresh();
  return panel;
}
