/**
 * Serviço de Transferências — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/transfers.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import { buildEntity, formatCents, parseMoneyToCents } from '../core/model.js';
import { financeResult } from './financeApi.js';

const COLLECTION = COLLECTIONS.transfers;

/** Lista transferências com filtros opcionais. */
export async function listTransfers(uid, options = {}) {
  const constraints = { orderBy: ['date', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.orderBy) constraints.orderBy = options.orderBy;
  if (options.startAfterId) constraints.startAfterId = options.startAfterId;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/** Busca uma transferência por ID. */
export async function getTransfer(uid, transferId) {
  return getById(uid, COLLECTION, transferId);
}

/** Adaptador da camada confiável (injetável nos testes via `io.finance`). */
const finance = (io) => io.finance ?? financeResult;

/** Erros de conta (saldo, inativa, inexistente, mesma conta) aparecem junto do campo de origem, além do erro geral. */
const ACCOUNT_CODES = new Set(['INSUFFICIENT_BALANCE', 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_FOUND', 'SAME_ACCOUNT']);
const withAccountField = (r, field) => (!r.ok && ACCOUNT_CODES.has(r.code) && r.errors?._form ? { ...r, errors: { ...r.errors, [field]: r.errors._form } } : r);

/**
 * Cria uma transferência NO SERVIDOR (VF-ARQ-02): débito, crédito, saldo e idempotência são decididos numa transação
 * do servidor. `confirmed` exige saldo suficiente dentro da transação; `pending` não move dinheiro.
 * `rawData.operationId` é a chave de idempotência da intenção (gere ao abrir o formulário; reutilize em retry/duplo
 * clique). Retorna { ok, id, status, errors, code }.
 */
export async function createTransfer(uid, rawInput, io = {}) {
  const { operationId, ...rawData } = rawInput ?? {};
  const { ok, data, errors } = buildEntity('transfers', rawData);
  if (!ok) return { ok: false, errors };
  if (data.status === 'cancelled') { // não move dinheiro: gravação direta permitida pelas Rules
    const id = await createAudited(uid, COLLECTION, data, io);
    return { ok: true, id };
  }
  const r = await finance(io)('transfer.create', {
    fromAccountId: data.fromAccountId, toAccountId: data.toAccountId, amountCents: data.amountCents, date: data.date,
    reason: data.reason, ...(data.notes ? { notes: data.notes } : {}), status: data.status,
  }, { operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, id: r.transferId, status: r.status, result: r } : withAccountField(r, 'fromAccountId');
}

const CONFIRMED_IMMUTABLE = 'Transferência confirmada não pode ser alterada: estorne-a (lançamento compensatório) e lance outra.';

/** Atualiza uma transferência NÃO confirmada. Confirmada é imutável. Pedir `confirmed` confirma no servidor. */
export async function updateTransfer(uid, transferId, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('transfers', rawData);
  if (!ok) return { ok: false, errors };
  const current = await (io.getById ?? getById)(uid, COLLECTION, transferId);
  if (!current) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };
  if (current.status === 'confirmed') return { ok: false, errors: { _form: CONFIRMED_IMMUTABLE } };
  // Cancelada é terminal (TRANSFER_TRANSITIONS): reabrir uma transferência estornada a deixava confirmada com estorno registrado (presa).
  if (current.status === 'cancelled' && data.status !== 'cancelled') {
    return { ok: false, errors: { status: 'Transferência cancelada ou estornada não pode ser reaberta; lance uma nova transferência.' } };
  }
  const wantsConfirm = data.status === 'confirmed';
  await updateAudited(uid, COLLECTION, transferId, wantsConfirm ? { ...data, status: 'pending' } : data, io);
  if (wantsConfirm) return confirmTransfer(uid, transferId, io);
  return { ok: true };
}

/** Exclui uma transferência não confirmada (confirmada: estorne). */
export async function deleteTransfer(uid, transferId, io = {}) {
  const transfer = await (io.getById ?? getById)(uid, COLLECTION, transferId);
  if (!transfer) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };
  if (transfer.status === 'confirmed') return { ok: false, errors: { _form: CONFIRMED_IMMUTABLE } };
  await removeAudited(uid, COLLECTION, transferId, transfer, io);
  return { ok: true, reversed: false, amountCents: Number(transfer.amountCents) || 0 };
}

/** Transições de status permitidas. `confirmed` só nasce no servidor; sair dela é ESTORNO (`reversal.create`). */
export const TRANSFER_TRANSITIONS = Object.freeze({
  pending: ['confirmed', 'cancelled'],
  confirmed: [],
  cancelled: [],
});

/** Verifica se a transição de status é permitida. Puro. */
export function canTransitionTransfer(from, to) {
  return (TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

/** Confirma a transferência NO SERVIDOR (saldo da origem verificado na transação). */
export async function confirmTransfer(uid, transferId, io = {}) {
  const r = await finance(io)('transfer.confirm', { transferId }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, status: 'confirmed', result: r } : r;
}

/** Cancela uma transferência PENDENTE (confirmada: estorne). */
export async function cancelTransfer(uid, transferId, io = {}) {
  const transfer = await (io.getById ?? getById)(uid, COLLECTION, transferId);
  if (!transfer) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };
  if (transfer.status === 'confirmed') return { ok: false, errors: { _form: CONFIRMED_IMMUTABLE } };
  if (transfer.status !== 'pending') return { ok: false, errors: { _form: 'Transferência já está cancelada; não é possível cancelá-la.' } };
  await updateAudited(uid, COLLECTION, transferId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}


/** Status options for transfer. */
export function getTransferStatusOptions() {
  return [
    { value: 'pending', label: 'Pendente' },
    { value: 'confirmed', label: 'Confirmada' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };
