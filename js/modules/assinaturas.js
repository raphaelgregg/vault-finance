/**
 * Assinaturas — VF-2-03a: CRUD integrado ao Firestore (users/{uid}/subscriptions).
 * Custo mensal/anual calculado a partir das ATIVAS (js/core/model.js); nada é gravado derivado.
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listSubscriptions,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  registerSubscriptionCharge,
  getPeriodicityOptions,
  getSubscriptionStatusOptions,
  summarizeSubscriptions,
  formatCents,
  parseMoneyToCents,
} from '../services/subscriptions.js';
import { listCategories, categoryLabel } from '../services/categories.js';
import { listAccounts } from '../services/accounts.js';
import { accountLabel as accountText } from '../core/model.js';
import { listCards } from '../services/creditCards.js';
import { listDebtors } from '../services/debtors.js';

import { todayInAppZone } from '../utils/dates.js';
import { clearErrors, formatCentsInput, formatDate, optionLabel } from '../components/form-kit.js';
export const meta = { title: 'Assinaturas', icon: 'repeat' };

let currentUser = null;
let container = null;
let subscriptionsCache = [];
let categoriesCache = [];
let accountsCache = [];
let cardsCache = [];
let debtorsCache = [];

export async function render(target, { user }) {
  currentUser = user;
  container = target;
  await reload();
}

async function reload() {
  [subscriptionsCache, categoriesCache, accountsCache, cardsCache, debtorsCache] = await Promise.all([
    listSubscriptions(currentUser.uid),
    listCategories(currentUser.uid),
    listAccounts(currentUser.uid),
    listCards(currentUser.uid).catch((error) => { console.error('[assinaturas] falha ao listar cartões', error); return []; }),
    listDebtors(currentUser.uid).catch((error) => { console.error('[assinaturas] falha ao listar devedores', error); return []; }),
  ]);
  renderPage();
}

function renderPage() {
  const summary = summarizeSubscriptions(subscriptionsCache);
  const count = subscriptionsCache.length;

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'repeat', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Assinaturas' }),
        el('p', { class: 'card__hint', text: 'Serviços recorrentes, custo mensal equivalente e próximas cobranças.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openSubscriptionModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova assinatura',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard('Custo mensal', formatCents(summary.monthlyCents), 'repeat', `Equivalente mensal de ${summary.activeCount} ativa${summary.activeCount !== 1 ? 's' : ''}`),
    statCard('Projeção anual', formatCents(summary.annualCents), 'calendar', 'Soma anual das ativas'),
  ]);

  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Assinaturas cadastradas' }),
      el('div', { class: 'topbar__spacer' }),
      el('span', { class: 'badge', text: `${count} registro${count !== 1 ? 's' : ''}` }),
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [createTableOrEmpty()]),
  ]);

  container.replaceChildren(header, cards, panel);
  refreshIcons();
}

function statCard(label, value, icon, hint) {
  return el('article', { class: 'card' }, [
    el('div', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
    el('div', { class: 'card__content' }, [
      el('p', { class: 'card__label', text: label }),
      el('p', { class: 'card__value', text: value }),
    ]),
    el('p', { class: 'card__hint', text: hint }),
  ]);
}

function createTableOrEmpty() {
  if (!subscriptionsCache.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'repeat', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma assinatura cadastrada' }),
      el('p', { class: 'empty__text', text: 'Cadastre streaming, nuvem e outros serviços para enxergar o custo recorrente real.' }),
    ]);
  }

  const columns = [
    { key: 'name', label: 'Serviço' },
    { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'periodicity', label: 'Periodicidade', render: (v) => optionLabel(getPeriodicityOptions(), v) },
    { key: 'nextChargeDate', label: 'Próxima cobrança', render: formatDate },
    { key: 'accountId', label: 'Cobrança', render: (_, item) => chargeTargetText(item) },
    { key: 'status', label: 'Status', render: (v) => optionLabel(getSubscriptionStatusOptions(), v) },
  ];

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
          el('th', { text: 'Ações' }),
        ]),
      ]),
      el('tbody', {}, subscriptionsCache.map((item) =>
        el('tr', {}, [
          ...columns.map((c) => el('td', {
            class: c.numeric ? 'num' : '',
            text: c.render ? c.render(item[c.key], item) : (item[c.key] ?? '—'),
          })),
          el('td', { class: 'actions' }, createActions(item)),
        ])
      )),
    ]),
  ]);
}

function iconButton(label, icon, onClick, extraClass = '') {
  return el('button', {
    type: 'button',
    class: `btn btn--icon ${extraClass}`.trim(),
    'aria-label': label,
    onClick,
    html: `<i data-lucide="${icon}" aria-hidden="true"></i>`,
  });
}

const cardName = (id) => cardsCache.find((c) => c.id === id)?.name ?? '—';
const debtorName = (id) => debtorsCache.find((d) => d.id === id)?.name ?? '—';

/** Onde a assinatura é cobrada: cartão (fatura) ou conta; o devedor, quando houver, é quem paga (a receber). */
function chargeTargetText(item) {
  const where = item.cardId ? `Cartão ${cardName(item.cardId)} (fatura)` : item.accountId ? `Conta ${accountLabel(item.accountId)}` : null;
  const who = item.debtorId ? `Devedor ${debtorName(item.debtorId)}` : null;
  return [where, who].filter(Boolean).join(' · ') || 'Sem vínculo (só acompanhamento)';
}

async function chargeNow(item) {
  const r = await registerSubscriptionCharge(currentUser.uid, item.id);
  if (r.ok) {
    toast(r.via === 'card'
      ? `Cobrança lançada na fatura do cartão ${cardName(item.cardId)}${r.debtorId ? ` e vinculada ao devedor ${debtorName(r.debtorId)} (a receber)` : ''}; próxima em ${formatDate(r.nextChargeDate)}.`
      : r.via === 'debtor'
        ? `Dívida criada para ${debtorName(r.debtorId)} (a receber); próxima cobrança em ${formatDate(r.nextChargeDate)}.`
        : `Cobrança registrada; próxima em ${formatDate(r.nextChargeDate)}. (Sem cartão nem devedor: não gera despesa nem altera o saldo — lance em Despesas se quiser refletir.)`, 6000);
    await reload();
  } else {
    toast(r.errors?._form ?? Object.values(r.errors ?? {})[0] ?? 'Não foi possível registrar a cobrança.', 6000);
  }
}

function createActions(item) {
  const actions = [];
  if (item.status === 'active') {
    actions.push(iconButton(`Registrar cobrança de ${item.name}`, 'receipt', () => chargeNow(item), 'btn--success'));
  }
  if (item.status === 'active') {
    actions.push(iconButton(`Pausar ${item.name}`, 'pause-circle', () => changeStatus(item, pauseSubscription, 'Assinatura pausada.')));
  }
  if (item.status === 'paused') {
    actions.push(iconButton(`Retomar ${item.name}`, 'play-circle', () => changeStatus(item, resumeSubscription, 'Assinatura retomada.'), 'btn--success'));
  }
  if (item.status !== 'cancelled') {
    actions.push(iconButton(`Cancelar ${item.name}`, 'x-circle', () => confirmCancel(item), 'btn--danger'));
  }
  actions.push(iconButton(`Editar ${item.name}`, 'edit-2', () => openSubscriptionModal(item)));
  actions.push(iconButton(`Excluir ${item.name}`, 'trash-2', () => confirmDelete(item), 'btn--danger'));
  return actions;
}

async function changeStatus(item, fn, successMessage) {
  const result = await fn(currentUser.uid, item.id);
  if (result.ok) {
    toast(successMessage);
    await reload();
  } else {
    toast(result.errors?._form ?? 'Erro ao alterar o status.', 5000);
  }
}

function confirmCancel(item) {
  const body = el('div', {}, [
    el('p', { text: `Cancelar a assinatura "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'Assinaturas canceladas não voltam a ficar ativas e saem do custo mensal.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Voltar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        await changeStatus(item, cancelSubscription, 'Assinatura cancelada.');
      },
      text: 'Cancelar assinatura',
    }),
  ];
  openModal({ title: 'Confirmar cancelamento', body, footer });
}

function confirmDelete(item) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a assinatura "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Para manter o histórico, prefira cancelar.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteSubscription(currentUser.uid, item.id);
        if (result.ok) {
          toast('Assinatura excluída.');
          await reload();
        } else {
          toast(`Erro: ${result.errors._form}`, 5000);
        }
      },
      text: 'Excluir',
    }),
  ];
  openModal({ title: 'Confirmar exclusão', body, footer });
}

function field(label, id, control) {
  return el('div', { class: 'form__field' }, [
    el('label', { for: id, text: label }),
    control,
    el('span', { class: 'form__error', 'data-for': id }),
  ]);
}

function openSubscriptionModal(item = null) {
  const isEdit = !!item;
  const today = todayInAppZone();
  const expenseCategories = categoriesCache.filter((c) => c.kind === 'expense' || c.kind === 'both');
  const activeAccounts = accountsCache.filter((a) => a.status === 'active' || a.id === item?.accountId);

  const form = el('form', { id: 'subscription-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      field('Serviço *', 'name', el('input', {
        type: 'text', id: 'name', name: 'name', required: true, maxlength: 80,
        value: item?.name ?? '', autocomplete: 'off',
      })),
      field('Valor (R$) *', 'amountCents', el('input', {
        type: 'text', id: 'amountCents', name: 'amountCents', required: true, placeholder: '0,00',
        value: item?.amountCents ? formatCentsInput(item.amountCents) : '', autocomplete: 'off',
      })),
    ]),
    el('div', { class: 'form__row' }, [
      field('Periodicidade *', 'periodicity', el('select', { id: 'periodicity', name: 'periodicity', required: true },
        getPeriodicityOptions().map((o) => el('option', { value: o.value, selected: (item?.periodicity ?? 'monthly') === o.value }, o.label)))),
      field('Próxima cobrança *', 'nextChargeDate', el('input', {
        type: 'date', id: 'nextChargeDate', name: 'nextChargeDate', required: true,
        value: item?.nextChargeDate ?? today,
      })),
    ]),
    field('Cobrada no cartão (opcional)', 'cardId', el('select', { id: 'cardId', name: 'cardId' }, [
      el('option', { value: '' }, 'Nenhum (sem cartão)'),
      ...cardsCache.filter((c) => c.status !== 'cancelled' || c.id === item?.cardId).map((c) => el('option', { value: c.id, selected: item?.cardId === c.id }, c.name)),
    ])),
    el('p', { class: 'card__hint', text: 'No cartão, cada cobrança vira uma parcela na fatura (a conta só é debitada ao pagar a fatura) e não entra em "próximos vencimentos" para não duplicar a fatura.' }),
    field('Devedor que paga (opcional)', 'debtorId', el('select', { id: 'debtorId', name: 'debtorId' }, [
      el('option', { value: '' }, 'Nenhum'),
      ...debtorsCache.filter((d) => (d.status !== 'cancelled' && !d.archived) || d.id === item?.debtorId).map((d) => el('option', { value: d.id, selected: item?.debtorId === d.id }, d.name)),
    ])),
    el('p', { class: 'card__hint', text: 'Com devedor, cada cobrança vira valor a receber dele (parcela na fatura do cartão ou dívida à vista, se não houver cartão). Quando ele pagar, o dinheiro entra na conta escolhida no recebimento; a fatura do cartão é paga à parte.' }),
    el('div', { class: 'form__row' }, [
      field('Conta (opcional)', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, [
        el('option', { value: '' }, 'Sem conta'),
        ...activeAccounts.map((a) => el('option', { value: a.id, selected: item?.accountId === a.id }, accountText(a))),
      ])),
      field('Categoria *', 'categoryId', el('select', { id: 'categoryId', name: 'categoryId', required: true }, [
        el('option', { value: '', disabled: true, selected: !item }, 'Selecione uma categoria'),
        ...expenseCategories.map((c) => el('option', { value: c.id, selected: item?.categoryId === c.id }, categoryLabel(c))),
      ])),
    ]),
    field('Status *', 'status', el('select', { id: 'status', name: 'status', required: true },
      getSubscriptionStatusOptions().map((o) => el('option', { value: o.value, selected: (item?.status ?? 'active') === o.value }, o.label)))),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 3, value: item?.notes ?? '' }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar assinatura' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar assinatura: ${item.name}` : 'Nova assinatura',
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

    const data = new FormData(form);
    const rawData = {
      name: data.get('name').trim(),
      amountCents: data.get('amountCents'),
      periodicity: data.get('periodicity'),
      nextChargeDate: data.get('nextChargeDate'),
      accountId: data.get('accountId') || undefined,
      cardId: data.get('cardId') || undefined,
      debtorId: data.get('debtorId') || undefined,
      categoryId: data.get('categoryId'),
      status: data.get('status'),
      notes: data.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateSubscription(currentUser.uid, item.id, rawData)
      : await createSubscription(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Assinatura atualizada com sucesso.' : 'Assinatura criada com sucesso.');
      closeModal();
      await reload();
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar assinatura';
  }

  form.addEventListener('submit', handleSubmit);
  $('#name', form).focus();
}

function accountLabel(accountId) {
  const account = accountsCache.find((a) => a.id === accountId);
  return account ? accountText(account) : (accountId ?? '—');
}

function showErrors(form, errors) {
  for (const [name, message] of Object.entries(errors)) {
    const errorEl = $(`.form__error[data-for="${name}"]`, form);
    const fieldEl = $(`#${name}`, form);
    if (errorEl) errorEl.textContent = message;
    if (fieldEl) fieldEl.closest('.form__field')?.classList.add('form__field--error');
  }
  if (errors._form) toast(errors._form, 5000);
}
