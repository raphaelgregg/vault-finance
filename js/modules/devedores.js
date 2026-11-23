/**
 * Devedores — VF-2-03b: CRUD integrado ao Firestore (users/{uid}/debtors).
 * Pendente = emprestado − recebido (derivado, nunca gravado). Parcelas e recebimentos: devedores-parcelas.js (VF-2-03b2).
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listDebtors,
  createDebtor,
  updateDebtor,
  deleteDebtor,
  archiveDebtor,
  unarchiveDebtor,
  cancelDebtor,
  reopenDebtor,
  getDebtorStatusOptions,
  loadDebtorStatements,
  summarizeDebtors,
  debtorPendingCents,
  formatCents,
  parseMoneyToCents,
} from '../services/debtors.js';

import { openDebtorInstallments } from './devedores-parcelas.js';

import { todayInAppZone, currentMonthKey } from '../utils/dates.js';
import { isPermissionDenied } from '../utils/reversalsAccess.js';
import { clearErrors, formatCentsInput, formatDate, formatMonth, optionLabel } from '../components/form-kit.js';
export const meta = { title: 'Devedores', icon: 'users' };

let currentUser = null;
let container = null;
let showArchived = false;
let debtorsCache = [];
let statements = new Map(); // fechamento do mês por devedor (VF-2-03j)
let statementsFailed = false;
let statementsDenied = false; // falha por leitura NEGADA (Rules publicadas sem `reversals`) × erro de conexão
let month = currentMonthKey();

export async function render(target, { user }) {
  currentUser = user;
  container = target;
  await reload();
}

async function reload() {
  debtorsCache = await listDebtors(currentUser.uid);
  await reloadStatements();
  renderPage();
}

/** Isolado: falha no fechamento não esconde a lista de devedores (mostra aviso e "—"). */
async function reloadStatements() {
  try {
    statements = await loadDebtorStatements(currentUser.uid, debtorsCache, month);
    statementsFailed = false;
    statementsDenied = false;
  } catch (error) {
    console.error('[devedores] falha ao calcular o fechamento do mês', error);
    statements = new Map();
    statementsFailed = true;
    statementsDenied = isPermissionDenied(error) || error?.code === 'reversals-unavailable';
  }
}

function renderPage() {
  const summary = summarizeDebtors(debtorsCache);
  const count = debtorsCache.length;

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'users', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Devedores' }),
        el('p', { class: 'card__hint', text: 'Empréstimos pessoais e saldo pendente por pessoa.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openDebtorModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Novo devedor',
      }),
    ]),
  ]);

  const monthTotal = [...statements.values()].reduce((t, st) => t + st.totalCents, 0);
  const monthInput = el('input', {
    type: 'month', id: 'closing-month', value: month, 'aria-label': 'Mês de fechamento',
    onChange: async (event) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
      month = event.target.value;
      await reloadStatements();
      renderPage();
    },
  });
  const monthBar = el('div', { class: 'form__field' }, [el('label', { for: 'closing-month', text: 'Mês de fechamento' }), monthInput]);
  const failedNotice = statementsFailed
    ? el('div', { class: 'notice', role: 'alert', id: 'closing-unavailable', 'data-kind': statementsDenied ? 'denied' : 'error' }, [
      el('span', { text: `Não foi possível calcular o fechamento do mês: ${statementsDenied
        ? 'a leitura dos recebimentos e estornos foi negada pelas regras de acesso publicadas, então não é possível saber o que já foi recebido.'
        : 'erro de conexão ou indisponibilidade ao ler recebimentos e estornos.'} Nenhum total é exibido. A lista de devedores continua válida. ` }),
      el('button', { type: 'button', class: 'btn btn--secondary', id: 'retry-closing', onClick: async () => { await reloadStatements(); renderPage(); }, text: 'Tentar novamente' }),
    ])
    : null;

  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard(`A receber em ${formatMonth(month)}`, statementsFailed ? '—' : formatCents(monthTotal), 'calendar-check',
      'Cartão (fatura do mês) + parcelas de empréstimo do mês, limitado ao pendente de cada devedor'),
    statCard('A receber', formatCents(summary.pendingCents), 'hand-coins', `Saldo pendente de ${summary.openCount} em aberto`),
    statCard('Recebido', formatCents(summary.receivedCents), 'check-circle-2', 'Total já devolvido (não cancelados)'),
  ]);

  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Devedores cadastrados' }),
      el('div', { class: 'topbar__spacer' }),
      el('label', { class: 'form__check' }, [
        el('input', { type: 'checkbox', id: 'show-archived-debtors', ...(showArchived ? { checked: 'checked' } : {}), onChange: (e) => { showArchived = e.target.checked; renderPage(); } }),
        el('span', { text: ' Mostrar arquivados' }),
      ]),
      el('span', { class: 'badge', text: `${count} registro${count !== 1 ? 's' : ''}` }),
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [createTableOrEmpty()]),
  ]);

  container.replaceChildren(header, monthBar, failedNotice, cards, panel);
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
  const shown = showArchived ? debtorsCache : debtorsCache.filter((d) => !d.archived);
  if (!shown.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'users', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhum devedor cadastrado' }),
      el('p', { class: 'empty__text', text: 'Registre valores emprestados para acompanhar o saldo pendente por pessoa.' }),
    ]);
  }

  const columns = [
    { key: 'name', label: 'Pessoa' },
    { key: 'loanDate', label: 'Empréstimo', render: (v) => formatDate(v) },
    { key: 'lentCents', label: 'Emprestado', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'receivedCents', label: 'Recebido', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'pending', label: 'Pendente', numeric: true, render: (_, item) => formatCents(debtorPendingCents(item)) },
    {
      key: 'monthDue', label: `A receber em ${formatMonth(month)}`, numeric: true, strong: true,
      render: (_, item) => (statementsFailed || item.status !== 'open' ? '—' : formatCents(statements.get(item.id)?.totalCents ?? 0)),
    },
    { key: 'status', label: 'Status', render: (v, item) => `${optionLabel(getDebtorStatusOptions(), v)}${item?.archived ? ' · arquivado' : ''}` },
  ];

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
          el('th', { text: 'Ações' }),
        ]),
      ]),
      el('tbody', {}, shown.map((item) =>
        el('tr', {}, [
          ...columns.map((c) => {
            const text = c.render ? c.render(item[c.key], item) : (item[c.key] ?? '—');
            return el('td', { class: c.numeric ? 'num' : '' }, c.strong ? [el('strong', { text })] : [text]);
          }),
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

function createActions(item) {
  const actions = [
    iconButton(`Parcelas e recebimentos de ${item.name}`, 'list-checks', () => openDebtorInstallments({ user: currentUser, debtor: item, onChange: reload })),
  ];
  // Aberto OU quitado: nova dívida (reabre o quitado) e edição ficam disponíveis; cancelar só de quem está em aberto.
  if (item.status === 'open' || item.status === 'paid') {
    actions.push(iconButton(`Nova dívida para ${item.name}`, 'plus-circle', () => openDebtorInstallments({ user: currentUser, debtor: item, onChange: reload, startCreate: true }), 'btn--success'));
    actions.push(iconButton(`Editar ${item.name}`, 'edit-2', () => openDebtorModal(item)));
  }
  if (item.status === 'open') {
    actions.push(iconButton(`Cancelar ${item.name}`, 'x-circle', () => confirmCancel(item), 'btn--danger'));
  }
  if (item.status === 'cancelled') {
    actions.push(iconButton(`Reabrir ${item.name}`, 'rotate-ccw', () => changeStatus(item, reopenDebtor, 'Devedor reaberto.'), 'btn--success'));
  }
  // Arquivamento LÓGICO (VF-ARQ-02): preserva dívidas e recebimentos; só devedor quitado/cancelado.
  if (item.archived) actions.push(iconButton(`Desarquivar ${item.name}`, 'archive-restore', () => changeStatus(item, unarchiveDebtor, 'Devedor desarquivado.'), 'btn--success'));
  else if (item.status !== 'open') actions.push(iconButton(`Arquivar ${item.name}`, 'archive', () => changeStatus(item, archiveDebtor, 'Devedor arquivado: o histórico foi preservado.')));
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
    el('p', { text: `Cancelar o registro de "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'O valor deixa de contar em "A receber". Você pode reabrir depois.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Voltar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        await changeStatus(item, cancelDebtor, 'Devedor cancelado.');
      },
      text: 'Cancelar registro',
    }),
  ];
  openModal({ title: 'Confirmar cancelamento', body, footer });
}

function confirmDelete(item) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Para manter o histórico, prefira cancelar.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteDebtor(currentUser.uid, item.id);
        if (result.ok) {
          toast('Devedor excluído.');
          await reload();
        } else {
          toast(`Erro: ${result.errors._form}`, 6000);
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

function openDebtorModal(item = null) {
  const isEdit = !!item;
  const today = todayInAppZone();

  const form = el('form', { id: 'debtor-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      field('Pessoa *', 'name', el('input', {
        type: 'text', id: 'name', name: 'name', required: true, maxlength: 80,
        value: item?.name ?? '', autocomplete: 'off',
      })),
      field('Valor emprestado (R$)', 'lentCents', el('input', {
        type: 'text', id: 'lentCents', name: 'lentCents', placeholder: '0,00 (opcional)',
        value: item?.lentCents ? formatCentsInput(item.lentCents) : '', autocomplete: 'off',
      })),
    ]),
    field('Data do empréstimo / cadastro *', 'loanDate', el('input', {
      type: 'date', id: 'loanDate', name: 'loanDate', required: true, value: item?.loanDate ?? today,
    })),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 3, value: item?.notes ?? '' }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar devedor' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar devedor: ${item.name}` : 'Novo devedor',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#lentCents', modal.overlay);
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
      lentCents: data.get('lentCents'),
      loanDate: data.get('loanDate'),
      notes: data.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateDebtor(currentUser.uid, item.id, rawData)
      : await createDebtor(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Devedor atualizado com sucesso.' : 'Devedor criado com sucesso.');
      closeModal();
      await reload();
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar devedor';
  }

  form.addEventListener('submit', handleSubmit);
  $('#name', form).focus();
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
