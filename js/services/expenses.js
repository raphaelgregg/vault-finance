/**
 * Serviço de Despesas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/expenses.
 */
import { COLLECTIONS, RECURRENCES } from '../utils/constants.js';
import { todayInAppZone, monthBounds } from '../utils/dates.js';
import {
  list,
  getById,
  updateAudited,
  commitAtomic,
} from './firestore.js';
import { financeResult } from './financeApi.js';
import {
  buildEntity,
  checkCategoryForMovement,
  SCHEMAS,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.expenses;
const CATEGORY_COLLECTION = COLLECTIONS.categories;
// Tipos aceitos vêm do schema (fonte única: kindCompat).
const ALLOWED_CATEGORY_KINDS = SCHEMAS.expenses.fields.categoryId.kindCompat;

/** Leitura autoritativa da categoria no Firestore do próprio usuário. */
async function fetchCategory(uid, categoryId) {
  return getById(uid, CATEGORY_COLLECTION, categoryId);
}

/**
 * Coerência status × data de pagamento. `paid` sempre tem `paidDate` (padrão: hoje em America/Sao_Paulo — sem ela a
 * despesa paga contava no saldo mas sumia do resultado do mês); qualquer outro status NÃO guarda `paidDate`
 * (antes, editar paga → pendente/cancelada deixava uma data de pagamento órfã). Na atualização o campo é removido
 * (`null` → deleteField); na criação é simplesmente omitido. Puro (exceto o "hoje" padrão).
 */
export function settleDates(data, forUpdate) {
  if (data.status === 'paid') return { ...data, paidDate: data.paidDate ?? todayInAppZone() };
  const { paidDate: _discarded, ...rest } = data;
  return forUpdate ? { ...rest, paidDate: null } : rest;
}

/** Lista despesas com filtros opcionais. */
export async function listExpenses(uid, options = {}) {
  const constraints = { orderBy: ['dueDate', 'asc'] };
  if (options.where) constraints.where = options.where;
  if (options.orderBy) constraints.orderBy = options.orderBy;
  if (options.startAfterId) constraints.startAfterId = options.startAfterId;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/**
 * Todos os lançamentos do mês "AAAA-MM" (por `dueDate`), sem depender da página carregada. Teto de 1000 (cota);
 * `truncated` avisa se o mês tem mais que isso. Usa só o índice simples do campo (sem índice composto novo).
 */
export async function listExpensesOfMonth(uid, month, io = {}) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error('Mês inválido.');
  const LIMIT = 1000;
  const items = await (io.list ?? listExpenses)(uid, {
    where: [['dueDate', '>=', bounds.start], ['dueDate', '<=', bounds.end]],
    orderBy: ['dueDate', 'desc'],
    limit: LIMIT,
  });
  return { items, truncated: items.length >= LIMIT };
}

/** Busca uma despesa por ID. */
export async function getExpense(uid, expenseId) {
  return getById(uid, COLLECTION, expenseId);
}

const finance = (io) => io.finance ?? financeResult;
const SETTLED_IMMUTABLE = 'Despesa paga não pode ser alterada nem excluída: estorne-a (lançamento compensatório).';

/** Campos enviados ao servidor (sem status derivado do cliente além do pedido de criação). */
function movementParams(data) {
  const params = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || ['createdAt', 'updatedAt', 'id', 'operationId'].includes(key)) continue;
    params[key] = value;
  }
  return params;
}

/**
 * Cria uma despesa NO SERVIDOR (VF-ARQ-02): categoria/conta validadas e saldo derivado dentro da transação; despesa já
 * `paid` sai do saldo atomicamente. `rawData.operationId`: chave de idempotência (gere ao abrir o formulário).
 * Ordem: modelo → compatibilidade de categoria (feedback imediato; o servidor revalida) → servidor.
 * Retorna { ok, id, errors, code }.
 */
export async function createExpense(uid, rawInput, deps = {}) {
  const { operationId, ...rawData } = rawInput ?? {};
  const built = buildEntity('expenses', rawData);
  if (!built.ok) return { ok: false, errors: built.errors };
  const data = settleDates(built.data, false);

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const r = await finance(deps)('expense.create', movementParams(data), { operationId, ...(deps.apiOptions ?? {}) });
  return r.ok ? { ok: true, id: r.id, result: r } : r;
}

/**
 * Atualiza uma despesa NÃO paga. Paga é imutável (estorne). Pedir `paid` grava os campos como pendentes e
 * confirma o pagamento no servidor.
 */
export async function updateExpense(uid, expenseId, rawData, deps = {}) {
  const built = buildEntity('expenses', rawData);
  if (!built.ok) return { ok: false, errors: built.errors };
  const data = settleDates(built.data, true);

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const current = await (deps.getById ?? getById)(uid, COLLECTION, expenseId);
  if (!current) return { ok: false, errors: { _form: 'Despesa não encontrada.' } };
  if (current.status === 'paid') return { ok: false, errors: { _form: SETTLED_IMMUTABLE } };
  const wantsPay = data.status === 'paid';
  const { paidDate, ...rest } = data;
  await updateAudited(uid, COLLECTION, expenseId, wantsPay ? { ...rest, status: 'pending', paidDate: null } : data, deps);
  if (wantsPay) return markExpensePaid(uid, expenseId, paidDate ?? null, deps);
  return { ok: true };
}

/** Exclui uma despesa NÃO paga (paga: estorne). */
export async function deleteExpense(uid, expenseId, io = {}) {
  const expense = await (io.getById ?? getById)(uid, COLLECTION, expenseId);
  if (!expense) return { ok: false, errors: { _form: 'Despesa não encontrada.' } };
  if (expense.status === 'paid') return { ok: false, errors: { _form: SETTLED_IMMUTABLE } };
  await (io.commitAtomic ?? commitAtomic)(uid, [{ type: 'delete', collection: COLLECTION, docId: expenseId, before: expense }], io);
  return { ok: true, reversedCents: 0, accountId: null };
}

/** Marca a despesa como paga NO SERVIDOR (status e saldo atômicos, idempotente). */
export async function markExpensePaid(uid, expenseId, paidDate = null, io = {}) {
  const r = await finance(io)('expense.pay', { id: expenseId, ...(paidDate ? { date: paidDate } : {}) }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, result: r } : r;
}

/** Marca despesa como cancelada. */
export async function cancelExpense(uid, expenseId, io = {}) {
  const current = await (io.getById ?? getById)(uid, COLLECTION, expenseId);
  if (!current) return { ok: false, errors: { _form: 'Despesa não encontrada.' } };
  if (current.status !== 'pending') return { ok: false, errors: { _form: 'Só é possível cancelar uma despesa pendente (despesa paga: edite ou exclua).' } };
  await updateAudited(uid, COLLECTION, expenseId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

/** Opções de recorrência para <select>. */
export function getRecurrenceOptions() {
  return RECURRENCES.map((r) => ({ value: r.value, label: r.label }));
}

/** Status options for expense. */
export function getExpenseStatusOptions() {
  return [
    { value: 'pending', label: 'Pendente' },
    { value: 'paid', label: 'Paga' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };
