/**
 * Receitas — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista receitas com filtros
 * - Modal para criar/editar receita
 * - Ações: marcar como recebida, cancelar
 * - Validação client-side espelhando Security Rules
 * - Persistência em users/{uid}/incomes
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import { createStatCard } from '../components/stat-card.js';
import { formatCentsInput, formatDate, clearErrors, showFormErrors as showErrors, confirmModal } from '../components/form-kit.js';
import { filterMovements, accountLabel } from '../core/model.js';
import {
  listIncomes,
  createIncome,
  updateIncome,
  deleteIncome,
  markIncomeReceived,
  cancelIncome,
  getRecurrenceOptions,
  getIncomeStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/incomes.js';
import { createPager } from '../services/pager.js';
import { createPagerFooter } from '../components/pager-footer.js';
import { listCategories, categoryLabel } from '../services/categories.js';
import { listAccounts } from '../services/accounts.js';

import { todayInAppZone, currentMonthKey } from '../utils/dates.js';
import { newOperationId } from '../services/financeApi.js';
import { openReversalModal } from '../components/reversal-modal.js';
export const meta = { title: 'Receitas', icon: 'trending-up' };

let currentUser = null;
let incomesCache = [];
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
  // Paginação por cursor (VF-4-03): só a página mais recente; "Carregar mais antigas" no rodapé.
  pager = createPager({
    fetchPage: ({ limit, startAfterId }) => listIncomes(currentUser.uid, { limit, startAfterId }),
  });
  [, categoriesCache, accountsCache] = await Promise.all([
    pager.loadFirst(),
    listCategories(currentUser.uid),
    listAccounts(currentUser.uid),
  ]);
  incomesCache = pager.items;
  applyFilters();
}

async function loadMore() {
  await pager.loadMore();
  incomesCache = pager.items;
  renderPage($('.content') || document.getElementById('page-content'));
}

/** Aplica filtros atuais. */
function applyFilters() {
  // Filtros são aplicados na renderização da tabela
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'trending-up', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Receitas' }),
        el('p', { class: 'card__hint', text: 'Receitas previstas e recebidas, com recorrência e histórico mensal.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openIncomeModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova receita',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Recebido no mês', formatCents(stats.receivedThisMonth), 'check-circle-2', 'income', 'Status "recebida" no mês atual'),
    createStatCard('Previsto no mês', formatCents(stats.pendingThisMonth), 'calendar-clock', null, 'Inclui previstas e atrasadas'),
  ]);

  const filterBar = createFilterBar();
  const table = createIncomesTable();

  const nodes = [
    header,
    cards,
    filterBar,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Receitas registradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${getFilteredIncomes().length} registro${getFilteredIncomes().length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
    createPagerFooter({ pager, noun: 'receitas', onLoadMore: loadMore }),
  ];

  container.replaceChildren(...nodes.filter(Boolean));
  refreshIcons();
}

/** Computa estatísticas rápidas do mês atual. */
function computeStats() {
  const month = currentMonthKey(); // mês corrente no fuso America/Sao_Paulo

  let receivedThisMonth = 0;
  let pendingThisMonth = 0;

  for (const income of incomesCache) {
    const isThisMonth = String(income.expectedDate).slice(0, 7) === month;

    if (income.status === 'received' && isThisMonth) {
      receivedThisMonth += Number(income.amountCents) || 0;
    } else if (income.status === 'pending' && isThisMonth) {
      pendingThisMonth += Number(income.amountCents) || 0;
    }
  }

  return { receivedThisMonth, pendingThisMonth };
}

/** Cria barra de filtros. */
function createFilterBar() {
  const statusOptions = [
    { value: 'all', label: 'Todos' },
    { value: 'pending', label: 'Previstas' },
    { value: 'received', label: 'Recebidas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];

  const monthOptions = [{ value: '', label: 'Todos os meses' }];
  // Gerar opções de mês baseadas nos dados
  const months = new Set();
  for (const income of incomesCache) {
    const m = income.expectedDate?.substring(0, 7); // YYYY-MM
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
    el('div', { class: 'panel__body filter-body' }, [
      el('div', { class: 'form__row filter-row' }, [
        el('div', { class: 'form__field filter-field' }, [
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
        el('div', { class: 'form__field filter-field' }, [
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
        el('div', { class: 'form__field filter-field' }, [
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
 * Retorna receitas filtradas.
 * Filtro client-side: vale enquanto a listagem não for paginada. Com paginação
 * futura, migrar status/mês/categoria para options.where no serviço (campos
 * únicos, sem índice composto novo).
 */
function getFilteredIncomes() {
  return filterMovements(incomesCache, currentFilter, { dateField: 'expectedDate' });
}

/** true quando algum filtro de status/mês/categoria está ativo. */
function hasActiveFilters() {
  return currentFilter.status !== 'all' || Boolean(currentFilter.month) || Boolean(currentFilter.categoryId);
}

/** Atualiza apenas a tabela. */
function refreshTable() {
  const tableContainer = $('#incomes-table-container');
  if (tableContainer) {
    tableContainer.replaceWith(createIncomesTable());
    refreshIcons();
  }
}

/** Cria a tabela de receitas. */
function createIncomesTable() {
  const filtered = getFilteredIncomes();

  if (!filtered.length) {
    return el('div', { id: 'incomes-table-container', class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'trending-up', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma receita encontrada' }),
      el('p', { class: 'empty__text', text: hasActiveFilters()
        ? 'Tente ajustar os filtros acima.'
        : 'Registre salário, bônus ou outras entradas para acompanhar o previsto versus o realizado.' }),
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
    { key: 'expectedDate', label: 'Prevista', render: (v) => formatDate(v) },
    { key: 'receivedDate', label: 'Recebida', render: (v) => v ? formatDate(v) : '—' },
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = filtered.map((income) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = income[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, createIncomeActions(income)),
    ])
  );

  return el('div', { id: 'incomes-table-container', class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Cria botões de ação para uma receita. */
function createIncomeActions(income) {
  const actions = [];

  if (income.status === 'pending') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--success',
        'aria-label': `Marcar ${income.description} como recebida`,
        onClick: () => confirmMarkReceived(income),
        html: '<i data-lucide="check-circle-2" aria-hidden="true"></i>',
      })
    );
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Cancelar ${income.description}`,
        onClick: () => confirmCancelIncome(income),
        html: '<i data-lucide="x-circle" aria-hidden="true"></i>',
      })
    );
  }

  // VF-ARQ-02: receita RECEBIDA é imutável (saldo/histórico): só estorno compensatório pelo servidor.
  if (income.status === 'received') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Estornar ${income.description}`,
        title: 'Estornar (lançamento compensatório)',
        onClick: () => openReversalModal({
          user: currentUser, kind: 'income', targetId: income.id, amountCents: Number(income.amountCents) || 0,
          summary: `${income.description} — ${formatCents(Number(income.amountCents) || 0)} (${accountLabelOf(income.accountId)})`,
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
      'aria-label': `Editar ${income.description}`,
      onClick: () => openIncomeModal(income),
      html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
    })
  );

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon btn--danger',
      'aria-label': `Excluir ${income.description}`,
      onClick: () => confirmDeleteIncome(income),
      html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
    })
  );

  return actions;
}

/** Abre modal para criar/editar receita. */
function openIncomeModal(income = null) {
  const isEdit = !!income;
  const operationId = newOperationId(); // idempotência da criação: duplo clique/retry desta abertura não duplica
  const recurrences = getRecurrenceOptions();
  const statuses = getIncomeStatusOptions();
  const incomeCategories = categoriesCache.filter((c) => c.kind === 'income' || c.kind === 'both');
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');

  const form = el('form', { id: 'income-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'description', text: 'Descrição *' }),
        el('input', {
          type: 'text',
          id: 'description',
          name: 'description',
          required: true,
          maxlength: 120,
          value: income?.description ?? '',
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
          el('option', { value: '', disabled: true, selected: !income }, 'Selecione uma categoria'),
          ...incomeCategories.map((c) =>
            el('option', { value: c.id, selected: income?.categoryId === c.id }, categoryLabel(c))
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
          value: income?.amountCents ? formatCentsInput(income.amountCents) : '',
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
          el('option', { value: '', disabled: true, selected: !income }, 'Selecione uma conta'),
          ...activeAccounts.map((a) =>
            el('option', { value: a.id, selected: income?.accountId === a.id }, accountLabel(a))
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'accountId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'expectedDate', text: 'Data prevista *' }),
        el('input', {
          type: 'date',
          id: 'expectedDate',
          name: 'expectedDate',
          required: true,
          value: income?.expectedDate ?? todayInAppZone(),
        }),
        el('span', { class: 'form__error', 'data-for': 'expectedDate' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'recurrence', text: 'Recorrência *' }),
        el('select', {
          id: 'recurrence',
          name: 'recurrence',
          required: true,
        }, recurrences.map((r) =>
          el('option', { value: r.value, selected: income?.recurrence === r.value }, r.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'recurrence' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'receivedDate', text: 'Data de recebimento' }),
        el('input', {
          type: 'date',
          id: 'receivedDate',
          name: 'receivedDate',
          value: income?.receivedDate ?? '',
        }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: income?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
      ]),
    ]),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', {
        id: 'notes',
        name: 'notes',
        maxlength: 500,
        rows: 3,
        value: income?.notes ?? '',
      }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar receita' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar receita: ${income.description}` : 'Nova receita',
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
      expectedDate: formData.get('expectedDate'),
      receivedDate: formData.get('receivedDate') || undefined,
      accountId: formData.get('accountId'),
      status: formData.get('status'),
      recurrence: formData.get('recurrence'),
      notes: formData.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateIncome(currentUser.uid, income.id, rawData)
      : await createIncome(currentUser.uid, { ...rawData, operationId });

    if (result.ok) {
      toast(isEdit ? 'Receita atualizada com sucesso.' : 'Receita criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar receita';
  }

  form.addEventListener('submit', handleSubmit);
  $('#description', form).focus();
}

/** Confirma marcar como recebida. */
async function confirmMarkReceived(income) {
  const result = await markIncomeReceived(currentUser.uid, income.id);
  if (result.ok) {
    toast('Receita marcada como recebida.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form ?? 'Erro ao marcar como recebida.', 5000);
  }
}

/** Pede confirmação (cancelar é terminal) e só então cancela. */
function confirmCancelIncome(income) {
  confirmModal({
    title: 'Cancelar receita',
    message: `Cancelar a receita "${income.description}"?`,
    hint: 'A receita cancelada deixa de contar nos totais e nas previsões.',
    confirmLabel: 'Cancelar receita',
    onConfirm: async () => {
      const result = await cancelIncome(currentUser.uid, income.id);
      if (result.ok) {
        toast('Receita cancelada.');
        await loadData();
        renderPage($('.content') || document.getElementById('page-content'));
      } else {
        toast(result.errors?._form ?? 'Erro ao cancelar.', 5000);
      }
    },
  });
}

/** Confirma exclusão. */
function confirmDeleteIncome(income) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a receita "${income.description}"?` }),
    el('p', { class: 'card__hint', text: income.status === 'received' && income.accountId
      ? `Receita recebida: ao excluir, ${formatCents(Number(income.amountCents) || 0)} saem do saldo de ${accountLabelOf(income.accountId)} (o saldo é calculado dos lançamentos, nada é regravado).`
      : 'Receita não recebida: o saldo de nenhuma conta é afetado.' }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita.' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteIncome(currentUser.uid, income.id);
        if (result.ok) {
          toast(result.reversedCents ? `Receita excluída — ${formatCents(result.reversedCents)} estornados em ${accountLabelOf(result.accountId)}.` : 'Receita excluída.');
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

function accountLabelOf(accountId) {
  const a = accountsCache.find((x) => x.id === accountId);
  return a ? accountLabel(a) : '—';
}

function getCategoryLabel(categoryId) {
  const cat = categoriesCache.find((c) => c.id === categoryId);
  return cat?.name ?? categoryId ?? '—';
}

/** Rótulo da opção no select: nome + tipo (Receita/Despesa/Ambos). */
function getStatusLabel(value) {
  const statuses = getIncomeStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}
