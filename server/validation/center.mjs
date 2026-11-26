/**
 * Central de validação do sistema (VF-UI-02) — SERVIDOR. Somente administradores autorizados.
 *
 * Três recursos isolados (nenhuma função de manutenção/limpeza existente é reutilizada):
 *  - `seed`    popula a conta autenticada com dados de DEMONSTRAÇÃO (IDs `demo_*` + manifesto `demoSeeds/current`);
 *  - `audit`   executa a auditoria funcional automatizada SOBRE a base de demonstração (operações reais do servidor
 *              financeiro contra contas `demo_*`), prova que nenhum dado real foi alterado e remove os artefatos da auditoria;
 *  - `cleanup` remove SOMENTE o que o manifesto lista (e só IDs `demo_*`), mais artefatos de auditoria (`operationId`
 *              `demoaud-*`). Um registro real nunca é alcançado: sem manifesto, nada é apagado.
 *  - `status`  informa se há dados de demonstração.
 *
 * Autorização (defesa em camadas, a cada chamada): ID token válido + claim `admin === true` NO TOKEN + claim `admin`
 * ATUAL da conta (consulta ao Auth: uma revogação vale na hora). Qualquer falha → 401/403 antes de tocar o Firestore.
 */
import '../finance/index.mjs';
import { getAuth } from 'firebase-admin/auth';
import { registry, executeOnce, FinanceError, getAdmin, toTs, plain, FieldValue, enforceAppCheck } from '../finance/core.mjs';
import { buildEntity, SCHEMAS, accountBalances } from '../../js/core/model.js';
import { todayInAppZone, parseIsoDate, dateToIsoDate } from '../../js/utils/dates.js';

export const DEMO_PREFIX = 'demo_';
export const AUDIT_KEY_PREFIX = 'demoaud-';
export const CONFIRM = Object.freeze({ seed: 'POPULAR DEMONSTRACAO', cleanup: 'REMOVER DEMONSTRACAO' });
/** Únicas coleções que a Central cria/apaga (lista fechada). */
export const DEMO_COLLECTIONS = Object.freeze(['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'goals', 'goalTransactions',
  'creditCards', 'invoices', 'cardPurchases', 'debtors', 'debts', 'debtPayments', 'budgets']);
const ARTIFACT_COLLECTIONS = Object.freeze(['transfers', 'incomes', 'expenses', 'goalTransactions', 'debtPayments', 'reversals', 'operations']);
const json = (status, body) => ({ status, body });
const isDemoId = (id) => typeof id === 'string' && id.startsWith(DEMO_PREFIX) && !id.includes('/');

// ---------------------------------------------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------------------------------------------
const shift = (iso, days) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + days); return dateToIsoDate(d); };
const monthOf = (iso, back = 0) => { const [y, m] = iso.slice(0, 7).split('-').map(Number); const t = y * 12 + (m - 1) - back; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------------------------------------------
// Dados de demonstração (validados pelos MESMOS schemas do app; nada de campo extra: o usuário pode editá-los na UI)
// ---------------------------------------------------------------------------------------------------------------
export function buildDemoSeed(today = todayInAppZone()) {
  const items = [];
  const add = (collection, id, kind, raw) => {
    const built = buildEntity(kind, raw);
    if (!built.ok) throw new Error(`seed inválido (${collection}/${id}): ${JSON.stringify(built.errors)}`);
    const data = {};
    for (const [k, val] of Object.entries(built.data)) data[k] = (SCHEMAS[kind].dateFields ?? []).includes(k) && typeof val === 'string' ? toTs(val) : val;
    items.push({ collection, id, data });
  };
  const A = 'demo_acc_corrente'; const P = 'demo_acc_poupanca'; const C = 'demo_acc_carteira';
  const acc = (id, name, type, initial) => add('accounts', id, 'accounts', { institution: `[DEMO] ${name}`, name, type, initialBalanceCents: initial, color: '#6c5ce7', status: 'active' });
  acc(A, 'Conta corrente', 'checking', '1.500,00'); acc(P, 'Poupança', 'savings', '5.000,00'); acc(C, 'Carteira', 'other', '300,00');
  const cat = (id, name, kind) => add('categories', id, 'categories', { name: `[DEMO] ${name}`, kind, color: '#0984e3' });
  cat('demo_cat_mercado', 'Mercado', 'expense'); cat('demo_cat_moradia', 'Moradia', 'expense'); cat('demo_cat_salario', 'Salário', 'income');
  const inc = (id, d, cents, expected, received, accountId, status) => add('incomes', id, 'incomes', { description: `[DEMO] ${d}`, categoryId: 'demo_cat_salario', amountCents: cents, expectedDate: expected, ...(received ? { receivedDate: received } : {}), accountId, status, recurrence: 'none' });
  inc('demo_inc_salario', 'Salário', '4.500,00', shift(today, -10), shift(today, -10), A, 'received');
  inc('demo_inc_freela', 'Freelance (previsto)', '800,00', shift(today, 5), null, A, 'pending');
  const exp = (id, d, catId, cents, due, paid, accountId, status) => add('expenses', id, 'expenses', { description: `[DEMO] ${d}`, categoryId: catId, amountCents: cents, accountId, purchaseDate: shift(due, -20), dueDate: due, ...(paid ? { paidDate: paid } : {}), status, recurrence: 'none' });
  exp('demo_exp_aluguel', 'Aluguel', 'demo_cat_moradia', '1.200,00', shift(today, -8), shift(today, -8), A, 'paid');
  exp('demo_exp_mercado', 'Mercado do mês', 'demo_cat_mercado', '350,00', shift(today, -3), shift(today, -3), A, 'paid');
  exp('demo_exp_luz', 'Conta de luz (a vencer)', 'demo_cat_moradia', '180,00', shift(today, 4), null, A, 'pending');
  exp('demo_exp_internet', 'Internet (atrasada)', 'demo_cat_moradia', '120,00', shift(today, -2), null, A, 'pending');
  const tr = (id, from, to, cents, date, status) => add('transfers', id, 'transfers', { fromAccountId: from, toAccountId: to, amountCents: cents, date, reason: '[DEMO] Reserva', status });
  tr('demo_tr_reserva', A, P, '1.000,00', shift(today, -6), 'confirmed'); tr('demo_tr_pendente', P, C, '200,00', shift(today, 1), 'pending');
  add('goals', 'demo_goal_viagem', 'goals', { name: '[DEMO] Viagem', targetCents: '3.000,00', deadline: shift(today, 200), status: 'active' });
  const goalTx = (id, cents, date) => items.push({ collection: 'goalTransactions', id, data: { goalId: 'demo_goal_viagem', type: 'deposit', amountCents: Math.round(Number(cents) * 100), date: toTs(date), accountId: P } });
  goalTx('demo_gtx_1', 500, shift(today, -5)); goalTx('demo_gtx_2', 300, shift(today, -2));
  add('creditCards', 'demo_card_visa', 'creditCards', { name: '[DEMO] Cartão Visa', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 20, accountId: A, color: '#d63031', status: 'active' });
  const inv = (month, status, extra = {}) => add('invoices', `demo_card_visa_${month}`, 'invoices', { cardId: 'demo_card_visa', referenceMonth: month, closingDate: `${month}-10`, dueDate: `${month}-20`, status, ...extra });
  const buy = (id, desc, cents, month, n, total, date) => add('cardPurchases', id, 'cardPurchases', { cardId: 'demo_card_visa', description: `[DEMO] ${desc}`, amountCents: cents, purchaseDate: date, installmentsTotal: total, installmentNumber: n, invoiceId: `demo_card_visa_${month}`, categoryId: 'demo_cat_mercado' });
  const [m0, m1, m2] = [monthOf(today), monthOf(today, 1), monthOf(today, 2)];
  inv(m2, 'paid', { totalCents: '400,00', paidCents: '400,00', accountId: A, paidAt: `${m2}-21` }); buy('demo_buy_antiga', 'Compra antiga', '400,00', m2, 1, 1, `${m2}-05`);
  inv(m1, 'closed', { totalCents: '650,00' }); buy('demo_buy_fechada1', 'Eletrônico 1/2', '450,00', m1, 1, 2, `${m1}-04`); buy('demo_buy_fechada2', 'Restaurante', '200,00', m1, 1, 1, `${m1}-06`);
  inv(m0, 'open'); buy('demo_buy_aberta1', 'Eletrônico 2/2', '450,00', m0, 2, 2, `${m0}-04`); buy('demo_buy_aberta2', 'Streaming', '40,00', m0, 1, 1, `${m0}-05`);
  add('debtors', 'demo_debtor_joao', 'debtors', { name: '[DEMO] João (parcelado)', loanDate: shift(today, -40), lentCents: '1.000,00', receivedCents: '350,00', status: 'open' });
  add('debtors', 'demo_debtor_maria', 'debtors', { name: '[DEMO] Maria (quitada)', loanDate: shift(today, -60), lentCents: '300,00', receivedCents: '300,00', status: 'paid' });
  const debt = (id, debtor, n, total, cents, due, status) => add('debts', id, 'debts', { debtorId: debtor, description: `[DEMO] Empréstimo ${n}/${total}`, principalCents: cents, dueDate: due, installmentNumber: n, installmentsTotal: total, debtGroupId: `demo_grp_${debtor}`, status });
  debt('demo_debt_j1', 'demo_debtor_joao', 1, 4, '250,00', shift(today, -30), 'paid'); debt('demo_debt_j2', 'demo_debtor_joao', 2, 4, '250,00', shift(today, 0), 'pending');
  debt('demo_debt_j3', 'demo_debtor_joao', 3, 4, '250,00', shift(today, 30), 'pending'); debt('demo_debt_j4', 'demo_debtor_joao', 4, 4, '250,00', shift(today, 60), 'pending');
  debt('demo_debt_m1', 'demo_debtor_maria', 1, 1, '300,00', shift(today, -20), 'paid');
  const pay = (id, debtId, debtorId, cents, date) => items.push({ collection: 'debtPayments', id, data: { debtId, debtorId, amountCents: cents, date: toTs(date), accountId: A } });
  pay('demo_pay_j1', 'demo_debt_j1', 'demo_debtor_joao', 25000, shift(today, -28)); pay('demo_pay_j2', 'demo_debt_j2', 'demo_debtor_joao', 10000, shift(today, -4));
  pay('demo_pay_m1', 'demo_debt_m1', 'demo_debtor_maria', 30000, shift(today, -18));
  add('budgets', 'demo_budget_mercado', 'budgets', { categoryId: 'demo_cat_mercado', month: m0, limitCents: '600,00' });
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// Autorização
// ---------------------------------------------------------------------------------------------------------------
async function authorize(headers, admin) {
  const header = String(headers?.authorization ?? headers?.Authorization ?? '');
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) throw new FinanceError(401, 'UNAUTHENTICATED', 'Envie o Firebase ID token em Authorization: Bearer.');
  await enforceAppCheck(headers, admin, admin.env ?? process.env);
  let decoded;
  try { decoded = await admin.verifyIdToken(token); } catch { throw new FinanceError(401, 'INVALID_TOKEN', 'Token inválido ou expirado.'); }
  if (!decoded?.uid) throw new FinanceError(401, 'INVALID_TOKEN', 'Token sem usuário.');
  if (decoded.admin !== true) throw new FinanceError(403, 'FORBIDDEN', 'Recurso restrito a administradores.');
  const stillAdmin = await admin.isCurrentAdmin(decoded.uid).catch(() => false); // revogação vale na hora
  if (!stillAdmin) throw new FinanceError(403, 'FORBIDDEN', 'Recurso restrito a administradores.');
  return decoded.uid;
}

// ---------------------------------------------------------------------------------------------------------------
// Manifesto
// ---------------------------------------------------------------------------------------------------------------
const manifestRef = (db, uid) => db.doc(`users/${uid}/demoSeeds/current`);
async function readManifest(db, uid) {
  const snap = await manifestRef(db, uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  // O manifesto só vale para entradas que a Central PODE tocar: coleção permitida + ID demo_*.
  const items = (data.items ?? []).filter((i) => DEMO_COLLECTIONS.includes(i?.c) && isDemoId(i?.id));
  return { items, seededAt: data.seededAt?.toDate?.().toISOString() ?? null };
}

async function seed(db, uid) {
  const items = buildDemoSeed();
  try {
    await manifestRef(db, uid).create({ items: items.map((i) => ({ c: i.collection, id: i.id })), version: 1, seededAt: FieldValue.serverTimestamp() });
  } catch (error) {
    if (error?.code === 6) throw new FinanceError(409, 'ALREADY_SEEDED', 'Já existem dados de demonstração. Remova-os antes de popular de novo.');
    throw error;
  }
  for (let i = 0; i < items.length; i += 400) {
    const batch = db.batch();
    for (const it of items.slice(i, i + 400)) batch.create(db.doc(`users/${uid}/${it.collection}/${it.id}`), { ...it.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  return { created: items.length };
}

/** Remove artefatos de auditoria (operationId `demoaud-*`) e estornos de itens demo: nunca algo sem esses marcadores. */
async function removeArtifacts(db, uid) {
  const removed = {};
  const lo = AUDIT_KEY_PREFIX; const hi = `${AUDIT_KEY_PREFIX}`;
  for (const c of ARTIFACT_COLLECTIONS) {
    const col = db.collection(`users/${uid}/${c}`);
    const snap = c === 'operations' ? await col.where('__name__', '>=', col.doc(lo)).where('__name__', '<=', col.doc(hi)).get() : await col.where('operationId', '>=', lo).where('operationId', '<=', hi).get();
    for (const d of snap.docs) { if (!String(c === 'operations' ? d.id : d.data().operationId).startsWith(AUDIT_KEY_PREFIX)) continue; await d.ref.delete(); removed[c] = (removed[c] ?? 0) + 1; }
  }
  return removed;
}

async function cleanup(db, uid) {
  const manifest = await readManifest(db, uid);
  if (!manifest) return { deleted: 0, artifacts: await removeArtifacts(db, uid), note: 'Sem manifesto: nada de demonstração a remover (nenhum registro real é tocado).' };
  let deleted = 0;
  const REVERSIBLE = { incomes: 'incomes', expenses: 'expenses', transfers: 'transfers', invoices: 'invoices', debtPayments: 'debtPayments', goalTransactions: 'goalTransactions' };
  for (let i = 0; i < manifest.items.length; i += 200) {
    const batch = db.batch();
    for (const { c, id } of manifest.items.slice(i, i + 200)) {
      batch.delete(db.doc(`users/${uid}/${c}/${id}`)); deleted += 1;
      if (REVERSIBLE[c]) batch.delete(db.doc(`users/${uid}/reversals/${REVERSIBLE[c]}_${id}`));
    }
    await batch.commit();
  }
  const artifacts = await removeArtifacts(db, uid);
  await manifestRef(db, uid).delete();
  return { deleted, artifacts };
}

// ---------------------------------------------------------------------------------------------------------------
// Auditoria funcional
// ---------------------------------------------------------------------------------------------------------------
const run = (db, uid, op, key, params, deps) => {
  const def = registry.get(op);
  const clean = def.validate(params);
  return executeOnce({ db, uid, op, operationId: `${AUDIT_KEY_PREFIX}${key}`, params: clean, deps }, (ctx) => def.prepare(ctx, clean, `${AUDIT_KEY_PREFIX}${key}`));
};
/** Quantos documentos DE AUDITORIA (operationId `demoaud-*`) há na coleção: contagens da auditoria nunca dependem de dados reais. */
const auditCount = async (db, uid, c) => (await db.collection(`users/${uid}/${c}`).where('operationId', '>=', AUDIT_KEY_PREFIX).where('operationId', '<=', `${AUDIT_KEY_PREFIX}\uf8ff`).get()).size;
const rejection = async (promise) => { try { await promise; return null; } catch (e) { return e instanceof FinanceError ? e.code : `ERRO:${e?.message}`; } };

async function demoBalances(db, uid, manifest) {
  const ids = new Set(manifest.items.map((i) => `${i.c}/${i.id}`));
  const read = async (c) => (await db.collection(`users/${uid}/${c}`).get()).docs.map(plain);
  const [accounts, incomes, expenses, transfers, invoices, debtPayments, goalTransactions, reversals] = await Promise.all(['accounts', 'incomes', 'expenses', 'transfers', 'invoices', 'debtPayments', 'goalTransactions', 'reversals'].map(read));
  // Só as CONTAS são filtradas (demo): movimentos de qualquer origem só contam para a conta a que pertencem.
  const accs = accounts.filter((a) => ids.has(`accounts/${a.id}`));
  const demo = (list) => list;
  const balances = accountBalances(accs, { incomes: demo(incomes), expenses: demo(expenses), transfers: demo(transfers), invoices: demo(invoices), debtPayments: demo(debtPayments), goalTransactions: demo(goalTransactions), reversals });
  // ORÁCULO independente (laços simples sobre os documentos crus)
  const oracle = new Map(accs.map((a) => [a.id, a.initialBalanceCents]));
  const bump = (id, delta) => { if (oracle.has(id)) oracle.set(id, oracle.get(id) + delta); };
  const rev = new Set(reversals.map((r) => `${r.targetCollection}/${r.targetId}`));
  for (const i of demo(incomes)) if (i.status === 'received') bump(i.accountId, i.amountCents);
  for (const e of demo(expenses)) if (e.status === 'paid') bump(e.accountId, -e.amountCents);
  for (const t of demo(transfers)) if (t.status === 'confirmed') { bump(t.fromAccountId, -t.amountCents); bump(t.toAccountId, t.amountCents); }
  for (const f of demo(invoices)) if (f.status === 'paid') bump(f.accountId, -f.paidCents);
  for (const p of demo(debtPayments)) if (!rev.has(`debtPayments/${p.id}`)) bump(p.accountId, p.amountCents);
  for (const g of demo(goalTransactions)) if (!rev.has(`goalTransactions/${g.id}`)) bump(g.accountId, g.type === 'deposit' ? -g.amountCents : g.amountCents);
  return { balances, oracle };
}

async function realSnapshot(db, uid, manifest) {
  const ids = new Set(manifest.items.map((i) => `${i.c}/${i.id}`));
  const out = {};
  for (const c of [...DEMO_COLLECTIONS, 'reversals']) {
    for (const d of (await db.collection(`users/${uid}/${c}`).get()).docs) {
      if (ids.has(`${c}/${d.id}`) || String(d.data().operationId ?? '').startsWith(AUDIT_KEY_PREFIX)) continue; // só o manifesto e os artefatos da auditoria são "não reais"
      out[`${c}/${d.id}`] = d.updateTime.toMillis();
    }
  }
  return out;
}

async function audit(db, uid, deps) {
  const manifest = await readManifest(db, uid);
  if (!manifest) throw new FinanceError(409, 'NOT_SEEDED', 'Popule os dados de demonstração antes de executar a auditoria.');
  const runId = Math.random().toString(36).slice(2, 10);
  const key = (n) => `${runId}-${n}`;
  const before = await realSnapshot(db, uid, manifest);
  const results = [];
  const step = async (id, name, fn) => {
    try { const detail = await fn(); results.push({ id, name, ok: true, detail: detail ?? 'ok' }); } catch (error) { results.push({ id, name, ok: false, detail: String(error?.message ?? error) }); }
  };
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  const A = 'demo_acc_corrente'; const C = 'demo_acc_carteira'; const P = 'demo_acc_poupanca';
  const bal = async (id) => (await demoBalances(db, uid, manifest)).balances.get(id);
  const T = (from, to, cents, extra = {}) => ({ fromAccountId: from, toAccountId: to, amountCents: cents, date: todayInAppZone(), reason: 'Auditoria', status: 'confirmed', ...extra });

  await step('base', 'Integridade da base de demonstração (saldos × oráculo independente, devedores, faturas, metas)', async () => {
    const { balances, oracle } = await demoBalances(db, uid, manifest);
    for (const [id, expected] of oracle) { check(balances.get(id) === expected, `saldo de ${id}: app ${balances.get(id)} ≠ oráculo ${expected}`); check(expected >= 0, `saldo negativo em ${id}`); }
    const rd = async (c, id) => plain(await db.doc(`users/${uid}/${c}/${id}`).get());
    const pays = (await db.collection(`users/${uid}/debtPayments`).where('debtorId', '==', 'demo_debtor_joao').get()).docs.map(plain);
    const joao = await rd('debtors', 'demo_debtor_joao');
    check(joao.receivedCents === pays.reduce((t, p) => t + p.amountCents, 0), 'recebido do devedor ≠ soma dos recebimentos');
    const paidInv = await rd('invoices', `demo_card_visa_${monthOf(todayInAppZone(), 2)}`);
    const purch = (await db.collection(`users/${uid}/cardPurchases`).where('invoiceId', '==', paidInv.id).get()).docs.map(plain);
    check(paidInv.paidCents === purch.reduce((t, p) => t + p.amountCents, 0), 'fatura paga ≠ soma das compras');
    return `${oracle.size} contas conferidas`;
  });
  await step('transfer', 'Transferência conserva o dinheiro (débito e crédito juntos)', async () => {
    const [a0, c0] = [await bal(A), await bal(C)];
    await run(db, uid, 'transfer.create', key('t1'), T(A, C, 1000), deps);
    const [a1, c1] = [await bal(A), await bal(C)];
    check(a1 === a0 - 1000 && c1 === c0 + 1000, `deltas ${a1 - a0}/${c1 - c0}`);
    return 'origem −R$ 10,00 / destino +R$ 10,00';
  });
  await step('insufficient', 'Transferência acima do saldo é recusada e não grava nada', async () => {
    const c0 = await bal(C); const n0 = await auditCount(db, uid, 'transfers');
    const code = await rejection(run(db, uid, 'transfer.create', key('t2'), T(C, A, c0 + 1), deps));
    check(code === 'INSUFFICIENT_BALANCE', `código ${code}`);
    check((await auditCount(db, uid, 'transfers')) === n0, 'documento parcial gravado');
    return 'INSUFFICIENT_BALANCE';
  });
  await step('idempotency', 'Idempotência: mesma chave não duplica; payload diferente → OPERATION_ID_REUSED', async () => {
    const k = key('t3'); const n0 = await auditCount(db, uid, 'transfers');
    const r1 = await run(db, uid, 'transfer.create', k, T(A, C, 500), deps); const r2 = await run(db, uid, 'transfer.create', k, T(A, C, 500), deps);
    check(r1.idempotent === false && r2.idempotent === true && r1.transferId === r2.transferId, 'repetição não foi idempotente');
    check(await rejection(run(db, uid, 'transfer.create', k, T(A, C, 501), deps)) === 'OPERATION_ID_REUSED', 'payload diferente aceito');
    check((await auditCount(db, uid, 'transfers')) === n0 + 1, 'lançamento duplicado');
    return '1 documento, repetição idempotente';
  });
  await step('concurrency', 'Concorrência: duas transferências simultâneas que não cabem juntas — só uma passa', async () => {
    const c0 = await bal(C); const amount = Math.ceil(c0 * 0.6);
    const rs = await Promise.allSettled([run(db, uid, 'transfer.create', key('c1'), T(C, A, amount), deps), run(db, uid, 'transfer.create', key('c2'), T(C, A, amount), deps)]);
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    check(ok === 1, `${ok} transferências passaram`);
    check(rs.find((r) => r.status === 'rejected').reason?.code === 'INSUFFICIENT_BALANCE', 'recusa sem código esperado');
    check((await bal(C)) === c0 - amount && (await bal(C)) >= 0, 'saldo final incorreto');
    return `2 × ${amount} centavos: 1 passou, 1 recusada`;
  });
  await step('reversal', 'Estorno: devolve o saldo, preserva o original e só acontece uma vez', async () => {
    const a0 = await bal(A);
    const e = await run(db, uid, 'expense.create', key('e1'), { description: '[DEMO] Auditoria', categoryId: 'demo_cat_mercado', amountCents: 2500, accountId: A, purchaseDate: todayInAppZone(), dueDate: todayInAppZone(), status: 'paid' }, deps);
    check((await bal(A)) === a0 - 2500, 'despesa não debitou');
    await run(db, uid, 'reversal.create', key('r1'), { kind: 'expense', targetId: e.id, reason: 'Auditoria automatizada' }, deps);
    check((await bal(A)) === a0, 'estorno não devolveu o saldo');
    check(await rejection(run(db, uid, 'reversal.create', key('r2'), { kind: 'expense', targetId: e.id, reason: 'de novo' }, deps)) === 'ALREADY_REVERSED', 'estorno duplicado aceito');
    check((await db.doc(`users/${uid}/expenses/${e.id}`).get()).exists, 'original apagado');
    return 'saldo restaurado, 2º estorno recusado';
  });
  await step('debtor', 'Recebimento de devedor: parcial, excesso recusado, quitação e estorno reabrem a parcela', async () => {
    const dId = `${DEMO_PREFIX}aud_debtor_${runId}`; const pId = `${DEMO_PREFIX}aud_debt_${runId}`;
    const stamp = { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await db.doc(`users/${uid}/debtors/${dId}`).create({ name: '[DEMO] Auditoria', loanDate: toTs(todayInAppZone()), lentCents: 10000, receivedCents: 0, status: 'open', ...stamp });
    await db.doc(`users/${uid}/debts/${pId}`).create({ debtorId: dId, description: '[DEMO] Auditoria', principalCents: 10000, dueDate: toTs(todayInAppZone()), installmentNumber: 1, status: 'pending', ...stamp });
    const base = { debtId: pId, date: todayInAppZone(), accountId: A };
    const p1 = await run(db, uid, 'debt.receive', key('d1'), { ...base, amountCents: 4000 }, deps);
    check(p1.settled === false && p1.remainingCents === 6000, 'parcial incorreto');
    check(await rejection(run(db, uid, 'debt.receive', key('d2'), { ...base, amountCents: 6001 }, deps)) === 'EXCEEDS_REMAINING', 'excesso aceito');
    const p2 = await run(db, uid, 'debt.receive', key('d3'), { ...base, amountCents: 6000 }, deps);
    check(p2.settled === true && (await db.doc(`users/${uid}/debts/${pId}`).get()).data().status === 'paid', 'parcela não quitou');
    await run(db, uid, 'reversal.create', key('d4'), { kind: 'debtPayment', targetId: p2.paymentId, reason: 'Auditoria automatizada' }, deps);
    check((await db.doc(`users/${uid}/debts/${pId}`).get()).data().status === 'pending' && (await db.doc(`users/${uid}/debtors/${dId}`).get()).data().receivedCents === 4000, 'estorno não reabriu a parcela');
    await db.doc(`users/${uid}/debts/${pId}`).delete(); await db.doc(`users/${uid}/debtors/${dId}`).delete();
    return 'parcial, excesso, quitação e estorno corretos';
  });
  await step('invoice', 'Fatura fechada: o servidor paga a soma das compras (total adulterado é ignorado)', async () => {
    const iId = `${DEMO_PREFIX}aud_inv_${runId}`; const bId = `${DEMO_PREFIX}aud_buy_${runId}`;
    const stamp = { createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await db.doc(`users/${uid}/invoices/${iId}`).create({ cardId: 'demo_card_visa', referenceMonth: monthOf(todayInAppZone(), 5), closingDate: toTs(todayInAppZone()), dueDate: toTs(todayInAppZone()), status: 'closed', totalCents: 1, ...stamp });
    await db.doc(`users/${uid}/cardPurchases/${bId}`).create({ cardId: 'demo_card_visa', description: '[DEMO] Auditoria', amountCents: 3300, purchaseDate: toTs(todayInAppZone()), installmentsTotal: 1, installmentNumber: 1, invoiceId: iId, ...stamp });
    const a0 = await bal(A);
    const paid = await run(db, uid, 'invoice.pay', key('i1'), { invoiceId: iId, accountId: A }, deps);
    check(paid.paidCents === 3300, `pagou ${paid.paidCents}`);
    check((await bal(A)) === a0 - 3300, 'débito incorreto');
    await db.doc(`users/${uid}/invoices/${iId}`).delete(); await db.doc(`users/${uid}/cardPurchases/${bId}`).delete();
    return 'R$ 33,00 (soma das compras)';
  });
  await step('goal', 'Meta: resgate acima do guardado é recusado e o aporte respeita o saldo', async () => {
    const gId = `${DEMO_PREFIX}aud_goal_${runId}`;
    await db.doc(`users/${uid}/goals/${gId}`).create({ name: '[DEMO] Auditoria', targetCents: 100000, status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const p0 = await bal(P);
    await run(db, uid, 'goal.deposit', key('g1'), { goalId: gId, amountCents: 1000, date: todayInAppZone(), accountId: P }, deps);
    check((await bal(P)) === p0 - 1000, 'aporte não debitou');
    check(await rejection(run(db, uid, 'goal.withdraw', key('g2'), { goalId: gId, amountCents: 1001, date: todayInAppZone(), accountId: P }, deps)) === 'INVALID_STATE', 'resgate acima do guardado aceito');
    check(await rejection(run(db, uid, 'goal.deposit', key('g3'), { goalId: gId, amountCents: p0 + 1, date: todayInAppZone(), accountId: P }, deps)) === 'INSUFFICIENT_BALANCE', 'aporte sem saldo aceito');
    await db.doc(`users/${uid}/goals/${gId}`).delete();
    return 'aporte −R$ 10,00; resgate e aporte indevidos recusados';
  });

  // Limpa os artefatos da auditoria (a base de demonstração volta ao estado semeado) e prova o isolamento.
  const artifacts = await removeArtifacts(db, uid);
  for (const c of ['goals', 'debtors', 'debts', 'invoices', 'cardPurchases']) {
    for (const d of (await db.collection(`users/${uid}/${c}`).get()).docs) if (d.id.startsWith(`${DEMO_PREFIX}aud_`) && d.id.endsWith(`_${runId}`)) await d.ref.delete();
  }
  const after = await realSnapshot(db, uid, manifest);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
  await step('isolation', 'Nenhum dado real foi criado, alterado ou apagado pela auditoria', async () => { check(changed.length === 0, `registros reais afetados: ${changed.slice(0, 5).join(', ')}`); return `${Object.keys(before).length} registros reais intactos`; });
  const { balances, oracle } = await demoBalances(db, uid, manifest);
  await step('restored', 'Base de demonstração restaurada ao estado semeado após a limpeza dos artefatos', async () => { for (const [id, expected] of oracle) check(balances.get(id) === expected, `saldo de ${id} ≠ oráculo`); return 'saldos conferem com o oráculo'; });
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, passed: results.length - failed, failed, scenarios: results, realRecordsChecked: Object.keys(before).length, artifactsRemoved: artifacts, runId };
}

// ---------------------------------------------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------------------------------------------
export async function handleValidation({ method, headers = {}, body } = {}, deps = {}) {
  const log = deps.log ?? ((entry) => console.info(JSON.stringify(entry)));
  try {
    if (method !== 'POST') return json(405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    const base = deps.db ? deps : getAdmin();
    const admin = { ...base, isCurrentAdmin: deps.isCurrentAdmin ?? (async (uid) => (await getAuth().getUser(uid)).customClaims?.admin === true), ...deps };
    const uid = await authorize(headers, admin);
    const payload = typeof body === 'string' ? JSON.parse(body) : body;
    const op = payload?.op;
    const db = admin.db;
    let result;
    if (op === 'status') {
      const m = await readManifest(db, uid);
      result = { seeded: Boolean(m), items: m?.items.length ?? 0, seededAt: m?.seededAt ?? null };
    } else if (op === 'seed') {
      if (payload.confirm !== CONFIRM.seed) throw new FinanceError(400, 'CONFIRMATION_REQUIRED', `Digite a frase de confirmação: ${CONFIRM.seed}.`);
      result = await seed(db, uid);
    } else if (op === 'cleanup') {
      if (payload.confirm !== CONFIRM.cleanup) throw new FinanceError(400, 'CONFIRMATION_REQUIRED', `Digite a frase de confirmação: ${CONFIRM.cleanup}.`);
      result = await cleanup(db, uid);
    } else if (op === 'audit') {
      result = await audit(db, uid, admin);
    } else throw new FinanceError(400, 'UNKNOWN_OP', 'Operação desconhecida.');
    log({ event: 'validation_center', op, uid: `${uid.slice(0, 4)}…` });
    return json(200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof FinanceError) return json(error.status, { ok: false, error: error.code, message: error.message });
    if (error instanceof SyntaxError) return json(400, { ok: false, error: 'INVALID_BODY', message: 'JSON inválido.' });
    log({ event: 'validation_center_error', message: String(error?.message ?? error).slice(0, 200) });
    return json(500, { ok: false, error: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }
}
