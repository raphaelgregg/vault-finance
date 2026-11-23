/**
 * Orçamentos — VF-2-03e. Limite por categoria/mês; gasto, restante e % são derivados
 * (despesas não canceladas pelo mês de vencimento). Só o limite é gravado.
 */
import { el, toast, refreshIcons } from '../components/dom.js';
import {
  field, iconButton, statCard, panelHeader, emptyBlock, dataTable, progressBar,
  confirmModal, formModal, formatCentsInput, formatMonth, selectOptions,
  mount,
} from '../components/form-kit.js';
import { listCategories } from '../services/categories.js';
import {
  createBudget, updateBudgetLimit, deleteBudget, getBudgetProgress, formatCents,
} from '../services/budgets.js';
import { currentMonthKey } from '../utils/dates.js';

export const meta = { title: 'Orçamentos', icon: 'gauge' };

const STATE_LABELS = { ok: 'Dentro do limite', warning: 'Atenção', over: 'Estourado' };

let user = null;
let container = null;
let month = currentMonthKey();
let categories = [];
let progress = { rows: [], summary: { limitCents: 0, spentCents: 0, overCount: 0, warningCount: 0 }, truncated: false };

export async function render(target, ctx) {
  user = ctx.user;
  container = target;
  month = currentMonthKey(new Date());
  categories = await listCategories(user.uid);
  await reload();
}

async function reload() {
  progress = await getBudgetProgress(user.uid, month);
  renderPage();
}

const categoryName = (id) => categories.find((c) => c.id === id)?.name ?? '(categoria removida)';

function renderPage() {
  const { rows, summary } = progress;
  const header = panelHeader({
    icon: 'gauge', title: 'Orçamentos', hint: 'Limite de gasto por categoria e mês; o gasto vem das despesas lançadas.',
    actionLabel: 'Novo orçamento', onAction: () => openBudgetModal(),
  });

  const monthInput = el('input', { type: 'month', id: 'budget-month', value: month, 'aria-label': 'Mês do orçamento' });
  monthInput.addEventListener('change', async () => {
    if (!/^\d{4}-\d{2}$/.test(monthInput.value)) return;
    month = monthInput.value;
    await reload();
  });
  const toolbar = el('div', { class: 'toolbar' }, [field('Mês', 'budget-month', monthInput)]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard('Orçado', formatCents(summary.limitCents), 'gauge', `${rows.length} categoria(s) em ${formatMonth(month)}`),
    statCard('Gasto', formatCents(summary.spentCents), 'trending-down', 'Despesas não canceladas das categorias orçadas', 'expense'),
    statCard('Estourados', String(summary.overCount), 'alert-triangle', `${summary.warningCount} em atenção (≥ 80%)`),
  ]);

  const columns = [
    { key: 'categoryId', label: 'Categoria', render: (v) => categoryName(v) },
    { key: 'limitCents', label: 'Limite', numeric: true, render: (v) => formatCents(v) },
    { key: 'spentCents', label: 'Gasto', numeric: true, render: (v) => formatCents(v) },
    { key: 'remainingCents', label: 'Restante', numeric: true, render: (v) => formatCents(v) },
    { key: 'percent', label: 'Uso', numeric: true, render: (v) => `${v}%` },
    { key: 'state', label: 'Situação', render: (v) => STATE_LABELS[v] ?? v },
  ];
  const table = rows.length
    ? el('div', {}, [
      dataTable({
        columns, rows,
        actions: (item) => [
          iconButton(`Editar limite de ${categoryName(item.categoryId)}`, 'edit-2', () => openBudgetModal(item)),
          iconButton(`Excluir orçamento de ${categoryName(item.categoryId)}`, 'trash-2', () => confirmDelete(item), 'btn--danger'),
        ],
      }),
      el('div', { class: 'panel__body' }, rows.map((r) => el('div', { class: 'bar-row' }, [
        el('span', { class: 'bar-row__label', text: categoryName(r.categoryId) }),
        progressBar(r.percent, r.state, `Uso do orçamento de ${categoryName(r.categoryId)}: ${r.percent}%`),
        el('span', { class: 'bar-row__value', text: `${r.percent}%` }),
      ]))),
    ])
    : emptyBlock('gauge', 'Nenhum orçamento neste mês', 'Defina um limite para uma categoria de despesa e acompanhe o consumo.');

  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: `Orçamentos de ${formatMonth(month)}` })]),
    el('div', { class: 'panel__body panel__body--flush' }, [table]),
  ]);

  const notice = progress.truncated
    ? el('p', { class: 'notice', role: 'status', text: 'Há mais despesas no mês do que o limite de leitura; o gasto pode estar subestimado.' })
    : null;
  mount(container, header, toolbar, cards, notice, panel);
  refreshIcons();
}

function openBudgetModal(item = null) {
  const isEdit = !!item;
  const expenseCategories = categories
    .filter((c) => c.kind === 'expense' || c.kind === 'both')
    .map((c) => ({ value: c.id, label: c.name }));
  const fields = [
    isEdit
      ? el('p', { class: 'card__hint', text: `${categoryName(item.categoryId)} — ${formatMonth(item.month)} (categoria e mês não são editáveis)` })
      : field('Categoria *', 'categoryId', el('select', { id: 'categoryId', name: 'categoryId', required: true },
        selectOptions(expenseCategories, '', { placeholder: 'Selecione uma categoria' }))),
    field('Limite (R$) *', 'limitCents', el('input', {
      type: 'text', id: 'limitCents', name: 'limitCents', required: true, placeholder: '0,00', autocomplete: 'off',
      value: item ? formatCentsInput(item.limitCents) : '',
    })),
  ];
  formModal({
    title: isEdit ? 'Editar limite' : `Novo orçamento — ${formatMonth(month)}`,
    formId: 'budget-form',
    fields,
    submitLabel: isEdit ? 'Salvar' : 'Criar orçamento',
    focusId: isEdit ? 'limitCents' : 'categoryId',
    submit: (data) => (isEdit
      ? updateBudgetLimit(user.uid, item.id, data.get('limitCents'))
      : createBudget(user.uid, { categoryId: data.get('categoryId'), month, limitCents: data.get('limitCents') })),
    onDone: async () => { toast(isEdit ? 'Limite atualizado.' : 'Orçamento criado.'); await reload(); },
  });
}

function confirmDelete(item) {
  confirmModal({
    title: 'Excluir orçamento',
    message: `Excluir o orçamento de "${categoryName(item.categoryId)}" em ${formatMonth(item.month)}?`,
    hint: 'As despesas não são afetadas.',
    confirmLabel: 'Excluir',
    onConfirm: async () => {
      const result = await deleteBudget(user.uid, item.id);
      if (result.ok) { toast('Orçamento excluído.'); await reload(); } else toast(result.errors._form, 5000);
    },
  });
}
