/**
 * Serviço de Receitas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/incomes.
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

const COLLECTION = COLLECTIONS.incomes;
const CATEGORY_COLLECTION = COLLECTIONS.categories;
// Tipos aceitos vêm do schema (fonte única: kindCompat).
const ALLOWED_CATEGORY_KINDS = SCHEMAS.incomes.fields.categoryId.kindCompat;

/** Leitura autoritativa da categoria no Firestore do próprio usuário. */
async function fetchCategory(uid, categoryId) {
  return getById(uid, CATEGORY_COLLECTION, categoryId);
}

/**
 * Coerência status × data de recebimento. `received` sempre tem `receivedDate` (padrão: hoje em America/Sao_Paulo);
 * outro status NÃO guarda `receivedDate` (na atualização o campo é removido: `null` → deleteField; na criação é omitido).
 */
export function settleDates(data, forUpdate) {
  if (data.status === 'received') return { ...data, receivedDate: data.receivedDate ?? todayInAppZone() };
  const { receivedDate: _discarded, ...rest } = data;
  return forUpdate ? { ...rest, receivedDate: null } : rest;
}

/** Lista receitas com filtros opcionais. */
export async function listIncomes(uid, options = {}) {
  const constraints = { orderBy: ['expectedDate', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.orderBy) constraints.orderBy = options.orderBy;
  if (options.startAfterId) constraints.startAfterId = options.startAfterId;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/**
 * Todos os lançamentos do mês "AAAA-MM" (por `expectedDate`), sem depender da página carregada. Teto de 1000 (cota);
 * `truncated` avisa se o mês tem mais que isso. Usa só o índice simples do campo (sem índice composto novo).
 */
export async function listIncomesOfMonth(uid, month, io = {}) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error('Mês inválido.');
  const LIMIT = 1000;
  const items = await (io.list ?? listIncomes)(uid, {
    where: [['expectedDate', '>=', bounds.start], ['expectedDate', '<=', bounds.end]],
    orderBy: ['expectedDate', 'desc'],
    limit: LIMIT,
  });
  return { items, truncated: items.length >= LIMIT };
}

/** Busca uma receita por ID. */
export async function getIncome(uid, incomeId) {
  return getById(uid, COLLECTION, incomeId);
}

const finance = (io) => io.finance ?? financeResult;
const SETTLED_IMMUTABLE = 'Receita recebida não pode ser alterada nem excluída: estorne-a (lançamento compensatório).';

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
 * Cria uma receita NO SERVIDOR (VF-ARQ-02): categoria/conta validadas e saldo derivado dentro da transação; receita já
 * `received` entra no saldo atomicamente. `rawData.operationId`: chave de idempotência (gere ao abrir o formulário).
 * Ordem: modelo → compatibilidade de categoria (feedback imediato; o servidor revalida) → servidor.
 * Retorna { ok, id, errors, code }.
 */
export async function createIncome(uid, rawInput, deps = {}) {
  const { operationId, ...rawData } = rawInput ?? {};
  const built = buildEntity('incomes', rawData);
  if (!built.ok) return { ok: false, errors: built.errors };
  const data = settleDates(built.data, false);

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const r = await finance(deps)('income.create', movementParams(data), { operationId, ...(deps.apiOptions ?? {}) });
  return r.ok ? { ok: true, id: r.id, result: r } : r;
}

/**
 * Atualiza uma receita NÃO recebida. Recebida é imutável (estorne). Pedir `received` grava os campos como previstos e
 * confirma o recebimento no servidor.
 */
export async function updateIncome(uid, incomeId, rawData, deps = {}) {
  const built = buildEntity('incomes', rawData);
  if (!built.ok) return { ok: false, errors: built.errors };
  const data = settleDates(built.data, true);

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const current = await (deps.getById ?? getById)(uid, COLLECTION, incomeId);
  if (!current) return { ok: false, errors: { _form: 'Receita não encontrada.' } };
  if (current.status === 'received') return { ok: false, errors: { _form: SETTLED_IMMUTABLE } };
  const wantsReceive = data.status === 'received';
  const { receivedDate, ...rest } = data;
  await updateAudited(uid, COLLECTION, incomeId, wantsReceive ? { ...rest, status: 'pending', receivedDate: null } : data, deps);
  if (wantsReceive) return markIncomeReceived(uid, incomeId, receivedDate ?? null, deps);
  return { ok: true };
}

/** Exclui uma receita NÃO recebida (recebida: estorne). */
export async function deleteIncome(uid, incomeId, io = {}) {
  const income = await (io.getById ?? getById)(uid, COLLECTION, incomeId);
  if (!income) return { ok: false, errors: { _form: 'Receita não encontrada.' } };
  if (income.status === 'received') return { ok: false, errors: { _form: SETTLED_IMMUTABLE } };
  await (io.commitAtomic ?? commitAtomic)(uid, [{ type: 'delete', collection: COLLECTION, docId: incomeId, before: income }], io);
  return { ok: true, reversedCents: 0, accountId: null };
}

/** Marca a receita como recebida NO SERVIDOR (status e saldo atômicos, idempotente). */
export async function markIncomeReceived(uid, incomeId, receivedDate = null, io = {}) {
  const r = await finance(io)('income.receive', { id: incomeId, ...(receivedDate ? { date: receivedDate } : {}) }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, result: r } : r;
}

/** Marca receita como cancelada. */
export async function cancelIncome(uid, incomeId, io = {}) {
  const current = await (io.getById ?? getById)(uid, COLLECTION, incomeId);
  if (!current) return { ok: false, errors: { _form: 'Receita não encontrada.' } };
  if (current.status !== 'pending') return { ok: false, errors: { _form: 'Só é possível cancelar uma receita prevista (recebida: edite ou exclua).' } };
  await updateAudited(uid, COLLECTION, incomeId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

/** Opções de recorrência para <select>. */
export function getRecurrenceOptions() {
  return RECURRENCES.map((r) => ({ value: r.value, label: r.label }));
}

/** Status options for income. */
export function getIncomeStatusOptions() {
  return [
    { value: 'pending', label: 'Prevista' },
    { value: 'received', label: 'Recebida' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };
