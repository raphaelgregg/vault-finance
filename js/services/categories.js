/**
 * Serviço de Categorias — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/categories.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  count,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import { buildEntity } from '../core/model.js';

const COLLECTION = COLLECTIONS.categories;

/**
 * Coleções que referenciam categories/{id} via campo categoryId.
 * Fonte única: usada pela checagem de vínculos e pelos testes.
 * (Todas declaram ref(userId,'categories','categoryId') nas Rules.)
 */
export const CATEGORY_LINK_COLLECTIONS = Object.freeze([
  { collection: COLLECTIONS.incomes, label: 'receitas' },
  { collection: COLLECTIONS.expenses, label: 'despesas' },
  { collection: COLLECTIONS.budgets, label: 'orçamentos' },
  { collection: COLLECTIONS.subscriptions, label: 'assinaturas' },
  { collection: COLLECTIONS.cardPurchases, label: 'compras no cartão' },
]);

/**
 * Resume as contagens de vínculos por coleção. Puro — sem Firebase.
 * @param {Array<{collection:string,label:string,count:number}>} counts
 * @returns {{links: Array, total: number, inUse: boolean}}
 */
export function summarizeCategoryLinks(counts = []) {
  const links = counts
    .map(({ collection, label, count: value }) => ({
      collection,
      label,
      count: Number.isInteger(value) && value > 0 ? value : 0,
    }))
    .filter((link) => link.count > 0);
  const total = links.reduce((sum, link) => sum + link.count, 0);
  return { links, total, inUse: total > 0 };
}

/** Plural simples para a mensagem. */
function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Mensagem de bloqueio da exclusão, informando coleção e contagem. Puro.
 * @param {ReturnType<typeof summarizeCategoryLinks>} summary
 */
export function buildCategoryInUseMessage(summary) {
  const links = summary?.links ?? [];
  if (!links.length) return 'Esta categoria não pode ser excluída porque está em uso.';
  const parts = links.map((link) => `${link.label} (${link.count})`);
  const total = summary.total ?? links.reduce((sum, link) => sum + link.count, 0);
  return `Esta categoria não pode ser excluída: está vinculada a ${parts.join(', ')} — ${plural(
    total,
    'registro',
    'registros'
  )} no total. Remova ou altere esses vínculos antes de excluir.`;
}

/**
 * Conta os vínculos de uma categoria nas quatro coleções.
 * Lança se qualquer contagem falhar — o chamador decide (fail-closed).
 */
export async function countCategoryUsage(uid, categoryId, countFn = count) {
  const counts = await Promise.all(
    CATEGORY_LINK_COLLECTIONS.map(async ({ collection, label }) => ({
      collection,
      label,
      count: await countFn(uid, collection, { where: [['categoryId', '==', categoryId]] }),
    }))
  );
  return summarizeCategoryLinks(counts);
}

/** Lista todas as categorias do usuário ordenadas por nome. */
export async function listCategories(uid) {
  return list(uid, COLLECTION, {
    orderBy: ['name', 'asc'],
  });
}

/** Busca uma categoria por ID. */
export async function getCategory(uid, categoryId) {
  return getById(uid, COLLECTION, categoryId);
}

/**
 * Cria uma nova categoria.
 * Retorna { ok, id, errors }.
 */
export async function createCategory(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('categories', rawData);
  if (!ok) return { ok: false, errors };

  const id = await createAudited(uid, COLLECTION, data, io);
  return { ok: true, id };
}

/**
 * Atualiza uma categoria existente.
 * Retorna { ok, errors }.
 */
export async function updateCategory(uid, categoryId, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('categories', rawData);
  if (!ok) return { ok: false, errors };

  await updateAudited(uid, COLLECTION, categoryId, data, io);
  return { ok: true };
}

/** Exclui uma categoria. */
export async function deleteCategory(uid, categoryId, io = {}) {
  const category = await (io.getById ?? getById)(uid, COLLECTION, categoryId);
  if (!category) return { ok: false, errors: { _form: 'Categoria não encontrada.' } };

  // Exclusão segura: categorias referenciadas por movimentações/orçamentos não
  // podem ser apagadas, senão o vínculo fica órfão (as Rules não têm como
  // validar integridade referencial na exclusão).
  let usage;
  try {
    usage = await countCategoryUsage(uid, categoryId, io.count);
  } catch (error) {
    // Fail-closed: se não for possível verificar, NÃO exclui.
    console.error('[categories] falha ao verificar vínculos', error);
    return {
      ok: false,
      errors: {
        _form:
          'Não foi possível verificar se a categoria está em uso. A exclusão foi cancelada por segurança; tente novamente.',
      },
    };
  }

  // LIMITAÇÃO CONHECIDA: esta checagem é client-side e existe uma janela de
  // concorrência entre a contagem e o delete — outra aba/aba anônima pode criar
  // um vínculo nesse intervalo. A mitigação definitiva exigiria transação em
  // backend (Cloud Functions/Admin SDK), fora do escopo atual (plano Spark).
  if (usage.inUse) {
    return { ok: false, errors: { _form: buildCategoryInUseMessage(usage) } };
  }

  await removeAudited(uid, COLLECTION, categoryId, category, io);
  return { ok: true };
}

/** Tipos de categoria para <select>. */
export const CATEGORY_KINDS = Object.freeze([
  { value: 'income', label: 'Receita' },
  { value: 'expense', label: 'Despesa' },
  { value: 'both', label: 'Ambos' },
]);

export function getCategoryKindOptions() {
  return CATEGORY_KINDS;
}

/** Rótulo de exibição "Nome (Tipo)" — fonte única para selects e listas de receitas, despesas e assinaturas. */
export function categoryLabel(category) {
  const kind = getCategoryKindOptions().find((o) => o.value === category.kind)?.label;
  return kind ? `${category.name} (${kind})` : category.name;
}
