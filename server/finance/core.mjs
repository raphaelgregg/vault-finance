/**
 * Camada confiável de processamento financeiro (VF-ARQ-02) — Firebase Admin SDK + transações do Firestore.
 *
 * Princípios:
 *  - o servidor NUNCA confia em saldo/total/status enviados pelo navegador: lê tudo no Firestore dentro da transação;
 *  - AUTENTICAÇÃO por Firebase ID token (Admin `verifyIdToken`); todo caminho de documento é montado a partir do `uid`
 *    do token (`users/{uid}/...`), então um usuário jamais alcança documentos de outro;
 *  - IDEMPOTÊNCIA: `users/{uid}/operations/{operationId}` é gravado NA MESMA transação da movimentação (exatamente uma
 *    vez). Mesma chave + mesmos parâmetros ⇒ devolve o resultado guardado; mesma chave + parâmetros diferentes ⇒ 409;
 *  - SERIALIZAÇÃO: toda operação que altera saldo LÊ e ESCREVE o documento da conta (`ledgerSeq`) — duas transações na
 *    mesma conta conflitam no próprio documento e uma é repetida pelo SDK, então a checagem de saldo disponível dentro
 *    da transação nunca enxerga um estado velho. Operações de devedor serializam no documento do devedor;
 *  - em transação do Admin SDK todas as LEITURAS vêm antes das ESCRITAS: cada operação é `prepare(ctx) → { result, apply }`.
 * O Admin SDK ignora as Security Rules: toda validação necessária está aqui.
 */
import { createHash } from 'node:crypto';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { accountBalances } from '../../js/core/model.js';
import { isDateFieldName, parseIsoDate, dateToIsoDate } from '../../js/utils/dates.js';
import { isValidIsoDate } from '../../js/core/model.js';
import { assertNoEmulatorInProduction as guardEmulatorEnv } from '../env-guard.mjs';

export { FieldValue, Timestamp };

/** Erro de negócio/validação com status HTTP e código estável (identificável pelo cliente). */
export class FinanceError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const HISTORY_LIMIT = 5000; // movimentos lidos por consulta na transação (acima: recusa, nunca saldo incompleto)

// ---------------------------------------------------------------------------------------------------------------
// Admin SDK
// ---------------------------------------------------------------------------------------------------------------

/** Credencial do servidor (variável de ambiente; nunca no navegador). Emulador não precisa de credencial. */
function serviceAccountFromEnv(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('"')) text = Buffer.from(text, 'base64').toString('utf8');
  let parsed = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return { ...parsed, private_key: String(parsed.private_key ?? '').replace(/\\r\\n|\\n/g, '\n').trim() };
}

/** VF-SEC-02: ver `server/env-guard.mjs`. */
export function assertNoEmulatorInProduction(env = process.env) {
  try { guardEmulatorEnv(env); } catch (error) { throw new FinanceError(500, error.code ?? 'EMULATOR_IN_PRODUCTION', error.message); }
}

/**
 * VF-SEC-03/06 — políticas de acesso opcionais, ligadas por variável de ambiente (desligadas por padrão, para não
 * bloquear usuários antes de o cliente/console estarem prontos):
 *  - APPCHECK_ENFORCE=true      exige o cabeçalho `X-Firebase-AppCheck` com token válido (só o app real chama a API);
 *  - REQUIRE_VERIFIED_EMAIL=true exige `email_verified` no ID token (contas novas verificam o e-mail no cadastro).
 * `verifyAppCheck` é injetável nos testes.
 */
export async function enforceAppCheck(headers = {}, admin = {}, env = process.env) {
  if (env.APPCHECK_ENFORCE !== 'true') return;
  const token = String(headers['x-firebase-appcheck'] ?? headers['X-Firebase-AppCheck'] ?? '').trim();
  if (!token) throw new FinanceError(401, 'APPCHECK_REQUIRED', 'Requisição sem App Check: recarregue o aplicativo.');
  try { await (admin.verifyAppCheck ?? ((t) => getAppCheck().verifyToken(t)))(token); } catch { throw new FinanceError(401, 'APPCHECK_INVALID', 'App Check inválido ou expirado: recarregue o aplicativo.'); }
}
export function enforceVerifiedEmail(decoded, env = process.env) {
  if (env.REQUIRE_VERIFIED_EMAIL === 'true' && decoded?.email_verified !== true) {
    throw new FinanceError(403, 'EMAIL_NOT_VERIFIED', 'Confirme seu e-mail (enviamos um link no cadastro) para continuar.');
  }
}

/** VF-SEC-01: janela máxima (s) entre o login e uma operação destrutiva sensível. */
export const RECENT_LOGIN_SECONDS = 300;

let defaultAdmin = null;
/** Admin SDK padrão (db + auth). Em testes injeta-se `deps` e isto não é chamado. */
export function getAdmin(env = process.env) {
  assertNoEmulatorInProduction(env);
  if (defaultAdmin) return defaultAdmin;
  const emulator = Boolean(env.FIRESTORE_EMULATOR_HOST);
  const projectId = env.FIREBASE_PROJECT_ID || env.GCLOUD_PROJECT || 'vault-finance-d1603';
  if (!getApps().length) {
    const account = emulator ? null : serviceAccountFromEnv(env);
    if (!emulator && !account) throw new FinanceError(501, 'SERVER_NOT_CONFIGURED', 'Credencial do servidor ausente (FIREBASE_SERVICE_ACCOUNT).');
    initializeApp(account ? { credential: cert(account), projectId } : { projectId });
  }
  const db = getFirestore();
  try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* já inicializado por outro módulo/teste: segue com as configurações existentes */ }
  defaultAdmin = { db, // checkRevoked=true: conta desativada/sessão revogada deixam de valer na hora (VF-SEC-01), não em até 1 h.
  verifyIdToken: (token) => getAuth().verifyIdToken(token, true) };
  return defaultAdmin;
}

// ---------------------------------------------------------------------------------------------------------------
// Validação de parâmetros
// ---------------------------------------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_:.-]{8,100}$/;
export const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão: teto de sanidade (evita estouro/lixo)

export const v = {
  operationId(value) {
    if (typeof value !== 'string' || !OPERATION_ID_RE.test(value)) throw new FinanceError(400, 'INVALID_OPERATION_ID', 'operationId inválido (8 a 100 caracteres: letras, números, _ - : .).');
    return value;
  },
  id(value, field) {
    if (typeof value !== 'string' || !ID_RE.test(value)) throw new FinanceError(400, 'INVALID_PARAM', `Parâmetro "${field}" inválido.`, { field });
    return value;
  },
  cents(value, field = 'amountCents') {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_CENTS) throw new FinanceError(400, 'INVALID_AMOUNT', `"${field}" deve ser um inteiro de centavos maior que zero.`, { field });
    return value;
  },
  date(value, field = 'date') {
    if (typeof value !== 'string' || !isValidIsoDate(value)) throw new FinanceError(400, 'INVALID_DATE', `"${field}" deve ser uma data AAAA-MM-DD válida.`, { field });
    return value;
  },
  text(value, field, { min = 0, max = 500, required = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required || min > 0) throw new FinanceError(400, 'INVALID_PARAM', `"${field}" é obrigatório.`, { field });
      return undefined;
    }
    if (typeof value !== 'string') throw new FinanceError(400, 'INVALID_PARAM', `"${field}" deve ser texto.`, { field });
    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) throw new FinanceError(400, 'INVALID_PARAM', `"${field}" deve ter de ${min} a ${max} caracteres.`, { field });
    return trimmed || undefined;
  },
  enum(value, field, allowed) {
    if (!allowed.includes(value)) throw new FinanceError(400, 'INVALID_PARAM', `"${field}" deve ser um de: ${allowed.join(', ')}.`, { field });
    return value;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------------------------------------------

/** Documento do Admin SDK → objeto do modelo (datas só-dia como "AAAA-MM-DD", como `fromFirestoreDoc` no cliente). */
export function plain(snap) {
  const out = { id: snap.id };
  for (const [key, value] of Object.entries(snap.data() ?? {})) {
    out[key] = value && typeof value.toDate === 'function' && isDateFieldName(key) ? dateToIsoDate(value.toDate()) : value;
  }
  return out;
}

/** "AAAA-MM-DD" → Timestamp (meio-dia UTC): mesma convenção de gravação do cliente. */
export const toTs = (iso) => Timestamp.fromDate(parseIsoDate(iso));

export const stamps = (create = false) => ({ ...(create ? { createdAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });

export const requestHash = (op, params) => createHash('sha256').update(canonical({ op, params })).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------------------------------------------
// Contexto de transação
// ---------------------------------------------------------------------------------------------------------------

/** Acesso às coleções do usuário DENTRO da transação (todos os caminhos nascem do `uid` autenticado). */
export function makeCtx(db, tx, uid, deps = {}) {
  const col = (name) => db.collection(`users/${uid}/${name}`);
  const ref = (name, id) => db.doc(`users/${uid}/${name}/${id}`);
  const ctx = {
    db, tx, uid, col, ref, deps,
    now: () => (deps.now ? deps.now() : new Date()),
    async get(name, id) {
      const snap = await tx.get(ref(name, id));
      return snap.exists ? plain(snap) : null;
    },
    async query(name, ...filters) {
      let q = col(name);
      for (const [field, op, value] of filters) q = q.where(field, op, value);
      const snap = await tx.get(q.limit(HISTORY_LIMIT));
      if (snap.size >= HISTORY_LIMIT) throw new FinanceError(500, 'HISTORY_TOO_LARGE', `Histórico de "${name}" acima do limite verificável (${HISTORY_LIMIT}); arquive o período antigo.`);
      return snap.docs.map(plain);
    },
    /** Conta ativa do usuário (existência + propriedade pelo caminho); lança 404/409 identificáveis. */
    async account(id, { allowInactive = false } = {}) {
      const a = await ctx.get('accounts', id);
      if (!a) throw new FinanceError(404, 'ACCOUNT_NOT_FOUND', 'Conta não encontrada.', { accountId: id });
      if (!allowInactive && a.status !== 'active') throw new FinanceError(409, 'ACCOUNT_NOT_ACTIVE', 'A conta precisa estar ativa (contas inativas ou arquivadas não recebem lançamentos).', { accountId: id });
      return a;
    },
    /** Saldo DERIVADO atual da conta, lido dentro da transação (todas as fontes de movimento + estornos). */
    async balanceOf(account) {
      const id = account.id;
      const [incomes, expenses, invoices, debtPayments, goalTransactions, out, inn, reversals] = await Promise.all([
        ctx.query('incomes', ['accountId', '==', id], ['status', '==', 'received']),
        ctx.query('expenses', ['accountId', '==', id], ['status', '==', 'paid']),
        ctx.query('invoices', ['accountId', '==', id], ['status', '==', 'paid']),
        ctx.query('debtPayments', ['accountId', '==', id]),
        ctx.query('goalTransactions', ['accountId', '==', id]),
        ctx.query('transfers', ['fromAccountId', '==', id], ['status', '==', 'confirmed']),
        ctx.query('transfers', ['toAccountId', '==', id], ['status', '==', 'confirmed']),
        ctx.query('reversals', ['accountId', '==', id]),
      ]);
      const reversed = new Set(reversals.map((r) => `${r.targetCollection}/${r.targetId}`));
      const live = (name, rows) => rows.filter((r) => !reversed.has(`${name}/${r.id}`));
      const transfers = [...new Map([...out, ...inn].map((t) => [t.id, t])).values()];
      return accountBalances([account], {
        incomes, expenses, invoices, transfers,
        debtPayments: live('debtPayments', debtPayments),
        goalTransactions: live('goalTransactions', goalTransactions),
      }).get(id) ?? 0;
    },
    /** Marca a conta como tocada (serialização por conflito de documento) — chamar em toda operação que altera saldo. */
    touchAccount(accountId) { tx.update(ref('accounts', accountId), { ledgerSeq: FieldValue.increment(1), ...stamps() }); },
    audit(entry) {
      tx.create(col('auditLog').doc(), { ...entry, actorUid: uid, createdAt: FieldValue.serverTimestamp() });
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Execução idempotente
// ---------------------------------------------------------------------------------------------------------------

/**
 * Executa `prepare(ctx)` ({ result, apply(ctx) }) numa transação com idempotência. `result` precisa ser JSON.
 * Retorna { ...result, operationId, idempotent }.
 */
export async function executeOnce({ db, uid, op, operationId, params, deps = {} }, prepare) {
  const hash = requestHash(op, params);
  const opRef = db.doc(`users/${uid}/operations/${operationId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (snap.exists) {
      const stored = snap.data();
      if (stored.requestHash !== hash) throw new FinanceError(409, 'OPERATION_ID_REUSED', 'Este operationId já foi usado em outra operação ou com outros parâmetros.');
      return { ...stored.result, operationId, idempotent: true };
    }
    const ctx = makeCtx(db, tx, uid, deps);
    const prepared = await prepare(ctx);
    const result = JSON.parse(JSON.stringify(prepared.result)); // só JSON (sem undefined) no registro e na resposta
    await prepared.apply(ctx);
    tx.create(opRef, { op, requestHash: hash, status: 'completed', result, createdAt: FieldValue.serverTimestamp() });
    ctx.audit({ action: op, entity: 'operations', entityId: operationId, after: summarize(result) });
    return { ...result, operationId, idempotent: false };
  });
}

/** Resumo do resultado para a auditoria (só ids/valores, sem dados pessoais). */
function summarize(result) {
  const out = {};
  for (const [k, val] of Object.entries(result)) if (['string', 'number', 'boolean'].includes(typeof val)) out[k] = val;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------------------------------------------

/** Registro de operações: nome → { validate(params) → params normalizados, prepare(ctx, params, operationId) }. */
export const registry = new Map();
export const defineOp = (name, def) => registry.set(name, def);

const json = (status, body) => ({ status, body });

/** Falhas de infraestrutura que o cliente pode repetir com a MESMA operationId. */
const RETRYABLE = new Set([4, 10, 13, 14]); // DEADLINE_EXCEEDED, ABORTED, INTERNAL, UNAVAILABLE (códigos gRPC)

/**
 * Falha transitória de transação (nada foi confirmado): contenção/expiração. Inclui "Transaction is invalid or closed"
 * (INVALID_ARGUMENT quando a transação expira sob contenção). Seguro reexecutar: a operação é idempotente.
 */
export const isTransient = (error) => RETRYABLE.has(error?.code) || /Transaction is invalid or closed|too much contention/i.test(String(error?.message ?? ''));
export const SERVER_ATTEMPTS = 4;

/** Backoff linear (25 ms × tentativa) + jitter (0–39 ms). */
export const retryDelayMs = (attempt, random = Math.random) => 25 * attempt + Math.floor(random() * 40);

/**
 * Reexecuta `fn` (uma operação IDEMPOTENTE) em falha transitória, no máximo SERVER_ATTEMPTS vezes no total. Erros de negócio
 * (`FinanceError`) e qualquer erro não transitório são propagados na hora. `sleep`/`random` injetáveis nos testes.
 */
export async function withRetries(fn, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await fn(); } catch (error) {
      if (error instanceof FinanceError || !isTransient(error) || attempt >= SERVER_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt, random));
    }
  }
}

/**
 * Handler HTTP agnóstico: `{ method, headers, body }` → `{ status, body }`. `deps`: { db, verifyIdToken, now } (testes
 * injetam; produção usa `getAdmin()`).
 */
export async function handleFinance({ method, headers = {}, body }, deps = {}) {
  const log = deps.log ?? ((entry) => console.info(JSON.stringify(entry)));
  try {
    if (method !== 'POST') return json(405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    const admin = deps.db ? deps : { ...getAdmin(), ...deps };
    const auth = String(headers.authorization ?? headers.Authorization ?? '');
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!token) return json(401, { ok: false, error: 'UNAUTHENTICATED', message: 'Envie o Firebase ID token em Authorization: Bearer.' });
    await enforceAppCheck(headers, admin, deps.env ?? process.env); // antes do Auth: barra bots sem custo de leitura
    let decoded;
    try { decoded = await admin.verifyIdToken(token); } catch { return json(401, { ok: false, error: 'INVALID_TOKEN', message: 'Token inválido ou expirado.' }); }
    const uid = decoded?.uid;
    if (!uid) return json(401, { ok: false, error: 'INVALID_TOKEN', message: 'Token sem usuário.' });
    enforceVerifiedEmail(decoded, deps.env ?? process.env);

    const payload = typeof body === 'string' ? JSON.parse(body) : body;
    if (!payload || typeof payload !== 'object') throw new FinanceError(400, 'INVALID_BODY', 'Corpo JSON inválido.');
    const { op, operationId, params = {} } = payload;
    const def = registry.get(op);
    if (!def) throw new FinanceError(400, 'UNKNOWN_OPERATION', 'Operação desconhecida.');
    v.operationId(operationId);
    if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new FinanceError(400, 'INVALID_PARAM', '"params" deve ser um objeto.');
    // O cliente NUNCA define saldo, total recebido ou status financeiro: campos proibidos são recusados, não ignorados.
    for (const forbidden of ['balanceCents', 'receivedCents', 'status', 'uid', 'userId']) {
      if (forbidden in params && !def.allowParams?.includes(forbidden)) throw new FinanceError(400, 'FORBIDDEN_PARAM', `"${forbidden}" não é aceito do cliente.`, { field: forbidden });
    }
    // VF-SEC-01: operações destrutivas exigem login recente (`auth_time` do token); token roubado/antigo não apaga dados.
    if (def.recentLogin) {
      const authTime = Number(decoded.auth_time);
      const nowS = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
      if (!Number.isFinite(authTime) || nowS - authTime > RECENT_LOGIN_SECONDS) {
        throw new FinanceError(403, 'RECENT_LOGIN_REQUIRED', 'Por segurança, saia e entre novamente na sua conta e repita a operação.');
      }
    }
    const clean = def.validate(params);
    const started = Date.now();
    const result = await withRetries(() => (def.run
      ? def.run({ db: admin.db, uid, op, operationId, params: clean, deps: admin })
      : executeOnce({ db: admin.db, uid, op, operationId, params: clean, deps: admin }, (ctx) => def.prepare(ctx, clean, operationId))));
    log({ event: 'finance_op', op, operationId, uid: `${uid.slice(0, 4)}…`, idempotent: Boolean(result.idempotent), ms: Date.now() - started });
    return json(200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof FinanceError) {
      log({ event: 'finance_rejected', status: error.status, code: error.code });
      return json(error.status, { ok: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof SyntaxError) return json(400, { ok: false, error: 'INVALID_BODY', message: 'JSON inválido.' });
    const retry = isTransient(error);
    log({ event: 'finance_error', code: error?.code ?? 'unknown', message: String(error?.message ?? error).slice(0, 200) });
    return json(retry ? 503 : 500, { ok: false, error: retry ? 'TEMPORARILY_UNAVAILABLE' : 'INTERNAL_ERROR', message: retry ? 'Falha temporária: repita com o mesmo operationId.' : 'Erro interno.', retryable: retry });
  }
}
