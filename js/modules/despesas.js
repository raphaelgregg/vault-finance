/**
 * Despesas — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista despesas com filtros
 * - Modal para criar/editar despesa
 * - Ações: marcar como paga, cancelar
 * - Validação client-side espelhando Security Rules
 * - Persistência em users/{uid}/expenses
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import { createStatCard } from '../components/stat-card.js';
import { formatCentsInput, formatDate, clearErrors, showFormErrors as showErrors } from '../components/form-kit.js';
import { filterMovements, accountLabel } from '../core/model.js';
import {
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  markExpensePaid,
  cancelExpense,
  getRecurrenceOptions,
  getExpenseStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/expenses.js';
import { createPager } from '../services/pager.js';
import { createPagerFooter } from '../components/pager-footer.js';
import { listCategories, categoryLabel } from '../services/categories.js';
import { listAccounts } from '../services/accounts.js';

import { todayInAppZone, currentMonthKey } from '../utils/dates.js';
import { newOperationId } from '../services/financeApi.js';
import { openReversalModal } from '../components/reversal-modal.js';
export const meta = { title: 'Despesas', icon: 'trending-down' };

let currentUser = null;
let expensesCache = [];
let pager = null;
let categoriesCache = [];
let accountsCache = [];
let currentFilter = { status: 'all', month: null, categoryId: null };

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  await loadData();
  renderPage(container);
}

/** Carrega dados iniciais. */
async function loadData() {
  // Paginação por cursor (VF-4-03): busca as mais recentes (vencimento desc) e exibe em ordem
  // crescente de vencimento, como antes; "Carregar mais antigas" no rodapé.
  pager = createPager({
    fetchPage: ({ limit, startAfterId }) => listExpenses(currentUser.uid, {
      orderBy: ['dueDate', 'desc'], limit, startAfterId,
    }),
  });
  [, categoriesCache, accountsCache] = await Promise.all([
    pager.loadFirst(),
    listCategories(currentUser.uid),
    listAccounts(currentUser.uid),
  ]);
  expensesCache = [...pager.items].reverse();
}

async function loadMore() {
  await pager.loadMore();
  expensesCache = [...pager.items].reverse();
  renderPage($('.content') || document.getElementById('page-content'));
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'trending-down', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Despesas' }),
        el('p', { class: 'card__hint', text: 'Despesas por categoria, vencimentos, parcelamentos e orçamento mensal.' }),
        el('p', { class: 'card__hint', text: 'Despesa direta debita a conta bancária indicada ao ser paga. Compras no cartão de crédito não entram aqui: são lançadas e acompanhadas em Cartões / Faturas, e pagar a fatura é o que abate a conta bancária.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openExpenseModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova despesa',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Pago no mês', formatCents(stats.paidThisMonth), 'check-circle-2', 'expense', 'Status "paga" no mês atual'),
    createStatCard('Pendente no mês', formatCents(stats.pendingThisMonth), 'clock', null, 'Pendentes não reduzem o saldo'),
  ]);

  const filterBar = createFilterBar();
  const table = createExpensesTable();

  const nodes = [
    header,
    cards,
    filterBar,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Despesas registradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${getFilteredExpenses().length} registro${getFilteredExpenses().length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
    createPagerFooter({ pager, noun: 'despesas', onLoadMore: loadMore }),
  ];

  container.replaceChildren(...nodes.filter(Boolean));
  refreshIcons();
}

/** Computa estatísticas rápidas do mês atual. */
function computeStats() {
  const month = currentMonthKey(); // mês corrente no fuso America/Sao_Paulo

  let paidThisMonth = 0;
  let pendingThisMonth = 0;

  for (const expense of expensesCache) {
    const isThisMonth = String(expense.dueDate).slice(0, 7) === month;

    if (expense.status === 'paid' && isThisMonth) {
      paidThisMonth += Number(expense.amountCents) || 0;
    } else if (expense.status === 'pending' && isThisMonth) {
      pendingThisMonth += Number(expense.amountCents) || 0;
    }
  }

  return { paidThisMonth, pendingThisMonth };
}

/** Cria barra de filtros. */
function createFilterBar() {
  const statusOptions = [
    { value: 'all', label: 'Todos' },
    { value: 'pending', label: 'Pendentes' },
    { value: 'paid', label: 'Pagas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];

  const monthOptions = [{ value: '', label: 'Todos os meses' }];
  const months = new Set();
  for (const expense of expensesCache) {
    const m = expense.dueDate?.substring(0, 7);
    if (m) months.add(m);
  }
  const sortedMonths = Array.from(months).sort().reverse();
  for (const m of sortedMonths) {
    const [y, mo] = m.split('-');
    monthOptions.push({ value: m, label: `${mo}/${y}` });
  }

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Filtros' }),
    ]),
    el('div', { class: 'panel__body', style: 'padding: var(--space-4);' }, [
      el('div', { class: 'form__row', style: 'gap: var(--space-3); flex-wrap: wrap;' }, [
        el('div', { class: 'form__field', style: 'flex: 1; min-width: 180px;' }, [
          el('label', { for: 'filter-status', text: 'Status' }),
          el('select', {
            id: 'filter-status',
            value: currentFilter.status,
            onChange: (e) => {
              currentFilter.status = e.target.value;
              refreshTable();
            },
          }, statusOptions.map((o) => el('option', { value: o.value, selected: currentFilter.status === o.value }, o.label))),
        ]),
        el('div', { class: 'form__field', style: 'flex: 1; min-width: 180px;' }, [
          el('label', { for: 'filter-month', text: 'Mês' }),
          el('select', {
            id: 'filter-month',
            value: currentFilter.month ?? '',
            onChange: (e) => {
              currentFilter.month = e.target.value || null;
              refreshTable();
            },
          }, monthOptions.map((o) => el('option', { value: o.value, selected: currentFilter.month === o.value }, o.label))),
        ]),
        el('div', { class: 'form__field', style: 'flex: 1; min-width: 180px;' }, [
          el('label', { for: 'filter-category', text: 'Categoria' }),
          el('select', {
            id: 'filter-category',
            value: currentFilter.categoryId ?? '',
            onChange: (e) => {
              currentFilter.categoryId = e.target.value || null;
              refreshTable();
            },
          }, [
            el('option', { value: '', selected: !currentFilter.categoryId }, 'Todas as categorias'),
            ...categoriesCache.map((c) =>
              el('option', { value: c.id, selected: currentFilter.categoryId === c.id }, c.name)
            ),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/**
 * Retorna despesas filtradas.
 * Filtro client-side: vale enquanto a listagem não for paginada. Com paginação
 * futura, migrar status/mês/categoria para options.where no serviço (campos
 * únicos, sem índice composto novo).
 */
function getFilteredExpenses() {
  return filterMovements(expensesCache, currentFilter, { dateField: 'dueDate' });
}

/** true quando algum filtro de status/mês/categoria está ativo. */
function hasActiveFilters() {
  return currentFilter.status !== 'all' || Boolean(currentFilter.month) || Boolean(currentFilter.categoryId);
}

/** Atualiza apenas a tabela. */
function refreshTable() {
  const tableContainer = $('#expenses-table-container');
  if (tableContainer) {
    tableContainer.replaceWith(createExpensesTable());
    refreshIcons();
  }
}

/** Cria a tabela de despesas. */
function createExpensesTable() {
  const filtered = getFilteredExpenses();

  if (!filtered.length) {
    return el('div', { id: 'expenses-table-container', class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'trending-down', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma despesa encontrada' }),
      el('p', { class: 'empty__text', text: hasActiveFilters()
        ? 'Tente ajustar os filtros acima.'
        : 'Cadastre contas do mês para controlar vencimentos e comparar com o orçamento.' }),
      hasActiveFilters() ? el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        onClick: () => {
          currentFilter = { status: 'all', month: null, categoryId: null };
          refreshTable();
        },
        text: 'Limpar filtros',
      }) : null,
    ]);
  }

  const columns = [
    { key: 'description', label: 'Descrição' },
    { key: 'categoryId', label: 'Categoria', render: (v) => getCategoryLabel(v) },
    { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'dueDate', label: 'Vencimento', render: (v) => formatDate(v) },
    { key: 'paidDate', label: 'Pagamento', render: (v) => v ? formatDate(v) : '—' },
    { key: 'accountId', label: 'Conta debitada', render: (v, item) => (v ? getAccountLabel(v) : (item.status === 'paid' ? '—' : 'Ao pagar')) },
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = filtered.map((expense) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = expense[column.key];
        const display = column.render ? column.render(value, expense) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, createExpenseActions(expense)),
    ])
  );

  return el('div', { id: 'expenses-table-container', class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Cria botões de ação para uma despesa. */
function createExpenseActions(expense) {
  const actions = [];

  if (expense.status === 'pending') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--success',
        'aria-label': `Marcar ${expense.description} como paga`,
        onClick: () => confirmMarkPaid(expense),
        html: '<i data-lucide="check-circle-2" aria-hidden="true"></i>',
      })
    );
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Cancelar ${expense.description}`,
        onClick: () => confirmCancelExpense(expense),
        html: '<i data-lucide="x-circle" aria-hidden="true"></i>',
      })
    );
  }

  // VF-ARQ-02: despesa PAGA é imutável (saldo/histórico): só estorno compensatório pelo servidor; as demais editam/excluem.
  if (expense.status === 'paid') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Estornar ${expense.description}`,
        title: 'Estornar (lançamento compensatório)',
        onClick: () => openReversalModal({
          user: currentUser, kind: 'expense', targetId: expense.id, amountCents: Number(expense.amountCents) || 0,
          summary: `${expense.description} — ${formatCents(Number(expense.amountCents) || 0)} (${getAccountLabel(expense.accountId)})`,
          onDone: async () => { await loadData(); renderPage($('.content') || document.getElementById('page-content')); },
        }),
        html: '<i data-lucide="undo-2" aria-hidden="true"></i>',
      })
    );
    return actions;
  }

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `Editar ${expense.description}`,
      onClick: () => openExpenseModal(expense),
      html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
    })
  );

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon btn--danger',
      'aria-label': `Excluir ${expense.description}`,
      onClick: () => confirmDeleteExpense(expense),
      html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
    })
  );

  return actions;
}

/** Abre modal para criar/editar despesa. */
function openExpenseModal(expense = null) {
  const isEdit = !!expense;
  const operationId = newOperationId(); // idempotência da criação: duplo clique/retry desta abertura não duplica
  const recurrences = getRecurrenceOptions();
  const statuses = getExpenseStatusOptions();
  const expenseCategories = categoriesCache.filter((c) => c.kind === 'expense' || c.kind === 'both');
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');

  const form = el('form', { id: 'expense-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'description', text: 'Descrição *' }),
        el('input', {
          type: 'text',
          id: 'description',
          name: 'description',
          required: true,
          maxlength: 120,
          value: expense?.description ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'description' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'categoryId', text: 'Categoria *' }),
        el('select', {
          id: 'categoryId',
          name: 'categoryId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !expense }, 'Selecione uma categoria'),
          ...expenseCategories.map((c) =>
            el('option', { value: c.id, selected: expense?.categoryId === c.id }, categoryLabel(c))
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'categoryId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'amountCents', text: 'Valor (R$) *' }),
        el('input', {
          type: 'text',
          id: 'amountCents',
          name: 'amountCents',
          required: true,
          placeholder: '0,00',
          value: expense?.amountCents ? formatCentsInput(expense.amountCents) : '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'amountCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'accountId', text: 'Conta *' }),
        el('select', {
          id: 'accountId',
          name: 'accountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !expense }, 'Selecione uma conta'),
          ...activeAccounts.map((a) =>
            el('option', { value: a.id, selected: expense?.accountId === a.id }, accountLabel(a))
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'accountId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'purchaseDate', text: 'Data da compra *' }),
        el('input', {
          type: 'date',
          id: 'purchaseDate',
          name: 'purchaseDate',
          required: true,
          value: expense?.purchaseDate ?? todayInAppZone(),
        }),
        el('span', { class: 'form__error', 'data-for': 'purchaseDate' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'dueDate', text: 'Data de vencimento *' }),
        el('input', {
          type: 'date',
          id: 'dueDate',
          name: 'dueDate',
          required: true,
          value: expense?.dueDate ?? todayInAppZone(),
        }),
        el('span', { class: 'form__error', 'data-for': 'dueDate' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'paidDate', text: 'Data de pagamento' }),
        el('input', {
          type: 'date',
          id: 'paidDate',
          name: 'paidDate',
          value: expense?.paidDate ?? '',
        }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'recurrence', text: 'Recorrência *' }),
        el('select', {
          id: 'recurrence',
          name: 'recurrence',
          required: true,
        }, recurrences.map((r) =>
          el('option', { value: r.value, selected: expense?.recurrence === r.value }, r.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'recurrence' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: expense?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'installmentGroupId', text: 'ID do grupo de parcelas' }),
        el('input', {
          type: 'text',
          id: 'installmentGroupId',
          name: 'installmentGroupId',
          maxlength: 128,
          placeholder: 'Opcional: para parcelamentos',
          value: expense?.installmentGroupId ?? '',
        }),
      ]),
    ]),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', {
        id: 'notes',
        name: 'notes',
        maxlength: 500,
        rows: 3,
        value: expense?.notes ?? '',
      }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar despesa' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar despesa: ${expense.description}` : 'Nova despesa',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#amountCents', modal.overlay);
  moneyInput.addEventListener('blur', () => {
    const cents = parseMoneyToCents(moneyInput.value);
    moneyInput.value = cents !== null ? formatCentsInput(cents) : '';
  });

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const formData = new FormData(form);
    const rawData = {
      description: formData.get('description').trim(),
      categoryId: formData.get('categoryId'),
      amountCents: formData.get('amountCents'),
      accountId: formData.get('accountId'),
      purchaseDate: formData.get('purchaseDate'),
      dueDate: formData.get('dueDate'),
      paidDate: formData.get('paidDate') || undefined,
      status: formData.get('status'),
      recurrence: formData.get('recurrence'),
      notes: formData.get('notes').trim() || undefined,
      installmentGroupId: formData.get('installmentGroupId').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateExpense(currentUser.uid, expense.id, rawData)
      : await createExpense(currentUser.uid, { ...rawData, operationId });

    if (result.ok) {
      toast(isEdit ? 'Despesa atualizada com sucesso.' : 'Despesa criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar despesa';
  }

  form.addEventListener('submit', handleSubmit);
  $('#description', form).focus();
}

/** Confirma marcar como paga. */
async function confirmMarkPaid(expense) {
  const result = await markExpensePaid(currentUser.uid, expense.id);
  if (result.ok) {
    toast('Despesa marcada como paga.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form ?? 'Erro ao marcar como paga.', 5000);
  }
}

/** Confirma cancelamento. */
async function confirmCancelExpense(expense) {
  const result = await cancelExpense(currentUser.uid, expense.id);
  if (result.ok) {
    toast('Despesa cancelada.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form ?? 'Erro ao cancelar.', 5000);
  }
}

/** Confirma exclusão. */
function confirmDeleteExpense(expense) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a despesa "${expense.description}"?` }),
    el('p', { class: 'card__hint', text: expense.status === 'paid' && expense.accountId
      ? `Despesa paga: ao excluir, ${formatCents(Number(expense.amountCents) || 0)} voltam ao saldo de ${getAccountLabel(expense.accountId)} (o saldo é calculado dos lançamentos, nada é regravado).`
      : 'Despesa não paga: o saldo de nenhuma conta é afetado.' }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita.' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteExpense(currentUser.uid, expense.id);
        if (result.ok) {
          toast(result.reversedCents ? `Despesa excluída — ${formatCents(result.reversedCents)} estornados em ${getAccountLabel(result.accountId)}.` : 'Despesa excluída.');
          await loadData();
          renderPage($('.content') || document.getElementById('page-content'));
        } else {
          toast(`Erro: ${result.errors._form}`, 5000);
        }
      },
      text: 'Excluir',
    }),
  ];

  openModal({ title: 'Confirmar exclusão', body, footer });
}

function getAccountLabel(accountId) {
  const a = accountsCache.find((x) => x.id === accountId);
  return a ? accountLabel(a) : '—';
}

function getCategoryLabel(categoryId) {
  const cat = categoriesCache.find((c) => c.id === categoryId);
  return cat?.name ?? categoryId ?? '—';
}

/** Rótulo da opção no select: nome + tipo (Receita/Despesa/Ambos). */
function getStatusLabel(value) {
  const statuses = getExpenseStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}
