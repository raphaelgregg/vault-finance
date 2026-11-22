/**
 * Metas — VF-2-03c (UI). Valor guardado, progresso e restante são derivados das movimentações
 * (aportes − resgates); só o alvo/prazo/status da meta são gravados. Aportar/resgatar é atômico.
 */
import { el, toast, refreshIcons } from '../core/ui.js';
import {
  field, iconButton, statCard, panelHeader, emptyBlock, dataTable, progressBar,
  confirmModal, formModal, formatCentsInput, formatDate, optionLabel, selectOptions, todayIso,
} from '../components/form-kit.js';
import {
  listGoals, createGoal, updateGoal, deleteGoal, cancelGoal, reopenGoal,
  depositToGoal, withdrawFromGoal, listGoalTransactions, getGoalStatusOptions,
  allocateLinkedGoalBalances, isAccountLinkedGoal, goalSavedCents, goalProgressPercent, formatCents,
} from '../services/goals.js';
import { listAccounts } from '../services/accounts.js';
import { accountLabel as accountText } from '../core/model.js';
import { loadBalances } from '../services/balances.js';
import { describeError } from '../utils/errors.js';
import { reversalsUnavailable, loadErrorMessage } from '../utils/reversalsAccess.js';
import { newOperationId } from '../services/financeApi.js';

export const meta = { title: 'Metas', icon: 'target' };

let user = null;
let container = null;
let goals = [];
let saved = new Map();
let accounts = [];
let linkedIds = new Set(); // metas em modo "conta vinculada" (progresso = saldo da conta)
let balancesNotice = null;
// Estornos ilegíveis (Rules publicadas sem `reversals`): o guardado das metas é DESCONHECIDO — nunca "0" nem suposto (VF-COR-03).
let limited = false;

export async function render(target, ctx) {
  user = ctx.user;
  container = target;
  try {
    accounts = await listAccounts(user.uid);
    await reload();
  } catch (error) { // o app não aguarda `render`: sem isto, qualquer falha de leitura deixava a tela EM BRANCO
    console.error('[metas] falha ao carregar', error);
    container.replaceChildren(el('div', { class: 'notice', role: 'alert', id: 'goals-load-error' }, [
      el('span', { text: `Não foi possível carregar as metas: ${loadErrorMessage(error, describeError)} ` }),
      el('button', { type: 'button', class: 'btn btn--secondary', id: 'retry-goals', onClick: () => render(target, ctx), text: 'Tentar novamente' }),
    ]));
  }
}

async function reload() {
  goals = await listGoals(user.uid);
  const txs = await Promise.all(goals.map(async (g) => [g.id, await listGoalTransactions(user.uid, g.id, { tolerateReversalsDenied: true })]));
  limited = txs.some(([, list]) => reversalsUnavailable(list));
  saved = new Map(limited ? [] : txs.map(([id, list]) => [id, goalSavedCents(list)]));
  const txCounts = new Map(txs.map(([id, list]) => [id, list.length]));
  // Metas vinculadas a conta: progresso = saldo derivado da conta (alimentado por transferências), repartido
  // entre as metas da mesma conta sem repetir valor. Falha de leitura é isolada: aviso explícito, resto segue.
  linkedIds = new Set(goals.filter((g) => g.status !== 'cancelled' && isAccountLinkedGoal(g, txCounts.get(g.id))).map((g) => g.id));
  balancesNotice = null;
  if (linkedIds.size && !limited) {
    try {
      const { balances } = await loadBalances(user.uid, accounts);
      for (const [id, cents] of allocateLinkedGoalBalances(goals, balances, txCounts)) saved.set(id, cents);
    } catch (error) {
      console.error('[metas] falha ao ler saldos das contas vinculadas', error);
      balancesNotice = `Não foi possível ler o saldo das contas vinculadas (${describeError(error)}); o progresso dessas metas não foi atualizado.`;
    }
  }
  renderPage();
}

const accountLabel = (id) => {
  const a = accounts.find((x) => x.id === id);
  return a ? accountText(a) : '—';
};
const savedOf = (g) => saved.get(g.id) ?? 0;
const showSaved = (g) => (limited ? '—' : formatCents(savedOf(g)));

function renderPage() {
  const live = goals.filter((g) => g.status !== 'cancelled');
  const total = live.reduce((t, g) => t + savedOf(g), 0);
  const header = panelHeader({
    icon: 'target', title: 'Metas financeiras', hint: 'Objetivos, aportes, resgates e progresso.',
    actionLabel: 'Nova meta', onAction: () => openGoalModal(),
  });
  const stats = el('div', { class: 'grid grid--cards' }, [
    statCard('Total acumulado', limited ? '—' : formatCents(total), 'piggy-bank', 'Aportes − resgates, ou saldo da conta vinculada (metas não canceladas)'),
    statCard('Metas ativas', String(goals.filter((g) => g.status === 'active').length), 'target', 'Em andamento'),
    statCard('Concluídas', String(goals.filter((g) => g.status === 'completed').length), 'check-circle-2', 'Alvo atingido'),
  ]);
  const table = goals.length
    ? dataTable({
      columns: [
        { key: 'name', label: 'Meta', render: (v, g) => (linkedIds.has(g.id) ? `${v} · saldo de ${accountLabel(g.accountId)}` : v) },
        { key: 'targetCents', label: 'Objetivo', numeric: true, render: (v) => formatCents(v) },
        { key: 'saved', label: 'Acumulado', numeric: true, render: (_, g) => showSaved(g) },
        { key: 'progress', label: 'Progresso', render: (_, g) => (limited ? '—' : progressBar(goalProgressPercent(savedOf(g), g.targetCents), 'ok', `Progresso de ${g.name}`)) },
        { key: 'percent', label: '%', numeric: true, render: (_, g) => (limited ? '—' : `${goalProgressPercent(savedOf(g), g.targetCents)}%`) },
        { key: 'deadline', label: 'Prazo', render: (v) => formatDate(v) },
        { key: 'status', label: 'Status', render: (v) => optionLabel(getGoalStatusOptions(), v) },
      ],
      rows: goals,
      actions: goalActions,
    })
    : emptyBlock('target', 'Nenhuma meta criada', 'Crie reserva de emergência, viagem ou qualquer objetivo e acompanhe o progresso.');
  const limitedNotice = limited
    ? el('p', { class: 'notice', role: 'alert', id: 'goals-reversals-unavailable', text: 'Limitação: não foi possível ler os estornos (as regras de acesso publicadas ainda não incluem essa coleção). Valor guardado, progresso, aportes e resgates ficam indisponíveis por não serem confiáveis; criar, cancelar e excluir metas continuam disponíveis.' })
    : null;
  const notice = balancesNotice ? el('p', { class: 'notice', role: 'alert', text: balancesNotice }) : null;
  // `replaceChildren(null)` renderiza o TEXTO "null": só nós reais entram (bug da VF-2-03o).
  container.replaceChildren(...[header, limitedNotice, notice, stats, el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Minhas metas' })]),
    el('div', { class: 'panel__body panel__body--flush' }, [table]),
  ])].filter(Boolean));
  refreshIcons();
}

function goalActions(goal) {
  const acts = [];
  if (goal.status === 'active' && !limited && !linkedIds.has(goal.id)) acts.push(iconButton(`Aportar em ${goal.name}`, 'plus-circle', () => openMovementModal(goal, 'deposit'), 'btn--success'));
  if ((goal.status === 'active' || goal.status === 'completed') && savedOf(goal) > 0 && !limited && !linkedIds.has(goal.id)) {
    acts.push(iconButton(`Resgatar de ${goal.name}`, 'minus-circle', () => openMovementModal(goal, 'withdraw')));
  }
  if (goal.status === 'active' && !limited) acts.push(iconButton(`Editar ${goal.name}`, 'edit-2', () => openGoalModal(goal)));
  if (goal.status === 'active') {
    acts.push(iconButton(`Cancelar ${goal.name}`, 'x-circle', () => changeStatus(goal, cancelGoal, 'Meta cancelada.'), 'btn--danger'));
  }
  if (goal.status === 'cancelled' && !limited) acts.push(iconButton(`Reabrir ${goal.name}`, 'rotate-ccw', () => changeStatus(goal, reopenGoal, 'Meta reaberta.'), 'btn--success'));
  acts.push(iconButton(`Excluir ${goal.name}`, 'trash-2', () => confirmModal({
    title: 'Excluir meta', message: `Excluir "${goal.name}"?`,
    hint: 'Só é possível sem movimentações; para manter o histórico, cancele.', confirmLabel: 'Excluir',
    onConfirm: async () => {
      const r = await deleteGoal(user.uid, goal.id);
      if (r.ok) { toast('Meta excluída.'); await reload(); } else toast(r.errors._form, 6000);
    },
  }), 'btn--danger'));
  return acts;
}

async function changeStatus(goal, fn, okMessage) {
  const r = await fn(user.uid, goal.id);
  if (r.ok) { toast(okMessage); await reload(); } else toast(r.errors._form, 6000);
}

function openGoalModal(goal = null) {
  const isEdit = !!goal;
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a.id) }));
  formModal({
    title: isEdit ? `Editar meta: ${goal.name}` : 'Nova meta',
    formId: 'goal-form',
    submitLabel: isEdit ? 'Salvar alterações' : 'Criar meta',
    focusId: 'name',
    fields: [
      field('Nome *', 'name', el('input', { type: 'text', id: 'name', name: 'name', maxlength: 80, value: goal?.name ?? '', autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Objetivo (R$) *', 'targetCents', el('input', { type: 'text', id: 'targetCents', name: 'targetCents', placeholder: '0,00', value: goal ? formatCentsInput(goal.targetCents) : '', autocomplete: 'off' })),
        field('Prazo', 'deadline', el('input', { type: 'date', id: 'deadline', name: 'deadline', value: goal?.deadline ?? '' })),
      ]),
      field('Conta vinculada', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, [el('option', { value: '' }, 'Nenhuma'), ...selectOptions(activeAccounts, goal?.accountId)])),
      el('p', { class: 'card__hint', text: 'Conta vinculada (ex.: caixinha ou investimento): o progresso segue o saldo dela, alimentado por Transferências; metas na mesma conta repartem o saldo em ordem de criação. Sem conta, use aportes e resgates.' }),
      field('Descrição', 'description', el('textarea', { id: 'description', name: 'description', maxlength: 300, rows: 2, value: goal?.description ?? '' })),
    ],
    submit: (d) => {
      const raw = {
        name: d.get('name').trim(), targetCents: d.get('targetCents'), deadline: d.get('deadline') || undefined,
        accountId: d.get('accountId') || undefined, description: d.get('description').trim() || undefined,
      };
      return isEdit ? updateGoal(user.uid, goal.id, raw) : createGoal(user.uid, raw);
    },
    onDone: async () => { toast(isEdit ? 'Meta atualizada.' : 'Meta criada.'); await reload(); },
  });
}

function openMovementModal(goal, type) {
  const isDeposit = type === 'deposit';
  const operationId = newOperationId(); // idempotência: duplo clique/retry desta abertura não duplica o aporte
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a.id) }));
  formModal({
    title: `${isDeposit ? 'Aportar em' : 'Resgatar de'} ${goal.name}`,
    formId: 'goal-move-form',
    submitLabel: isDeposit ? 'Aportar' : 'Resgatar',
    focusId: 'amountCents',
    fields: [
      el('p', { class: 'card__hint', text: `Guardado: ${formatCents(savedOf(goal))} de ${formatCents(goal.targetCents)}.` }),
      field('Valor (R$) *', 'amountCents', el('input', { type: 'text', id: 'amountCents', name: 'amountCents', placeholder: '0,00', autocomplete: 'off' })),
      field('Data *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
      field(isDeposit ? 'Conta de origem *' : 'Conta de destino *', 'accountId', el('select', { id: 'accountId', name: 'accountId' },
        selectOptions(activeAccounts, goal.accountId, { placeholder: 'Selecione uma conta' }))),
      field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 300, rows: 2 })),
    ],
    submit: (d) => (isDeposit ? depositToGoal : withdrawFromGoal)(user.uid, goal.id, {
      amountCents: d.get('amountCents'), date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined, operationId,
    }),
    onDone: async (r) => {
      toast(r.status === 'completed' && isDeposit ? 'Aporte registrado — meta concluída!' : (isDeposit ? 'Aporte registrado.' : 'Resgate registrado.'));
      await reload();
    },
  });
}
