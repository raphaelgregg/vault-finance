/**
 * Validação e normalização de entidades (sem createdAt/updatedAt — o serviço os grava) e compatibilidade categoria × movimentação.
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */
import { parseIsoDate } from '../../utils/dates.js';
import { parseMoneyToCents } from '../../utils/money.js';
import { SCHEMAS } from './schemas.js';

/** Mensagem única de incompatibilidade entre tipo de categoria e movimentação. */
export const CATEGORY_KIND_ERROR = 'Categoria incompatível com este tipo de movimentação.';

/**
 * Verifica se uma categoria pode ser usada por uma movimentação.
 * Puro e reutilizável: a categoria deve vir do Firestore, nunca do formulário.
 * Retorna { ok, errors } no padrão dos serviços.
 */
export function checkCategoryForMovement(category, allowedKinds) {
  if (!category) {
    return { ok: false, errors: { categoryId: 'Categoria não encontrada.' } };
  }
  if (!isKindCompatible(category.kind, allowedKinds)) {
    return { ok: false, errors: { categoryId: CATEGORY_KIND_ERROR } };
  }
  return { ok: true, errors: {} };
}

/** true quando `categoryKind` está na lista de tipos aceitos. */
export function isKindCompatible(categoryKind, allowedKinds) {
  return Array.isArray(allowedKinds) && allowedKinds.includes(categoryKind);
}

/**
 * Resolve o tipo de uma categoria no contexto de validação.
 * Aceita função (id) => kind, Map id → kind ou objeto { id: kind }.
 * Retorna undefined quando o contexto não traz o lookup ou não conhece o id.
 */
function lookupCategoryKind(categoryKinds, categoryId) {
  if (!categoryKinds) return undefined;
  if (typeof categoryKinds === 'function') return categoryKinds(categoryId);
  if (categoryKinds instanceof Map) return categoryKinds.get(categoryId);
  if (typeof categoryKinds === 'object') return categoryKinds[categoryId];
  return undefined;
}

/** true quando a string é uma data de calendário real em "YYYY-MM-DD". */
export function isValidIsoDate(value) {
  return parseIsoDate(value) !== null;
}

/**
 * Valida os dados de uma entidade (sem createdAt/updatedAt — o serviço os grava).
 * Retorna { ok, errors } com mensagens em pt-BR por campo.
 *
 * `context` é opcional e retrocompatível. Hoje aceita:
 *  - categoryKinds: função ou Map categoryId → kind. Quando presente, campos com
 *    `kindCompat` (ex.: categoryId de incomes/expenses) também são validados
 *    contra o tipo da categoria.
 *
 * AUSÊNCIA DE CONTEXTO = a checagem de compatibilidade de tipo NÃO é executada;
 * apenas a referência (string/limite) é validada, como antes. A existência e o
 * tipo reais da categoria devem ser conferidos na camada de serviço, que lê o
 * Firestore. Não passe o kind do formulário: ele não é fonte de verdade.
 */
export function validateEntity(kind, data, context = {}) {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, errors: { _form: 'Entidade desconhecida.' } };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: { _form: 'Dados inválidos.' } };
  }

  const errors = {};
  const allowedKeys = Object.keys(schema.fields);

  for (const key of Object.keys(data)) {
    if (!allowedKeys.includes(key)) errors[key] = 'Campo não permitido.';
  }

  for (const [field, rule] of Object.entries(schema.fields)) {
    const value = data[field];
    const missing = value === undefined || value === null || value === ''
      || (rule.kind === 'text' && typeof value === 'string' && value.trim() === ''); // texto só com espaços = vazio

    if (missing) {
      if (rule.required) errors[field] = 'Campo obrigatório.';
      continue;
    }

    if (rule.kind === 'text') {
      if (typeof value !== 'string') errors[field] = 'Valor inválido.';
      else if (value.trim().length === 0) errors[field] = 'Campo obrigatório.';
      else if (value.trim().length > rule.max) errors[field] = `Máximo de ${rule.max} caracteres.`;
    } else if (rule.kind === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value)) {
        errors[field] = 'Valor inválido.';
      }
    } else if (rule.kind === 'cents') {
      const parsed = parseMoneyToCents(value);
      if (parsed === null) errors[field] = 'Valor monetário inválido.';
      else if (rule.positive && parsed <= 0) errors[field] = 'O valor deve ser maior que zero.';
      else if (rule.nonNegative && parsed < 0) errors[field] = 'O valor não pode ser negativo.';
    } else if (rule.kind === 'int') {
      const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
      if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
        errors[field] = `Informe um número inteiro entre ${rule.min} e ${rule.max}.`;
      }
    } else if (rule.kind === 'month') {
      if (typeof value !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)) {
        errors[field] = 'Mês inválido (use MM/AAAA).';
      }
    } else if (rule.kind === 'date') {
      if (!isValidIsoDate(value)) errors[field] = 'Data inválida (use DD/MM/AAAA).';
    } else if (rule.kind === 'ref') {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > rule.max) {
        errors[field] = 'Referência inválida.';
      } else if (rule.kindCompat) {
        // Checagem declarativa: só roda se o contexto trouxer o lookup do kind.
        const categoryKind = lookupCategoryKind(context?.categoryKinds, value);
        if (typeof categoryKind === 'string' && !isKindCompatible(categoryKind, rule.kindCompat)) {
          errors[field] = CATEGORY_KIND_ERROR;
        }
      }
    }
  }

  if (kind === 'transfers' && data.fromAccountId && data.toAccountId
    && data.fromAccountId === data.toAccountId) {
    errors.toAccountId = 'A conta de destino deve ser diferente da conta de origem.';
  }

  if (kind === 'debtPayments' && !errors.debtId && !errors.purchaseId && Boolean(data.debtId) === Boolean(data.purchaseId)) {
    errors.debtId = 'Informe a parcela da dívida OU a parcela do cartão (apenas uma).';
  }

  if (kind === 'cardPurchases' && !errors.installmentNumber && !errors.installmentsTotal
    && data.installmentNumber !== undefined && data.installmentsTotal !== undefined
    && Number(data.installmentNumber) > Number(data.installmentsTotal)) {
    errors.installmentNumber = 'A parcela não pode ser maior que o total de parcelas.';
  }

  if (kind === 'debtors' && !errors.lentCents && !errors.receivedCents
    && data.lentCents !== undefined && data.receivedCents !== undefined) {
    if (parseMoneyToCents(data.receivedCents) > parseMoneyToCents(data.lentCents)) {
      errors.receivedCents = 'O valor recebido não pode exceder o valor emprestado.';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Normaliza os dados validados para gravação: texto aparado, dinheiro em
 * centavos inteiros, datas mantidas em "YYYY-MM-DD". Retorna { ok, data, errors }.
 * `context` é repassado a validateEntity; sem ele, a checagem de kindCompat
 * não é executada (comportamento retrocompatível).
 */
export function buildEntity(kind, data, context = {}) {
  const check = validateEntity(kind, data, context);
  if (!check.ok) return check;

  const schema = SCHEMAS[kind];
  const out = {};
  for (const [field, rule] of Object.entries(schema.fields)) {
    const value = data[field];
    if (value === undefined || value === null || value === ''
      || (rule.kind === 'text' && typeof value === 'string' && value.trim() === '')) continue;
    if (rule.kind === 'text' || rule.kind === 'enum' || rule.kind === 'ref') {
      out[field] = typeof value === 'string' ? value.trim() : value;
    } else if (rule.kind === 'cents') {
      out[field] = parseMoneyToCents(value);
    } else if (rule.kind === 'int') {
      out[field] = Number(value);
    } else {
      out[field] = value;
    }
  }
  return { ok: true, data: out, errors: {} };
}
