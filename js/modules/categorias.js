/**
 * Categorias — Fase 4, Etapa 1: CRUD completo integrado ao Firestore.
 * - Lista categorias cadastradas (nome, tipo, cor)
 * - Modal para criar/editar (validação espelhando as Security Rules)
 * - Exclusão segura: bloqueada quando há vínculos em receitas, despesas,
 *   orçamentos ou assinaturas (checagem feita no serviço).
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryKindOptions,
} from '../services/categories.js';

export const meta = { title: 'Categorias', icon: 'tags' };

let currentUser = null;
let categoriesCache = [];

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  await loadData();
  renderPage(container);
}

async function loadData() {
  categoriesCache = await listCategories(currentUser.uid);
}

function renderPage(container) {
  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [
        el('i', { 'data-lucide': 'tags', 'aria-hidden': 'true' }),
      ]),
      el('div', {}, [
        el('h2', { text: 'Categorias' }),
        el('p', {
          class: 'card__hint',
          text: 'Classificação de receitas e despesas. Categorias em uso não podem ser excluídas.',
        }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openCategoryModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova categoria',
      }),
    ]),
  ]);

  const counts = computeKindCounts();
  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Total de categorias', String(categoriesCache.length), 'tags', 'Todas as categorias cadastradas'),
    createStatCard('Para receitas', String(counts.income), 'trending-up', 'Tipo "receita" ou "ambos"'),
    createStatCard('Para despesas', String(counts.expense), 'trending-down', 'Tipo "despesa" ou "ambos"'),
  ]);

  container.replaceChildren(
    header,
    cards,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Categorias cadastradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', {
          class: 'badge',
          text: `${categoriesCache.length} registro${categoriesCache.length === 1 ? '' : 's'}`,
        }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [createCategoriesTable()]),
    ])
  );
  refreshIcons();
}

function computeKindCounts() {
  return categoriesCache.reduce(
    (acc, category) => {
      if (category.kind === 'income') acc.income += 1;
      else if (category.kind === 'expense') acc.expense += 1;
      else if (category.kind === 'both') {
        acc.income += 1;
        acc.expense += 1;
      }
      return acc;
    },
    { income: 0, expense: 0 }
  );
}

function createStatCard(label, value, icon, hint) {
  return el('article', { class: 'card' }, [
    el('div', { class: 'card__icon' }, [
      el('i', { 'data-lucide': icon, 'aria-hidden': 'true' }),
    ]),
    el('div', { class: 'card__content' }, [
      el('p', { class: 'card__label', text: label }),
      el('p', { class: 'card__value', text: value }),
    ]),
    hint ? el('p', { class: 'card__hint', text: hint }) : null,
  ]);
}

function createCategoriesTable() {
  if (!categoriesCache.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [
        el('i', { 'data-lucide': 'tags', 'aria-hidden': 'true' }),
      ]),
      el('p', { class: 'empty__title', text: 'Nenhuma categoria cadastrada' }),
      el('p', {
        class: 'empty__text',
        text: 'Crie categorias para classificar receitas e despesas e acompanhar seus gastos.',
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openCategoryModal(),
        text: 'Criar primeira categoria',
      }),
    ]);
  }

  const head = el('tr', {}, [
    el('th', { text: 'Nome' }),
    el('th', { text: 'Tipo' }),
    el('th', { text: 'Cor' }),
    el('th', { text: 'Ações' }),
  ]);

  const body = categoriesCache.map((category) =>
    el('tr', {}, [
      el('td', { text: category.name ?? '—' }),
      el('td', { text: kindLabel(category.kind) }),
      el('td', {}, [
        el('span', {
          style: `display:inline-flex;align-items:center;gap:8px`,
        }, [
          el('span', {
            'aria-hidden': 'true',
            style: `width:14px;height:14px;border-radius:4px;border:1px solid var(--border);background:${sanitizeColor(
              category.color
            )}`,
          }),
          el('span', { class: 'card__hint', text: category.color ?? '—' }),
        ]),
      ]),
      el('td', {}, [
        el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `Editar ${category.name}`,
          onClick: () => openCategoryModal(category),
          html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `Excluir ${category.name}`,
          onClick: () => confirmDeleteCategory(category),
          html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
        }),
      ]),
    ])
  );

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
  ]);
}

/** Abre modal para criar/editar categoria. */
function openCategoryModal(category = null) {
  const isEdit = Boolean(category);
  const kinds = getCategoryKindOptions();

  const form = el('form', { id: 'category-form', novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { for: 'category-name', text: 'Nome *' }),
      el('input', {
        type: 'text',
        id: 'category-name',
        name: 'name',
        required: true,
        maxlength: 60,
        autocomplete: 'off',
        value: category?.name ?? '',
      }),
      el('span', { class: 'form-error', 'data-for': 'name' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'category-kind', text: 'Tipo *' }),
      el(
        'select',
        { id: 'category-kind', name: 'kind', required: true },
        kinds.map((option) =>
          el(
            'option',
            { value: option.value, selected: (category?.kind ?? 'expense') === option.value },
            option.label
          )
        )
      ),
      el('span', { class: 'form-error', 'data-for': 'kind' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'category-color', text: 'Cor' }),
      el('input', {
        type: 'color',
        id: 'category-color',
        name: 'color',
        value: isHexColor(category?.color) ? category.color : '#1f7a5c',
      }),
      el('span', { class: 'field__hint', text: 'Usada para identificar a categoria na interface.' }),
      el('span', { class: 'form-error', 'data-for': 'color' }),
    ]),
  ]);

  const footer = [
    el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onClick: closeModal,
      text: 'Cancelar',
    }),
    el('button', {
      type: 'submit',
      class: 'btn btn--primary',
      text: isEdit ? 'Salvar alterações' : 'Criar categoria',
    }),
  ];

  openModal({
    title: isEdit ? `Editar categoria: ${category.name}` : 'Nova categoria',
    body: form,
    footer,
  });

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';
    clearErrors(form);

    const formData = new FormData(form);
    const rawData = {
      name: String(formData.get('name') ?? '').trim(),
      kind: formData.get('kind'),
      color: String(formData.get('color') ?? '').trim() || '#1f7a5c',
    };

    const result = isEdit
      ? await updateCategory(currentUser.uid, category.id, rawData)
      : await createCategory(currentUser.uid, rawData);

    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar categoria';

    if (!result.ok) {
      showErrors(form, result.errors ?? {});
      return;
    }

    toast(isEdit ? 'Categoria atualizada.' : 'Categoria criada.');
    closeModal();
    await loadData();
    renderPage($('#page-content'));
  }

  form.addEventListener('submit', handleSubmit);
  $('#category-name', form).focus();
}

/**
 * Confirmação de exclusão. O vínculo é verificado no serviço; quando há
 * vínculos, a mensagem (coleção + contagem) é exibida no próprio modal.
 */
function confirmDeleteCategory(category) {
  const message = el('p', { class: 'form-error', role: 'alert' });
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a categoria "${category.name}"?` }),
    el('p', {
      class: 'card__hint',
      text: 'A exclusão só é permitida quando não há receitas, despesas, orçamentos ou assinaturas usando esta categoria.',
    }),
    message,
  ]);

  const confirmButton = el('button', {
    type: 'button',
    class: 'btn btn--danger',
    text: 'Excluir',
  });

  confirmButton.addEventListener('click', async () => {
    confirmButton.disabled = true;
    confirmButton.textContent = 'Verificando...';
    message.textContent = '';

    const result = await deleteCategory(currentUser.uid, category.id);

    if (!result.ok) {
      confirmButton.disabled = false;
      confirmButton.textContent = 'Excluir';
      message.textContent = result.errors?._form ?? 'Não foi possível excluir a categoria.';
      return;
    }

    toast('Categoria excluída.');
    closeModal();
    await loadData();
    renderPage($('#page-content'));
  });

  openModal({
    title: 'Confirmar exclusão',
    body,
    footer: [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onClick: closeModal,
        text: 'Cancelar',
      }),
      confirmButton,
    ],
  });
}

function kindLabel(kind) {
  return getCategoryKindOptions().find((option) => option.value === kind)?.label ?? kind ?? '—';
}

/** Só aceita hex de 3/6 dígitos — o valor entra em style inline. */
function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value);
}

function sanitizeColor(value) {
  return isHexColor(value) ? value : 'var(--surface-2)';
}

function clearErrors(form) {
  for (const node of form.querySelectorAll('.form-error')) node.textContent = '';
}

function showErrors(form, errors) {
  for (const [field, text] of Object.entries(errors)) {
    if (field === '_form') continue;
    const node = form.querySelector(`.form-error[data-for="${field}"]`);
    if (node) node.textContent = text;
  }
  if (errors._form) toast(errors._form, 5000);
}
