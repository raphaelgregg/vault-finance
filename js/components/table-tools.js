/**
 * Ordenação por cabeçalho e filtro de texto para TODAS as tabelas do app (`table.table`) — camada de DOM sobre
 * `utils/tableSort.js`. É um aprimoramento progressivo: `startTableTools()` observa o documento e, sempre que uma tabela
 * nova aparece (página ou modal), acrescenta a barra de filtro e torna os cabeçalhos clicáveis. Nenhum módulo precisa chamar nada.
 *
 * Regras:
 *  - Ordena/filtra as linhas CARREGADAS na tabela (em tabelas paginadas por "Carregar mais", só o que já foi carregado).
 *  - Clique no cabeçalho: crescente → decrescente → ordem original. `aria-sort` reflete o estado.
 *  - Colunas "Ações" e de seleção ("Sel.") não ordenam; o filtro ignora a coluna de ações.
 *  - Tabela com menos de 2 linhas de dados não ganha barra. Opt-out: `data-no-tools` na tabela.
 *  - Linhas com `colspan` (estado vazio) ficam fora. O aviso "nenhuma linha corresponde" fica fora da tabela (não vira linha do tbody).
 */
import { el } from './dom.js';
import { compareCells, detectColumnType, filterIndexes } from '../utils/tableSort.js';

const NO_SORT_LABELS = new Set(['', 'ações', 'acoes', 'sel.', 'sel']);
let started = false;

const dataRows = (tbody) => [...tbody.children].filter((tr) => tr.tagName === 'TR' && !tr.querySelector('td[colspan]'));
const cellText = (td) => (td?.dataset?.sort ?? td?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Aprimora UMA tabela (idempotente). Retorna false quando não se aplica. */
export function enhanceTable(table) {
  if (table.dataset.enhanced || 'noTools' in table.dataset) return false;
  const thead = table.tHead;
  const tbody = table.tBodies[0];
  const headCells = thead?.rows[0] ? [...thead.rows[0].cells] : [];
  if (!tbody || !headCells.length || dataRows(tbody).length < 2) return false;
  table.dataset.enhanced = 'true';

  const state = { column: null, direction: null, query: '' };
  let original = dataRows(tbody);
  let observer = null;

  const label = (th) => th.textContent.trim();
  const isActionColumn = (th) => NO_SORT_LABELS.has(label(th).toLowerCase());
  const textsOf = (tr) => headCells.map((_, i) => cellText(tr.cells[i]));
  const searchableColumns = headCells.map((th) => !isActionColumn(th));

  const sortBtns = headCells.map((th, column) => {
    if (isActionColumn(th)) return null;
    const text = label(th);
    const icon = el('span', { class: 'th-sort__icon', 'aria-hidden': 'true' });
    const btn = el('button', { type: 'button', class: 'th-sort', 'aria-label': `Ordenar por ${text}`, onClick: () => cycle(column) }, [text, icon]);
    th.replaceChildren(btn);
    th.setAttribute('aria-sort', 'none');
    return btn;
  });

  const input = el('input', { type: 'search', class: 'table-filter', placeholder: 'Filtrar…', 'aria-label': 'Filtrar linhas da tabela', autocomplete: 'off' });
  const count = el('span', { class: 'table-count', role: 'status', 'aria-live': 'polite' });
  const toolbar = el('div', { class: 'table-tools' }, [input, count]);
  const holder = table.closest('.table-wrap') ?? table;
  holder.parentNode.insertBefore(toolbar, holder);

  // Aviso FORA da tabela (uma linha extra no tbody contaria como linha de dados para quem lê a tabela).
  const emptyNote = el('p', { class: 'table-empty-note', hidden: true, text: 'Nenhuma linha corresponde ao filtro.' });
  holder.parentNode.insertBefore(emptyNote, holder.nextSibling);

  function apply() {
    const texts = original.map(textsOf);
    const visible = new Set(filterIndexes(texts.map((r) => r.filter((_, i) => searchableColumns[i])), state.query));
    let order = original.map((_, i) => i);
    if (state.column !== null && state.direction) {
      const type = detectColumnType(texts.map((r) => r[state.column]));
      order = order.sort((a, b) => compareCells(texts[a][state.column], texts[b][state.column], type, state.direction) || a - b);
    }
    for (const i of order) tbody.append(original[i]);
    original.forEach((tr, i) => { tr.hidden = !visible.has(i); });
    emptyNote.hidden = visible.size > 0;
    count.textContent = state.query ? `${visible.size} de ${original.length}` : `${original.length} linhas`;
    headCells.forEach((th, column) => {
      if (!sortBtns[column]) return;
      const active = state.column === column && state.direction;
      th.setAttribute('aria-sort', active ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      sortBtns[column].dataset.direction = active ? state.direction : '';
    });
    // As reordenações acima são NOSSAS: descarta os registros delas para o observador não reaplicar em laço.
    observer?.takeRecords();
  }

  function cycle(column) {
    if (state.column !== column) { state.column = column; state.direction = 'asc'; }
    else if (state.direction === 'asc') state.direction = 'desc';
    else { state.column = null; state.direction = null; }
    apply();
  }

  input.addEventListener('input', () => { state.query = input.value; apply(); });
  apply();

  // Linhas acrescentadas/trocadas depois (ex.: "Carregar mais"): recompõe a lista e reaplica filtro/ordem.
  observer = new MutationObserver(() => {
    original = dataRows(tbody);
    if (original.length) apply();
  });
  observer.observe(tbody, { childList: true });
  return true;
}

/** Aprimora todas as tabelas dentro de `root`. */
export function enhanceTables(root = document) {
  root.querySelectorAll('table.table').forEach((table) => enhanceTable(table));
}

/** Liga o aprimoramento automático (uma vez por página): tabelas existentes e as que aparecerem depois (renders, modais). */
export function startTableTools() {
  if (started || typeof document === 'undefined') return;
  started = true;
  let scheduled = false;
  const run = () => { scheduled = false; enhanceTables(document); };
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
  enhanceTables(document);
}
