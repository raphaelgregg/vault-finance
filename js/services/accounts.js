/**
 * Serviço de Contas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/accounts.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  count,
  createAudited,
  updateAudited,
} from './firestore.js';
import { buildEntity, formatCents, parseMoneyToCents, accountBalances, ACCOUNT_TYPES } from '../core/model.js';
import { financeResult } from './financeApi.js';

const COLLECTION = COLLECTIONS.accounts;

/** Lista todas as contas do usuário ordenadas por instituição e nome. */
export async function listAccounts(uid, options = {}) {
  return list(uid, COLLECTION, {
    orderBy: ['institution', 'asc'],
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

/** Busca uma conta por ID. */
export async function getAccount(uid, accountId) {
  return getById(uid, COLLECTION, accountId);
}

/**
 * Cria uma nova conta.
 * Retorna { ok, id, errors }.
 */
export async function createAccount(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('accounts', rawData);
  if (!ok) return { ok: false, errors };

  const id = await createAudited(uid, COLLECTION, data, io);
  return { ok: true, id };
}

/**
 * Atualiza uma conta existente.
 * Retorna { ok, errors }.
 */
export async function updateAccount(uid, accountId, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('accounts', rawData);
  if (!ok) return { ok: false, errors };
  const current = await (io.getById ?? getById)(uid, COLLECTION, accountId);
  if (!current) return { ok: false, errors: { _form: 'Conta não encontrada.' } };
  // VF-ARQ-02: saldo e data de abertura só mudam pela camada confiável (`adjustOpeningBalance`), nunca por edição.
  if ((Number(data.initialBalanceCents) || 0) !== (Number(current.initialBalanceCents) || 0)) {
    return { ok: false, errors: { initialBalanceCents: 'O saldo de abertura não é editado aqui: use "Ajustar saldo" (ajuste auditado feito pelo servidor).' } };
  }
  if ((data.openingDate ?? null) !== (current.openingDate ?? null)) {
    return { ok: false, errors: { openingDate: 'A data de abertura não é editada aqui: use "Ajustar saldo".' } };
  }
  // Conta sem nome: remove `name` se existia (null → deleteField em `update`; update é merge).
  const { initialBalanceCents: _kept, openingDate: _keptDate, ...editable } = data;
  // Arquivar/desarquivar é do SERVIDOR (arquivamento lógico, serializado com os lançamentos da conta); o resto grava aqui.
  const archiving = data.status === 'archived' && current.status !== 'archived';
  const unarchiving = current.status === 'archived' && data.status !== 'archived';
  await updateAudited(uid, COLLECTION, accountId, { ...editable, status: current.status, name: data.name ?? null }, io);
  if (archiving) return archiveAccount(uid, accountId, io);
  if (unarchiving) {
    const back = await unarchiveAccount(uid, accountId, io);
    if (!back.ok) return back;
    if (data.status !== 'active') await updateAudited(uid, COLLECTION, accountId, { status: data.status }, io);
  } else if (data.status !== current.status && !archiving) {
    // active ⇄ inactive: sem efeito no histórico
    await updateAudited(uid, COLLECTION, accountId, { status: data.status }, io);
  }
  return { ok: true };
}

/**
 * Cálculo PURO do ajuste de saldo de abertura. `account` (com ou sem `openingDate` novo), `movements` = movimentos
 * realizados lidos; `realCents` = quanto a conta tem de fato agora. Fórmula:
 *   movimentos = saldo_atual_derivado − abertura_atual      (o que os lançamentos acrescentam)
 *   nova_abertura = saldo_real − movimentos
 * Só o saldo de abertura muda; nenhum movimento é tocado. Retorna { currentCents, movementsCents, newInitialCents }.
 */
export function computeOpeningAdjustment(account, movements, realCents) {
  const initial = Number(account.initialBalanceCents) || 0;
  const current = accountBalances([account], movements).get(account.id) ?? initial;
  const movementsCents = current - initial;
  return { currentCents: current, movementsCents, newInitialCents: realCents - movementsCents };
}

/**
 * Ajusta o saldo de abertura de UMA conta para que o saldo atual derivado seja `realCents` (ação explícita do
 * usuário; nada é automático). Opcionalmente define `openingDate` (movimentos anteriores deixam de contar).
 * Fail-closed: não ajusta se a leitura dos movimentos foi truncada (saldo incompleto) ou falhou, e rejeita
 * abertura negativa (o saldo informado é menor que o dos lançamentos — informe uma data de abertura).
 * Retorna { ok, previousInitialCents, newInitialCents, movementsCents, errors }.
 */
export async function adjustOpeningBalance(uid, accountId, realInput, { openingDate = null, operationId } = {}, io = {}) {
  const realCents = typeof realInput === 'number' ? realInput : parseMoneyToCents(realInput);
  if (!Number.isInteger(realCents) || realCents < 0) return { ok: false, errors: { realBalance: 'Informe o saldo atual da conta (valor monetário válido, sem negativo).' } };
  if (openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) return { ok: false, errors: { openingDate: 'Data inválida (use DD/MM/AAAA).' } };
  // VF-ARQ-02: o servidor lê os movimentos (sem truncar: fail-closed acima do limite), calcula e grava na MESMA transação.
  const r = await (io.finance ?? financeResult)('account.adjustOpening', {
    accountId, realBalanceCents: realCents, ...(openingDate ? { openingDate } : {}),
  }, { operationId, ...(io.apiOptions ?? {}) });
  if (!r.ok) return r.code === 'INVALID_STATE' ? { ...r, errors: { realBalance: r.errors._form } } : r;
  return { ok: true, previousInitialCents: r.previousInitialCents, newInitialCents: r.newInitialCents, movementsCents: r.movementsCents, result: r };
}

/**
 * Referências a accounts/{id}, uma entrada por campo (transferências têm origem
 * e destino). Espelha os `ref(userId, 'accounts', ...)` de firestore.rules.
 */
export const ACCOUNT_LINK_QUERIES = Object.freeze([
  { collection: COLLECTIONS.incomes, field: 'accountId', label: 'receitas' },
  { collection: COLLECTIONS.expenses, field: 'accountId', label: 'despesas' },
  { collection: COLLECTIONS.transfers, field: 'fromAccountId', label: 'transferências (origem)' },
  { collection: COLLECTIONS.transfers, field: 'toAccountId', label: 'transferências (destino)' },
  { collection: COLLECTIONS.subscriptions, field: 'accountId', label: 'assinaturas' },
  { collection: COLLECTIONS.debtPayments, field: 'accountId', label: 'pagamentos de dívidas' },
  { collection: COLLECTIONS.creditCards, field: 'accountId', label: 'cartões' },
  { collection: COLLECTIONS.goals, field: 'accountId', label: 'metas' },
  { collection: COLLECTIONS.goalTransactions, field: 'accountId', label: 'movimentações de metas' },
  { collection: COLLECTIONS.invoices, field: 'accountId', label: 'faturas pagas' },
]);

/** Resume contagens de vínculos. Puro — sem Firebase. */
export function summarizeAccountLinks(counts = []) {
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

/** Mensagem de bloqueio da exclusão. Puro. */
export function buildAccountInUseMessage(summary) {
  const links = summary?.links ?? [];
  if (!links.length) return 'Esta conta não pode ser excluída porque está em uso.';
  const parts = links.map((link) => `${link.label} (${link.count})`);
  return `Esta conta não pode ser excluída: possui movimentações vinculadas — ${parts.join(', ')}. `
    + 'Altere ou remova esses registros, ou arquive a conta (status "Arquivada") para preservá-los.';
}

/**
 * Conta os vínculos de uma conta. Lança se qualquer contagem falhar —
 * o chamador decide (fail-closed).
 */
export async function countAccountUsage(uid, accountId, countFn = count) {
  const counts = await Promise.all(
    ACCOUNT_LINK_QUERIES.map(async ({ collection, field, label }) => ({
      collection,
      label,
      count: await countFn(uid, collection, { where: [[field, '==', accountId]] }),
    }))
  );
  return summarizeAccountLinks(counts);
}

/**
 * Exclui uma conta NO SERVIDOR, somente se não houver nenhum vínculo/histórico (checado dentro da transação). Conta com
 * histórico deve ser ARQUIVADA (`archiveAccount`): o histórico é preservado e consultável.
 */
export async function deleteAccount(uid, accountId, io = {}) {
  const r = await (io.finance ?? financeResult)('account.delete', { accountId }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  if (r.ok) return { ok: true };
  return r.code === 'HAS_HISTORY' ? { ...r, errors: { _form: `${r.errors._form}` }, hasHistory: true } : r;
}

/** Arquiva (arquivamento lógico: sem exclusão física; deixa de receber lançamentos; histórico segue consultável). */
export async function archiveAccount(uid, accountId, io = {}) {
  const r = await (io.finance ?? financeResult)('account.archive', { accountId }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true } : r;
}

/** Desarquiva a conta (volta a `active`). */
export async function unarchiveAccount(uid, accountId, io = {}) {
  const r = await (io.finance ?? financeResult)('account.unarchive', { accountId }, { operationId: io.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true } : r;
}

/** Formata opções de tipo de conta para <select>. */
export function getAccountTypeOptions() {
  return ACCOUNT_TYPES.map((t) => ({ value: t.value, label: t.label }));
}

/** Status options for select. */
export function getStatusOptions() {
  return [
    { value: 'active', label: 'Ativa' },
    { value: 'inactive', label: 'Inativa' },
    { value: 'archived', label: 'Arquivada' },
  ];
}

/** Formata centavos para exibição (R$ 1.234,56). */
export { formatCents, parseMoneyToCents };
