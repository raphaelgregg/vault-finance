/**
 * Firestore em memória para testes de devedores. Inclui um SERVIDOR EM MEMÓRIA (`io.finance`) que executa a lógica REAL
 * da camada confiável (`prepareReceive` e `planItems` de server/finance/ops.mjs) sobre as tabelas — os testes unitários
 * exercitam a regra de verdade sem duplicá-la; concorrência/transações reais ficam em tests/integration (Emulator).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FinanceError } from '../../../server/finance/core.mjs';
import { prepareReceive, planItems } from '../../../server/finance/ops.mjs';
export const UID = 'u1';
export const DEBTOR = 'd1';

/** Base em memória com o contrato do Firestore que importa aqui: lote atômico e `create` com ID existente negado (Rules). */
export function makeStore(seed = {}) {
  const tables = structuredClone({
    accounts: [{ id: 'acc', status: 'active', institution: 'Banco', name: 'Conta', initialBalanceCents: 100000 }, { id: 'off', status: 'inactive', institution: 'Banco', name: 'Off', initialBalanceCents: 0 }],
    debtors: [{ id: DEBTOR, name: 'Renan', status: 'open', lentCents: 23100, receivedCents: 0 }],
    cards: [{ id: 'k1', name: 'Nubank' }],
    invoices: [{ id: 'inv12', cardId: 'k1', referenceMonth: '2026-12', dueDate: '2026-12-06', status: 'open' }],
    cardPurchases: [
      { id: 'pAgua', cardId: 'k1', debtorId: DEBTOR, description: 'Água', amountCents: 2500, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-20' },
      { id: 'pMercado', cardId: 'k1', debtorId: DEBTOR, description: 'Mercado', amountCents: 7800, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-21' },
      { id: 'pSuper', cardId: 'k1', debtorId: DEBTOR, description: 'Supermercado', amountCents: 2800, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-22' },
    ],
    debts: [
      { id: 'dNov', debtorId: DEBTOR, description: 'Parcela', principalCents: 5000, dueDate: '2026-11-30', installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g1', status: 'pending' },
      { id: 'dDez', debtorId: DEBTOR, description: 'Parcela', principalCents: 5000, dueDate: '2026-12-30', installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g1', status: 'pending' },
    ],
    debtPayments: [],
    ...seed,
  });
  const calls = { commits: [] };
  const where = (rows, clauses = []) => rows.filter((r) => clauses.every(([f, op, v]) => (op === '==' ? r[f] === v : op === 'in' ? v.includes(r[f]) : true)));
  const io = {
    getById: async (_u, c, id) => structuredClone((tables[c] ?? []).find((r) => r.id === id) ?? null),
    list: async (_u, c, o = {}) => structuredClone(where(tables[c] ?? [], o.where)),
    commitAtomic: async (_u, ops) => {
      calls.commits.push(structuredClone(ops));
      if (ops.length > 250) throw new Error('lote acima do limite');
      const draft = structuredClone(tables);
      let n = 0;
      const ids = [];
      for (const op of ops) {
        draft[op.collection] ??= [];
        if (op.type === 'create') {
          const id = op.docId ?? `auto${(n += 1)}${draft[op.collection].length}`;
          // Rules: criar em ID que já existe vira update e exige createdAt imutável (serverTimestamp muda) → negado.
          if (draft[op.collection].some((r) => r.id === id)) throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
          draft[op.collection].push({ id, ...op.data });
          ids.push(id);
        } else {
          const row = draft[op.collection].find((r) => r.id === op.docId);
          if (!row) throw new Error('not-found');
          Object.assign(row, op.data);
          for (const [field, delta] of Object.entries(op.increments ?? {})) row[field] = (Number(row[field]) || 0) + delta; // increment() atômico do servidor
          ids.push(op.docId);
        }
      }
      for (const k of Object.keys(draft)) tables[k] = draft[k]; // tudo ou nada
      return ids;
    },
  };
  // ---- servidor em memória (lógica real de ops.mjs; as tabelas são o "Firestore") ----
  let seq = 0;
  const ops = new Map(); // operationId → { hash, result }
  const clean = (value) => {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof Timestamp) out[k] = v.toDate().toISOString().slice(0, 10);
      else if (v && typeof v === 'object' && /Transform|FieldValue/i.test(v.constructor?.name ?? '')) continue; // sentinelas (serverTimestamp)
      else out[k] = v;
    }
    return out;
  };
  const ctx = {
    async get(coll, id) { return structuredClone((tables[coll] ?? []).find((r) => r.id === id) ?? null); },
    async query(coll, [field, , value]) { return structuredClone((tables[coll] ?? []).filter((r) => r[field] === value)); },
    async account(id, { allowInactive = false } = {}) {
      const a = await ctx.get('accounts', id);
      if (!a) throw new FinanceError(404, 'ACCOUNT_NOT_FOUND', 'Conta não encontrada.');
      if (!allowInactive && a.status !== 'active') throw new FinanceError(409, 'ACCOUNT_NOT_ACTIVE', 'A conta precisa estar ativa.');
      return a;
    },
    col: () => ({ doc: () => ({ id: `srv${(seq += 1)}` }) }),
  };
  const applyPrepared = async (prepared) => {
    const writes = [];
    await prepared.apply({
      ref: (coll, id) => ({ coll, id }),
      tx: {
        create: (ref, data) => writes.push(['create', ref, clean(data)]),
        update: (ref, data) => writes.push(['update', ref, clean(data)]),
      },
      touchAccount: () => {},
    });
    for (const [kind, ref, data] of writes) {
      tables[ref.coll] ??= [];
      if (kind === 'create') tables[ref.coll].push({ id: ref.id, ...data });
      else Object.assign(tables[ref.coll].find((r) => r.id === ref.id), data);
    }
  };
  const receive = async (params, operationId) => {
    const hash = JSON.stringify(params);
    const seen = ops.get(operationId);
    if (seen) {
      if (seen.hash !== hash) throw new FinanceError(409, 'OPERATION_ID_REUSED', 'Este operationId já foi usado em outra operação.');
      return { ...seen.result, operationId, idempotent: true };
    }
    const prepared = await prepareReceive(ctx, params, operationId);
    await applyPrepared(prepared);
    ops.set(operationId, { hash, result: prepared.result });
    return { ...prepared.result, operationId, idempotent: false };
  };
  const fail = (error) => (error instanceof FinanceError
    ? { ok: false, code: error.code, status: error.status, errors: { _form: error.message }, details: error.details }
    : { ok: false, code: 'INTERNAL_ERROR', status: 500, errors: { _form: String(error?.message ?? error) } });
  const batches = new Map();
  const finance = async (op, params, { operationId = `auto-${(seq += 1)}` } = {}) => {
    try {
      if (op === 'debt.receive') return { ok: true, ...(await receive(params, operationId)) };
      if (op === 'debt.cancel') {
        const debt = await ctx.get('debts', params.debtId);
        if (!debt) throw new FinanceError(404, 'NOT_FOUND', 'Parcela não encontrada.');
        if (!['pending', 'late'].includes(debt.status)) throw new FinanceError(409, 'INVALID_STATE', 'Só é possível cancelar parcelas pendentes ou atrasadas.');
        if (tables.debtPayments.some((p) => p.debtId === params.debtId)) throw new FinanceError(409, 'INVALID_STATE', 'A parcela já possui recebimentos e não pode ser cancelada.');
        Object.assign(tables.debts.find((d) => d.id === params.debtId), { status: 'cancelled' });
        const owner = tables.debtors.find((d) => d.id === debt.debtorId);
        if (owner) owner.lentCents -= Number(debt.principalCents) || 0; // cancelar devolve o valor ao emprestado (como o servidor)
        return { ok: true, debtId: params.debtId, status: 'cancelled' };
      }
      if (op === 'debt.settleBatch') {
        let batch = batches.get(operationId);
        if (!batch) {
          const debtor = await ctx.get('debtors', params.debtorId);
          if (!debtor) throw new FinanceError(404, 'NOT_FOUND', 'Devedor não encontrado.');
          const [debts, purchases, payments] = ['debts', 'cardPurchases', 'debtPayments'].map((c) => tables[c].filter((r) => r.debtorId === params.debtorId));
          const invoicesById = new Map(tables.invoices.map((i) => [i.id, i]));
          const items = planItems(debtor, { debts, purchases, payments, invoicesById }, params.scope);
          if (!items.length) throw new FinanceError(409, 'INVALID_STATE', 'Não há parcelas pendentes para quitar.');
          batch = { items: items.map((i) => ({ ...i, status: 'pending' })) };
          batches.set(operationId, batch);
        }
        for (const item of batch.items.filter((i) => ['pending', 'failed'].includes(i.status)).slice(0, 15)) {
          try {
            const r = await receive({ [item.source === 'debt' ? 'debtId' : 'purchaseId']: item.id, date: params.date, accountId: params.accountId, ...(params.notes ? { notes: params.notes } : {}) }, `${operationId}~${item.key}`);
            Object.assign(item, { status: 'done', amountCents: r.amountCents });
          } catch (error) {
            if (!(error instanceof FinanceError)) throw error;
            Object.assign(item, { status: error.code === 'INVALID_STATE' ? 'skipped' : 'failed', error: error.code });
          }
        }
        const count = (st) => batch.items.filter((i) => i.status === st).length;
        const pending = count('pending');
        return {
          ok: true, batchId: operationId, status: pending ? 'running' : count('failed') ? 'partial_failed' : 'completed', total: batch.items.length,
          done: count('done'), skipped: count('skipped'), failed: count('failed'), pending, receivedCents: batch.items.filter((i) => i.status === 'done').reduce((t, i) => t + i.amountCents, 0),
          items: batch.items.map(({ key, status, amountCents, error }) => ({ key, status, ...(amountCents !== undefined ? { amountCents } : {}), ...(error ? { error } : {}) })),
        };
      }
      throw new FinanceError(400, 'UNKNOWN_OP', `Operação não suportada no servidor em memória: ${op}`);
    } catch (error) { return fail(error); }
  };
  io.finance = finance;
  // loadDebtorStatements lê 'cardPurchases'/'debts'/'debtPayments'/'invoices' pelo nome da coleção
  return { tables, io, calls };
}
