/**
 * Bancos/Contas — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista contas (até 200); saldo atual derivado calculado sob demanda (botão), saldo inicial sempre visível
 * - Modal para criar/editar conta
 * - Validação client-side espelhando Security Rules
 * - Persistência em users/{uid}/accounts
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { openModal, closeModal } from '../components/modal.js';
import { createStatCard } from '../components/stat-card.js';
import { formatCentsInput, clearErrors, showFormErrors as showErrors } from '../components/form-kit.js';
import { accountLabel } from '../core/model.js';
import { newOperationId } from '../services/financeApi.js';
import { isPermissionDenied } from '../utils/reversalsAccess.js';
import { loadBalances, READ_LIMIT } from '../services/balances.js';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  archiveAccount,
  unarchiveAccount,
  getAccountTypeOptions,
  getStatusOptions,
  adjustOpeningBalance,
  computeOpeningAdjustment,
  formatCents,
  parseMoneyToCents,
} from '../services/accounts.js';

export const meta = { title: 'Bancos', icon: 'landmark' };

let currentUser = null;
let accountsCache = [];
let balanceError = null; // { kind: 'denied' | 'error', text } — por que o saldo atual está indisponível (nunca presumir "sem estornos")
let showArchived = false; // contas arquivadas (arquivamento lógico) ficam ocultas por padrão
/** Teto de contas listadas (VF-4-03); ao atingir, a página avisa. */
const ACCOUNT_LIST_LIMIT = 200;
/** Saldos derivados, calculados SOB DEMANDA (lê movimentos; poupa a cota de leituras): null = não calculado. */
let derived = null;

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  await loadData();
  renderPage(container);
}

/** Carrega dados iniciais. */
async function loadData() {
  accountsCache = await listAccounts(currentUser.uid, { limit: ACCOUNT_LIST_LIMIT });
  derived = null; // dados mudaram: o saldo derivado anterior ficou obsoleto
  await calculateBalances({ silent: true }); // saldo atual calculado ao abrir (e a cada recarga), não só sob demanda
}

/**
 * Calcula o saldo atual derivado (receitas recebidas, despesas pagas, transferências, recebimentos, metas, faturas).
 * Falha na leitura não derruba a página: o saldo atual fica indisponível e a tela avisa.
 */
async function calculateBalances({ silent = false } = {}) {
  try {
    derived = await loadBalances(currentUser.uid, accountsCache);
    balanceError = null;
  } catch (error) {
    console.error('[bancos] falha ao calcular saldos', error);
    derived = null; // NUNCA manter o saldo anterior nem calcular com leitura incompleta (estornos podem alterá-lo)
    balanceError = describeBalanceError(error);
    if (!silent) {
      toast(balanceError.toast, 6000);
      renderPage($('.content') || document.getElementById('page-content')); // redesenha: o saldo exibido antes NÃO pode permanecer na tela
    }
    return;
  }
  if (!silent) renderPage($('.content') || document.getElementById('page-content'));
  if (derived.truncated.length) toast('Leitura limitada: o saldo pode estar incompleto.', 6000);
}

/**
 * Por que o saldo atual não pôde ser determinado. Leitura negada (Rules publicadas sem a coleção de estornos) e erro de
 * conexão são estados DISTINTOS e explícitos; nenhum deles vira "zero" nem "sem estornos".
 */
function describeBalanceError(error) {
  if (isPermissionDenied(error) || error?.code === 'reversals-unavailable') {
    return {
      kind: 'denied',
      toast: 'Saldo atual indisponível: leitura de movimentações/estornos negada.',
      text: 'Saldo atual indisponível: a leitura das movimentações (incluindo estornos) foi negada pelas regras de acesso publicadas. Nenhum saldo é exibido porque não é possível saber se há estornos que o alteram.',
    };
  }
  return {
    kind: 'error',
    toast: 'Saldo atual indisponível: erro ao ler as movimentações.',
    text: 'Saldo atual indisponível: erro de conexão ou indisponibilidade ao ler as movimentações (incluindo estornos). Nenhum saldo é exibido até a leitura completa. Tente novamente.',
  };
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'landmark', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Bancos e contas' }),
        el('p', { class: 'card__hint', text: 'Saldo atual = saldo de abertura + entradas − saídas (calculado das movimentações; nada é gravado).' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        id: 'calc-balances',
        onClick: calculateBalances,
        text: derived ? 'Recalcular saldo atual' : 'Calcular saldo atual',
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openAccountModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova conta',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Saldo total', stats.totalBalance === null ? '—' : formatCents(stats.totalBalance), 'wallet', 'income', derived
      ? 'Saldo atual derivado das movimentações (contas ativas)'
      : (balanceError ? 'Saldo atual indisponível (veja o aviso abaixo)' : 'Saldo atual ainda não calculado. Use "Calcular saldo atual".')),
    createStatCard('Contas ativas', String(stats.activeCount), 'landmark', null, 'Contas com status "ativo"'),
  ]);

  const table = createAccountsTable();

  const limitNotice = accountsCache.length >= ACCOUNT_LIST_LIMIT
    ? el('p', { class: 'notice', role: 'status', text: `Exibindo as primeiras ${ACCOUNT_LIST_LIMIT} contas (limite de leitura).` })
    : null;
  const balanceErrorNotice = !derived && balanceError
    ? el('div', { class: 'notice', role: 'alert', id: 'balance-unavailable', 'data-kind': balanceError.kind }, [
      el('span', { text: balanceError.text }),
      el('button', { type: 'button', class: 'btn btn--secondary', id: 'retry-balances', onClick: calculateBalances, text: 'Tentar novamente' }),
    ])
    : null;
  const orphanNotice = derived?.orphans?.count
    ? el('p', { class: 'notice', role: 'status', text: `${derived.orphans.count} movimentação(ões) apontam para uma conta que não existe mais e ficam fora de qualquer saldo (${Object.entries(derived.orphans.byCollection).map(([k, n]) => `${k}: ${n}`).join(', ')}). Revise-as ou recrie a conta.` })
    : null;
  const balanceNotice = derived?.truncated.length
    ? el('p', { class: 'notice', role: 'status', text: `Leitura limitada a ${READ_LIMIT} movimentos por tipo (${derived.truncated.join(', ')}): o saldo atual pode estar incompleto.` })
    : null;

  const nodes = [
    header,
    cards,
    limitNotice,
    balanceErrorNotice,
    balanceNotice,
    orphanNotice,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Contas cadastradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('label', { class: 'form__check' }, [
          el('input', { type: 'checkbox', id: 'show-archived-accounts', ...(showArchived ? { checked: 'checked' } : {}), onChange: (e) => { showArchived = e.target.checked; renderPage($('.content') || document.getElementById('page-content')); } }),
          el('span', { text: ' Mostrar arquivadas' }),
        ]),
        el('span', { class: 'badge', text: `${accountsCache.length} registro${accountsCache.length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
  ];

  container.replaceChildren(...nodes.filter(Boolean));
  refreshIcons();
}

/** Computa estatísticas rápidas. */
function computeStats() {
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');
  // Saldo total: SÓ o derivado das movimentações (com estornos). Sem ele, indisponível (null) — nunca a soma dos saldos de abertura.
  const totalBalance = derived ? activeAccounts.reduce((sum, acc) => sum + (derived.balances.get(acc.id) ?? 0), 0) : null;
  return { totalBalance, activeCount: activeAccounts.length };
}

/** Cria a tabela de contas. */
function createAccountsTable() {
  if (!accountsCache.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'landmark', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma conta cadastrada' }),
      el('p', { class: 'empty__text', text: 'Cadastre sua primeira instituição para começar a acompanhar entradas e saídas.' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openAccountModal(),
        text: 'Criar primeira conta',
      }),
    ]);
  }

  const columns = [
    { key: 'institution', label: 'Instituição' },
    { key: 'name', label: 'Conta', render: (v) => v || '—' },
    { key: 'type', label: 'Tipo', render: (v) => getTypeLabel(v) },
    { key: 'initialBalanceCents', label: 'Saldo de abertura', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    ...(derived ? [{ key: 'id', label: 'Saldo atual', numeric: true, render: (v) => formatCents(derived.balances.get(v) ?? 0) }] : []),
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const shownAccounts = showArchived ? accountsCache : accountsCache.filter((a) => a.status !== 'archived');
  const bodyWithActions = shownAccounts.map((account) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = account[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, [
        derived ? el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `Ajustar saldo de ${account.name || account.institution}`,
          title: 'Ajustar saldo de abertura para o valor real da conta',
          onClick: () => openAdjustModal(account),
          html: '<i data-lucide="scale" aria-hidden="true"></i>',
        }) : null,
        el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `Editar ${account.name || account.institution}`,
          onClick: () => openAccountModal(account),
          html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `${account.status === 'archived' ? 'Desarquivar' : 'Arquivar'} ${account.name || account.institution}`,
          title: account.status === 'archived' ? 'Desarquivar (volta a receber lançamentos)' : 'Arquivar (preserva o histórico; deixa de receber lançamentos)',
          onClick: () => toggleArchive(account),
          html: `<i data-lucide="${account.status === 'archived' ? 'archive-restore' : 'archive'}" aria-hidden="true"></i>`,
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--icon btn--danger',
          'aria-label': `Excluir ${account.name || account.institution}`,
          onClick: () => confirmDeleteAccount(account),
          html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
        }),
      ]),
    ])
  );

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/**
 * Ajuste guiado do saldo de abertura: o usuário informa quanto a conta tem AGORA e (opcional) desde que data os
 * lançamentos valem; mostra o antes/depois e só grava `initialBalanceCents` (e `openingDate`) após confirmar.
 */
function openAdjustModal(account) {
  const operationId = newOperationId(); // idempotência do ajuste: duplo clique/retry desta abertura não ajusta duas vezes
  const current = derived?.balances.get(account.id) ?? 0;
  const preview = el('p', { class: 'card__hint', role: 'status' });
  const form = el('form', { id: 'adjust-form', novalidate: true }, [
    el('p', { text: `Saldo atual calculado: ${formatCents(current)} (abertura ${formatCents(Number(account.initialBalanceCents) || 0)}).` }),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'realBalance', text: 'Saldo real da conta agora (R$) *' }),
      el('input', { type: 'text', id: 'realBalance', name: 'realBalance', placeholder: '0,00', autocomplete: 'off' }),
      el('span', { class: 'form__error', 'data-for': 'realBalance' }),
    ]),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'adjustOpeningDate', text: 'Considerar movimentações a partir de (opcional)' }),
      el('input', { type: 'date', id: 'adjustOpeningDate', name: 'openingDate', value: account.openingDate ?? '' }),
      el('span', { class: 'form__error', 'data-for': 'openingDate' }),
    ]),
    preview,
    el('p', { class: 'card__hint', text: 'Só o saldo de abertura desta conta muda; nenhuma receita, despesa ou transferência é alterada.' }),
  ]);
  const modal = openModal({
    title: `Ajustar saldo: ${accountLabel(account)}`,
    body: form,
    footer: [
      el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
      el('button', { type: 'submit', class: 'btn btn--primary', text: 'Confirmar ajuste' }),
    ],
    onClose: () => form.removeEventListener('submit', handleAdjust),
  });
  const realInput = $('#realBalance', modal.overlay);
  const dateInput = $('#adjustOpeningDate', modal.overlay);
  const updatePreview = () => {
    const real = parseMoneyToCents(realInput.value);
    if (real === null || !derived) { preview.textContent = ''; return; }
    const r = computeOpeningAdjustment({ ...account, openingDate: dateInput.value || undefined }, derived.movements, real);
    preview.textContent = `Abertura: ${formatCents(Number(account.initialBalanceCents) || 0)} → ${formatCents(r.newInitialCents)} (movimentações ${formatCents(r.movementsCents)}); saldo atual passará a ${formatCents(real)}.`;
  };
  realInput.addEventListener('input', updatePreview);
  dateInput.addEventListener('change', updatePreview);

  async function handleAdjust(event) {
    event.preventDefault();
    clearErrors(form);
    const result = await adjustOpeningBalance(currentUser.uid, account.id, realInput.value, { openingDate: dateInput.value || null, operationId });
    if (result.ok) {
      toast(`Saldo de abertura ajustado para ${formatCents(result.newInitialCents)}.`);
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
  }
  form.addEventListener('submit', handleAdjust);
  realInput.focus();
}

/** Abre modal para criar/editar conta. */
function openAccountModal(account = null) {
  const isEdit = !!account;
  const types = getAccountTypeOptions();
  const statuses = getStatusOptions();

  const form = el('form', { id: 'account-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'institution', text: 'Instituição *' }),
        el('input', {
          type: 'text',
          id: 'institution',
          name: 'institution',
          required: true,
          maxlength: 80,
          value: account?.institution ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'institution' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'name', text: 'Conta' }),
        el('input', {
          type: 'text',
          id: 'name',
          name: 'name',
          maxlength: 80,
          value: account?.name ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'name' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'type', text: 'Tipo *' }),
        el('select', {
          id: 'type',
          name: 'type',
          required: true,
        }, types.map((t) =>
          el('option', { value: t.value, selected: account?.type === t.value }, t.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'type' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: account?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'initialBalanceCents', text: 'Saldo de abertura (R$)' }),
        el('input', {
          type: 'text',
          id: 'initialBalanceCents',
          name: 'initialBalanceCents',
          value: account?.initialBalanceCents ? formatCentsInput(account.initialBalanceCents) : '',
          placeholder: '0,00',
          autocomplete: 'off',
          ...(isEdit ? { readonly: 'readonly', 'aria-describedby': 'initialBalanceHint' } : {}),
        }),
        el('span', { class: 'card__hint', id: 'initialBalanceHint', text: isEdit
          ? 'O saldo de abertura não é editado aqui: use "Ajustar saldo" (ajuste auditado, feito pelo servidor).'
          : 'Dinheiro que a conta já tinha quando você começou a usar o Vault. O saldo atual soma as movimentações a este valor.' }),
        el('span', { class: 'form__error', 'data-for': 'initialBalanceCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'openingDate', text: 'Data de abertura' }),
        el('input', { type: 'date', id: 'openingDate', name: 'openingDate', value: account?.openingDate ?? '', ...(isEdit ? { readonly: 'readonly' } : {}) }),
        el('span', { class: 'card__hint', text: 'Opcional. Com data, só movimentações a partir dela entram no saldo; vazio = todas.' }),
        el('span', { class: 'form__error', 'data-for': 'openingDate' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'color', text: 'Cor (hex)' }),
        el('input', {
          type: 'color',
          id: 'color',
          name: 'color',
          value: account?.color ?? '#1f7a5c',
        }),
      ]),
    ]),
  ]);

  const footer = [
    el('button', {
      type: 'button',
      class: 'btn btn--secondary',
      onClick: closeModal,
      text: 'Cancelar',
    }),
    el('button', {
      type: 'submit',
      class: 'btn btn--primary',
      text: isEdit ? 'Salvar alterações' : 'Criar conta',
    }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar conta: ${accountLabel(account)}` : 'Nova conta',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  // Formatação de dinheiro no input
  const moneyInput = $('#initialBalanceCents', modal.overlay);
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
      institution: formData.get('institution').trim(),
      name: formData.get('name').trim(),
      type: formData.get('type'),
      initialBalanceCents: formData.get('initialBalanceCents') || '0',
      openingDate: formData.get('openingDate') || undefined,
      color: formData.get('color') || '#1f7a5c',
      status: formData.get('status'),
    };

    clearErrors(form);
    const result = isEdit
      ? await updateAccount(currentUser.uid, account.id, rawData)
      : await createAccount(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Conta atualizada com sucesso.' : 'Conta criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar conta';
  }

  form.addEventListener('submit', handleSubmit);
  $('#institution', form).focus();
}

/** Arquivamento LÓGICO (servidor): nenhuma exclusão física; o histórico segue consultável. */
async function toggleArchive(account) {
  const result = account.status === 'archived' ? await unarchiveAccount(currentUser.uid, account.id) : await archiveAccount(currentUser.uid, account.id);
  if (result.ok) {
    toast(account.status === 'archived' ? 'Conta desarquivada.' : 'Conta arquivada: o histórico foi preservado.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form ?? 'Não foi possível alterar o arquivamento.', 5000);
  }
}

/** Confirma exclusão de conta. */
function confirmDeleteAccount(account) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a conta "${accountLabel(account)}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Contas com movimentações vinculadas não podem ser excluídas — nesse caso, arquive a conta (status "Arquivada").' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteAccount(currentUser.uid, account.id);
        if (result.ok) {
          toast('Conta excluída.');
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

function getTypeLabel(value) {
  const types = getAccountTypeOptions();
  const found = types.find((t) => t.value === value);
  return found?.label ?? value;
}

function getStatusLabel(value) {
  const statuses = getStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}
