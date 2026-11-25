/**
 * VF-2-03ac — CSV unificado (todas as entidades), isolamento por uid, ordem de dependência e idempotência.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../../js/utils/csv.js';
import { parseMoneyToCents } from '../../js/core/model.js';
import {
  IMPORT_ENTITIES, IMPORT_ORDER, IMPORT_IDENTITY, UNIFIED_KEY, UNIFIED_COLUMN,
  unifiedHeaders, unifiedTemplateRows, resolveEntityKey, mergeDiff, filledFields, buildMergeRaw,
} from '../../js/core/importSchema.js';
import {
  dryRunImport, applyImport, loadImportData, exportUnifiedCsv, exportCsv, exportAllCsv, unifiedTemplateCsv, templateCsv,
} from '../../js/services/importer.js';

const ME = 'uid-dono';
const OTHER = 'uid-outro';

/** Base em memória por uid: { uid: { coleção: [docs] } } — acessível só por `list(uid, coleção)`. */
function makeDb(seed = {}) {
  const db = { [ME]: {}, [OTHER]: {}, ...seed };
  const calls = [];
  let n = 0;
  const table = (uid, c) => (db[uid][c] ??= []);
  const list = async (uid, collection) => { calls.push({ uid, collection }); return structuredClone(table(uid, collection)); };
  const id = (p) => `${p}${(n += 1)}`;
  const cents = (v) => parseMoneyToCents(v);
  const moneyDoc = (entity, raw) => {
    const doc = { ...raw };
    for (const c of IMPORT_ENTITIES[entity].columns) if (c.type === 'money' && raw[c.field] !== undefined) doc[c.field] = cents(raw[c.field]);
    return doc;
  };
  const insert = (uid, collection, doc) => { const row = { id: id(collection[0]), ...doc }; table(uid, collection).push(row); return row.id; };
  const creators = {
    contas: async (uid, raw) => ({ ok: true, id: insert(uid, 'accounts', moneyDoc('contas', raw)) }),
    categorias: async (uid, raw) => ({ ok: true, id: insert(uid, 'categories', raw) }),
    cartoes: async (uid, raw) => ({ ok: true, id: insert(uid, 'creditCards', moneyDoc('cartoes', raw)) }),
    devedores: async (uid, raw) => ({ ok: true, id: insert(uid, 'debtors', { ...moneyDoc('devedores', raw), receivedCents: 0, status: 'open' }) }),
    receitas: async (uid, raw) => ({ ok: true, id: insert(uid, 'incomes', moneyDoc('receitas', raw)) }),
    despesas: async (uid, raw) => ({ ok: true, id: insert(uid, 'expenses', moneyDoc('despesas', raw)) }),
    transferencias: async (uid, raw) => ({ ok: true, id: insert(uid, 'transfers', moneyDoc('transferencias', raw)) }),
    assinaturas: async (uid, raw) => ({ ok: true, id: insert(uid, 'subscriptions', moneyDoc('assinaturas', raw)) }),
    metas: async (uid, raw) => ({ ok: true, id: insert(uid, 'goals', moneyDoc('metas', raw)) }),
    dividas: async (uid, raw) => {
      const total = cents(raw.totalCents);
      const group = id('g');
      const ids = Array.from({ length: raw.installments }, (_, i) => insert(uid, 'debts', { debtorId: raw.debtorId, description: raw.description, principalCents: Math.floor(total / raw.installments) + (i === 0 ? total % raw.installments : 0), dueDate: i === 0 ? raw.firstDueDate : `${Number(raw.firstDueDate.slice(0, 4)) + 1}-0${i}-10`, installmentNumber: i + 1, installmentsTotal: raw.installments, debtGroupId: group, status: 'pending' }));
      return { ok: true, ids };
    },
    compras_cartao: async (uid, raw) => {
      const total = cents(raw.amountCents);
      const n2 = raw.installmentsTotal ?? 1;
      const ids = Array.from({ length: n2 }, (_, i) => insert(uid, 'cardPurchases', { cardId: raw.cardId, description: raw.description, amountCents: Math.floor(total / n2) + (i === 0 ? total % n2 : 0), purchaseDate: raw.purchaseDate, installmentsTotal: n2, installmentNumber: i + 1, debtorId: raw.debtorId }));
      return { ok: true, ids };
    },
  };
  const updated = [];
  const updaters = Object.fromEntries(['contas', 'categorias', 'cartoes', 'devedores', 'metas'].map((entity) => [entity, async (uid, docId, raw) => {
    updated.push({ entity, uid, docId, raw });
    const collection = { contas: 'accounts', categorias: 'categories', cartoes: 'creditCards', devedores: 'debtors', metas: 'goals' }[entity];
    const doc = table(uid, collection).find((d) => d.id === docId);
    Object.assign(doc, moneyDoc(entity, raw));
    return { ok: true };
  }]));
  return { db, calls, io: { list, creators, updaters }, updated, insert, table };
}

const HEADERS = unifiedHeaders();
/** Linha do CSV unificado: só as colunas informadas (nomes do modelo em português), o resto vazio. */
const line = (entity, v = {}) => HEADERS.map((h) => (h === UNIFIED_COLUMN ? entity : (v[h] ?? ''))).join(';');
/** Arquivo de teste com as 11 entidades, propositalmente FORA de ordem (dependentes antes das dependências). */
const buildCsv = ({ catColor = '#c0392b', accountStatus = 'active', goalTarget = '10000,00' } = {}) => [
  HEADERS.join(';'),
  line('compras_cartao', { cartao: 'Nubank', descricao: 'Geladeira', valor_total: '900,00', parcelas: '3', data_compra: '2026-12-01', devedor: 'Maria' }),
  line('dividas', { devedor: 'Maria', descricao: 'Moto', total: '600,00', parcelas: '3', primeiro_vencimento: '2026-12-10' }),
  line('metas', { nome: 'Caixinha', objetivo: goalTarget, prazo: '2027-12-31', conta: 'Corrente' }),
  line('assinaturas', { nome: 'Netflix', valor: '55,90', periodicidade: 'monthly', proxima_cobranca: '2026-12-10', conta: 'Corrente', categoria: 'Assinaturas' }),
  line('transferencias', { origem: 'Corrente', destino: 'Caixinha Conta', valor: '500,00', data: '2026-12-02', motivo: 'Reserva', status: 'pending' }),
  line('despesas', { descricao: 'Supermercado', categoria: 'Mercado', valor: '350,90', data_compra: '2026-12-01', vencimento: '2026-12-01', conta: 'Corrente', recorrencia: 'none' }),
  line('receitas', { descricao: 'Salário', categoria: 'Salário', valor: '5000,00', data_prevista: '2026-12-05', conta: 'Corrente', recorrencia: 'none' }),
  line('devedores', { nome: 'Maria', data: '2026-12-01', valor_emprestado: '0,00' }),
  line('cartoes', { nome: 'Nubank', bandeira: 'Mastercard', limite: '5000,00', dia_fechamento: '10', dia_vencimento: '17' }),
  line('categorias', { nome: 'Mercado', tipo: 'expense', cor: catColor }),
  line('categorias', { nome: 'Salário', tipo: 'income', cor: '#1f8a5b' }),
  line('categorias', { nome: 'Assinaturas', tipo: 'expense', cor: '#e67e22' }),
  line('contas', { instituicao: 'Banco', nome: 'Corrente', tipo: 'checking', saldo_inicial: '1000,00', cor: '#1f7a5c', status: accountStatus }),
  line('contas', { instituicao: 'Nubank', nome: 'Caixinha Conta', tipo: 'savings', saldo_inicial: '0,00', cor: '#1f7a5c', status: 'active' }),
].join('\n');
const unifiedCsv = buildCsv();

describe('formato do CSV unificado', () => {
  it('cabeçalho: `entidade` + união das colunas (sem repetir); modelo = 1 linha por entidade, na ordem de dependência', () => {
    const headers = unifiedHeaders();
    assert.equal(headers[0], UNIFIED_COLUMN);
    assert.equal(new Set(headers).size, headers.length);
    for (const entity of IMPORT_ORDER) for (const c of IMPORT_ENTITIES[entity].columns) assert.ok(headers.includes(c.name), `${entity}.${c.name}`);
    const { rows } = unifiedTemplateRows();
    assert.deepEqual(rows.map((r) => r[0]), [...IMPORT_ORDER]);
    assert.deepEqual(IMPORT_ORDER.slice(0, 4), ['contas', 'categorias', 'cartoes', 'devedores']);
    const parsed = parseCsv(unifiedTemplateCsv());
    assert.deepEqual(parsed.headers, headers);
    assert.equal(parsed.rows.length, IMPORT_ORDER.length);
    // cada linha-modelo só preenche as colunas da SUA entidade
    for (const r of parsed.rows) {
      const own = new Set(IMPORT_ENTITIES[r.values[UNIFIED_COLUMN]].columns.map((c) => c.name));
      for (const [name, value] of Object.entries(r.values)) if (name !== UNIFIED_COLUMN && value !== '') assert.ok(own.has(name), `${r.values[UNIFIED_COLUMN]} preencheu ${name}`);
    }
    assert.equal(parseCsv(templateCsv('despesas')).rows.length, 0); // modelo por entidade continua VAZIO
  });
  it('a coluna `entidade` aceita chave, rótulo e variações sem acento/caixa', () => {
    assert.deepEqual(['contas', 'CARTOES', 'Cartões', 'compras_cartao', 'Compras no cartão', 'dívidas', 'foguete'].map(resolveEntityKey), ['contas', 'cartoes', 'cartoes', 'compras_cartao', 'compras_cartao', 'dividas', null]);
    assert.equal(resolveEntityKey('dividas'), 'dividas');
    assert.equal(resolveEntityKey(''), null);
  });
});

describe('isolamento por uid (inclusive administrador)', () => {
  it('exportar (unificado, por entidade e zip) lê SÓ o uid autenticado; nada do outro usuário aparece', async () => {
    const { db, io, calls, insert } = makeDb();
    insert(ME, 'accounts', { institution: 'Banco', name: 'Minha Conta', type: 'checking', initialBalanceCents: 1000, color: '#111', status: 'active' });
    insert(OTHER, 'accounts', { institution: 'Banco', name: 'Conta Secreta Alheia', type: 'checking', initialBalanceCents: 99999, color: '#222', status: 'active' });
    insert(OTHER, 'expenses', { description: 'Gasto Alheio', amountCents: 123, purchaseDate: '2026-01-01', dueDate: '2026-01-01' });
    const unified = await exportUnifiedCsv(ME, { io });
    const single = await exportCsv(ME, 'contas', { io });
    const zip = await exportAllCsv(ME, { io });
    for (const text of [unified.text, single.text, new TextDecoder().decode(zip.zip)]) {
      assert.ok(text.includes('Minha Conta'));
      assert.doesNotMatch(text, /Secreta Alheia|Gasto Alheio/);
    }
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.uid === ME), 'toda leitura é do uid autenticado');
    assert.equal(db[OTHER].accounts.length, 1);
  });
  it('importar (dry-run + efetivação) lê e grava SÓ sob o uid autenticado', async () => {
    const m = makeDb();
    m.insert(OTHER, 'categories', { name: 'Mercado', kind: 'expense', color: '#000' }); // existe só para o OUTRO
    const data = await loadImportData(ME, m.io);
    assert.equal(data.categories.length, 0); // não enxerga a categoria do outro
    const plan = dryRunImport(UNIFIED_KEY, unifiedCsv, data);
    assert.equal(plan.counts.create, 14); // Mercado é criada para o DONO (não "já existe")
    const writes = [];
    const spy = Object.fromEntries(Object.entries(m.io.creators).map(([k, f]) => [k, async (uid, raw) => { writes.push(uid); return f(uid, raw); }]));
    await applyImport(ME, plan, { io: { ...m.io, creators: spy } });
    assert.ok(writes.length > 0 && writes.every((u) => u === ME));
    assert.ok(m.calls.every((c) => c.uid === ME));
    assert.equal(m.db[OTHER].categories.length, 1); // o outro usuário não foi tocado
    assert.equal(m.db[ME].accounts.length, 2);
  });
  it('o módulo de importação/exportação não tem caminho privilegiado (sem consulta de grupo, claim ou uid alheio)', () => {
    for (const file of ['../../js/services/importer.js', '../../js/core/importSchema.js', '../../js/utils/csv.js']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /collectionGroup|listCollectionGroup|listGroup|isAdminUser|claims|targetUid/);
    }
    const ui = readFileSync(new URL('../../js/modules/manutencao-dados.js', import.meta.url), 'utf8');
    for (const call of ui.match(/(?:dryRunImport|applyImport|exportCsv|exportAllCsv|exportUnifiedCsv|loadImportData)\([^)]*\)/g) ?? []) {
      if (/^(applyImport|exportCsv|exportAllCsv|exportUnifiedCsv|loadImportData)/.test(call)) assert.match(call, /user\.uid/, call); // sempre o uid autenticado
    }
  });
});

describe('importação unificada: ordem de dependência e idempotência', () => {
  it('arquivo fora de ordem: dry-run resolve referências criadas no próprio arquivo e processa na ordem contas → categorias → cartões → devedores → demais', async () => {
    const m = makeDb();
    const data = await loadImportData(ME, m.io);
    const plan = dryRunImport(UNIFIED_KEY, unifiedCsv, data);
    assert.deepEqual(plan.fileErrors, []);
    assert.deepEqual(plan.counts, { create: 14, merge: 0, duplicate: 0, error: 0 });
    const order = [];
    const spy = Object.fromEntries(Object.entries(m.io.creators).map(([k, f]) => [k, async (u, raw) => { order.push(k); return f(u, raw); }]));
    const res = await applyImport(ME, plan, { io: { ...m.io, creators: spy } });
    assert.deepEqual([res.created, res.merged, res.ignored, res.failed], [14, 0, 0, 0]);
    const firsts = [...new Set(order)];
    assert.deepEqual(firsts, [...IMPORT_ORDER]); // cada entidade só depois das suas dependências
    // referências por nome viraram os ids REAIS criados (e não os "planned:")
    const account = m.db[ME].accounts.find((a) => a.name === 'Corrente');
    assert.equal(m.db[ME].expenses[0].accountId, account.id);
    assert.equal(m.db[ME].cardPurchases[0].cardId, m.db[ME].creditCards[0].id);
    assert.equal(m.db[ME].cardPurchases[0].debtorId, m.db[ME].debtors[0].id);
    assert.equal(m.db[ME].transfers[0].toAccountId, m.db[ME].accounts.find((a) => a.name === 'Caixinha Conta').id);
    assert.ok(JSON.stringify(m.db[ME]).indexOf('planned:') === -1);
    assert.equal(m.db[ME].debts.length, 3);
    assert.equal(m.db[ME].debts.reduce((t, d) => t + d.principalCents, 0), 60000);
  });
  it('reimportar o MESMO arquivo não duplica: tudo ignorado por duplicidade, nenhuma gravação', async () => {
    const m = makeDb();
    await applyImport(ME, dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io)), { io: m.io });
    const before = JSON.stringify(m.db[ME]);
    const plan2 = dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io));
    assert.deepEqual(plan2.counts, { create: 0, merge: 0, duplicate: 14, error: 0 });
    const writes = [];
    const spy = Object.fromEntries(Object.entries(m.io.creators).map(([k, f]) => [k, async (...a) => { writes.push(k); return f(...a); }]));
    const res = await applyImport(ME, plan2, { io: { ...m.io, creators: spy } });
    assert.deepEqual([res.created, res.merged, res.ignored, res.failed], [0, 0, 14, 0]);
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify(m.db[ME]), before);
  });
  it('linha repetida no próprio arquivo é criada UMA vez; as outras viram duplicadas', async () => {
    const m = makeDb();
    const dup = `${unifiedCsv}\n${line('categorias', { nome: 'mercado', tipo: 'expense', cor: '#000000' })}`; // mesmo nome (sem caixa) e tipo
    const plan = dryRunImport(UNIFIED_KEY, dup, await loadImportData(ME, m.io));
    assert.deepEqual([plan.counts.create, plan.counts.duplicate], [14, 1]);
    assert.match(plan.rows.at(-1).reason, /repetida no próprio arquivo/);
    const res = await applyImport(ME, plan, { io: m.io });
    assert.equal(m.db[ME].categories.filter((c) => c.name.toLowerCase() === 'mercado').length, 1);
    assert.equal(res.ignored, 1);
  });
  it('atualiza/mescla só campos preenchidos e diferentes (conta/categoria/cartão/devedor/meta); célula vazia e padrões NÃO sobrescrevem', async () => {
    const m = makeDb();
    await applyImport(ME, dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io)), { io: m.io });
    // altera o estado: conta inativa; no CSV, status vazio (padrão active NÃO conta)
    m.table(ME, 'accounts').find((a) => a.name === 'Corrente').status = 'inactive';
    const changed = buildCsv({ catColor: '#112233', accountStatus: '', goalTarget: '12000,00' }); // cor, status vazio e objetivo
    const plan = dryRunImport(UNIFIED_KEY, changed, await loadImportData(ME, m.io));
    assert.deepEqual(plan.counts, { create: 0, merge: 2, duplicate: 12, error: 0 });
    const res = await applyImport(ME, plan, { io: m.io });
    assert.deepEqual([res.created, res.merged, res.ignored, res.failed], [0, 2, 12, 0]);
    assert.deepEqual(m.updated.map((u) => [u.entity, u.uid]).sort(), [['categorias', ME], ['metas', ME]]);
    assert.equal(m.table(ME, 'categories').find((c) => c.name === 'Mercado').color, '#112233');
    assert.equal(m.table(ME, 'goals')[0].targetCents, 1200000);
    assert.equal(m.table(ME, 'accounts').find((a) => a.name === 'Corrente').status, 'inactive'); // não foi sobrescrito
    const goalUpdate = m.updated.find((u) => u.entity === 'metas').raw;
    assert.deepEqual([goalUpdate.name, goalUpdate.targetCents, goalUpdate.deadline], ['Caixinha', '12000,00', '2027-12-31']); // demais campos preservados
  });
  it('erros: entidade desconhecida, referência inexistente e falha de leitura da base (não importa às cegas)', async () => {
    const m = makeDb();
    const data = await loadImportData(ME, m.io);
    const bad = [unifiedCsv, line('foguete', { nome: 'X' }), line('despesas', { descricao: 'Sem Cat', categoria: 'Inexistente', valor: '10,00', data_compra: '2026-12-01', vencimento: '2026-12-01', conta: 'Conta Fantasma' })].join('\n');
    const plan = dryRunImport(UNIFIED_KEY, bad, data);
    const errors = plan.rows.filter((r) => r.action === 'error');
    assert.equal(errors.length, 2);
    assert.match(errors.find((e) => !e.entity).errors[UNIFIED_COLUMN], /Entidade desconhecida/);
    assert.ok(errors.find((e) => e.entity === 'despesas').errors.categoria);
    const failing = await loadImportData(ME, { list: async (u, c) => { if (c === 'expenses') throw Object.assign(new Error('negado'), { code: 'permission-denied' }); return []; } });
    const blocked = dryRunImport(UNIFIED_KEY, unifiedCsv, failing);
    assert.equal(blocked.rows.length, 0);
    assert.match(blocked.fileErrors[0].message, /Falha ao ler "expenses".*duplicar/);
    assert.deepEqual(dryRunImport(UNIFIED_KEY, 'nome;tipo\nA;x', data).missingColumns, ['entidade']);
  });
  it('permission-denied na gravação é contado e destacado; as demais linhas seguem', async () => {
    const m = makeDb();
    const denied = { ...m.io.creators, categorias: async () => { throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); } };
    const plan = dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io));
    const res = await applyImport(ME, plan, { io: { ...m.io, creators: denied } });
    assert.equal(res.permissionDenied, 3);
    assert.ok(res.created >= 2);
    assert.ok(res.entries.filter((e) => e.permissionDenied).every((e) => e.entity === 'categorias'));
  });
});

describe('chaves determinísticas (identidade) por entidade', () => {
  const k = (entity, raw) => IMPORT_IDENTITY[entity].key(raw);
  it('nomes normalizados (acento/caixa/espaços) e tipo/conta compõem a identidade', () => {
    assert.equal(k('contas', { institution: 'Banco', name: 'Poupança' }), k('contas', { institution: ' BANCO ', name: 'poupanca' }));
    assert.notEqual(k('categorias', { name: 'X', kind: 'expense' }), k('categorias', { name: 'X', kind: 'income' }));
    for (const e of ['cartoes', 'devedores', 'metas']) assert.equal(k(e, { name: 'José' }), k(e, { name: 'jose ' }));
    assert.notEqual(k('assinaturas', { name: 'Netflix', accountId: 'a' }), k('assinaturas', { name: 'Netflix', accountId: 'b' }));
  });
  it('movimentações/dívidas/compras: cada atributo-chave diferencia (valor em centavos, datas, conta, parcela, referência)', () => {
    const base = { description: 'Mercado', amountCents: '10,00', purchaseDate: '2026-12-01', dueDate: '2026-12-01', accountId: 'a' };
    assert.equal(k('despesas', base), k('despesas', { ...base, description: ' mercado', amountCents: 1000 })); // texto × centavos
    for (const change of [{ amountCents: '10,01' }, { purchaseDate: '2026-12-02' }, { dueDate: '2026-12-02' }, { accountId: 'b' }, { description: 'Outro' }]) assert.notEqual(k('despesas', base), k('despesas', { ...base, ...change }), JSON.stringify(change));
    const tr = { fromAccountId: 'a', toAccountId: 'b', amountCents: '5,00', date: '2026-12-01', reason: 'x' };
    for (const change of [{ fromAccountId: 'c' }, { toAccountId: 'c' }, { amountCents: '5,01' }, { date: '2026-12-02' }, { reason: 'y' }]) assert.notEqual(k('transferencias', tr), k('transferencias', { ...tr, ...change }));
    const pl = { debtorId: 'd', description: 'Moto', totalCents: '600,00', installments: 3, firstDueDate: '2026-12-10' };
    for (const change of [{ debtorId: 'e' }, { totalCents: '600,01' }, { installments: 4 }, { firstDueDate: '2026-12-11' }]) assert.notEqual(k('dividas', pl), k('dividas', { ...pl, ...change }));
    assert.equal(k('dividas', pl), k('dividas', { ...pl, totalCents: 60000, installments: undefined === 3 ? 3 : 3 }));
    const cp = { cardId: 'c', description: 'TV', amountCents: '900,00', installmentsTotal: 3, purchaseDate: '2026-12-01', debtorId: 'd' };
    for (const change of [{ cardId: 'x' }, { amountCents: '900,01' }, { installmentsTotal: 2 }, { purchaseDate: '2026-12-02' }, { debtorId: 'z' }]) assert.notEqual(k('compras_cartao', cp), k('compras_cartao', { ...cp, ...change }));
  });
  it('mergeDiff/buildMergeRaw: só campos preenchidos e diferentes; entidades de fato não mesclam', () => {
    const existing = { id: 'm1', name: 'Meta', targetCents: 100000, deadline: '2027-01-01', accountId: 'a', description: 'x' };
    const values = { nome: 'Meta', objetivo: '1500,00', prazo: '', conta: '', descricao: '' };
    const raw = { name: 'Meta', targetCents: '1500,00', deadline: undefined };
    const diff = mergeDiff('metas', raw, existing, filledFields('metas', values));
    assert.deepEqual(diff, ['targetCents']);
    assert.deepEqual(buildMergeRaw('metas', existing, raw, diff), { name: 'Meta', targetCents: '1500,00', deadline: '2027-01-01', accountId: 'a', description: 'x' });
    assert.deepEqual(mergeDiff('despesas', { description: 'a', amountCents: '1,00' }, { description: 'a' }), []);
  });
});

describe('exportação unificada: ida e volta idempotente', () => {
  it('exportar a base populada e reimportar o MESMO arquivo → 100% duplicadas (nada criado)', async () => {
    const m = makeDb();
    await applyImport(ME, dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io)), { io: m.io });
    const logs = [];
    const exported = await exportUnifiedCsv(ME, { io: m.io, onLog: (r) => logs.push(r) });
    assert.deepEqual([exported.exported, exported.failed], [11, 0]);
    assert.equal(logs.length, 11);
    assert.equal(exported.totalRows, 2 + 3 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1); // dívidas e compras saem AGRUPADAS (1 linha cada)
    const parsed = parseCsv(exported.text);
    assert.deepEqual(parsed.headers, unifiedHeaders());
    assert.deepEqual([...new Set(parsed.rows.map((r) => r.values[UNIFIED_COLUMN]))], [...IMPORT_ORDER].filter((e) => parsed.rows.some((r) => r.values[UNIFIED_COLUMN] === e)));
    const again = dryRunImport(UNIFIED_KEY, exported.text, await loadImportData(ME, m.io));
    assert.deepEqual(again.counts, { create: 0, merge: 0, duplicate: parsed.rows.length, error: 0 }, JSON.stringify(again.rows.filter((r) => r.action === 'error').map((r) => r.errors)));
    assert.equal(exported.filename.startsWith('vault-todas-entidades-'), true);
  });
  it('falha de leitura de UMA coleção não derruba o arquivo: entidade fica de fora e é reportada', async () => {
    const m = makeDb();
    await applyImport(ME, dryRunImport(UNIFIED_KEY, unifiedCsv, await loadImportData(ME, m.io)), { io: m.io });
    const flaky = { ...m.io, list: async (u, c) => { if (c === 'incomes') throw Object.assign(new Error('x'), { code: 'permission-denied' }); return m.io.list(u, c); } };
    const r = await exportUnifiedCsv(ME, { io: flaky });
    assert.deepEqual([r.exported, r.failed], [10, 1]);
    assert.equal(r.results.find((x) => !x.ok).key, 'receitas');
    assert.ok(parseCsv(r.text).rows.every((row) => row.values[UNIFIED_COLUMN] !== 'receitas'));
  });
});

describe('VF-SEC-08 — neutralização de fórmula inclui "-" em texto', () => {
  it('texto iniciado por -, =, +, @ é prefixado; números e valores monetários negativos ficam intactos', async () => {
    const { csvField } = await import('../../js/utils/csv.js');
    for (const t of ['-2+3', '-cmd|x', '=1+1', '+1', '@SUM(A1)']) assert.equal(csvField(t), `'${t}`, t);
    assert.equal(csvField(-5), '-5');
    assert.equal(csvField('-12,50'), '-12,50');
    assert.equal(csvField('-1.234,56'), '-1.234,56');
    assert.equal(csvField('Mercado - mês'), 'Mercado - mês');
  });
});
