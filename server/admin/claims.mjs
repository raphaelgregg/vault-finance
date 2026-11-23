/**
 * Administradores (claim `admin`) — lógica de SERVIDOR (Node ≥ 18, sem dependências). VF-2-03aa/03ab.
 *
 * `customUserClaims` só podem ser gravadas com privilégio administrativo (Admin SDK / API administrativa do
 * Identity Toolkit); o cliente NUNCA se auto-promove. Esta função roda na Vercel (`api/admin-claims.mjs`) e guarda a
 * service account SÓ em variável de ambiente do servidor.
 *
 * Fluxo (defesa em camadas), igual para GET (listar) e POST (promover/revogar):
 *  1. valida o ID token do Firebase LOCALMENTE (RS256 com as chaves públicas atuais do Google; iss/aud/exp/sub).
 *     Não usa a chave de API web: ela é restrita por referenciador HTTP no Google Cloud e requisições de
 *     servidor (sem Referer) são recusadas — foi a causa do 401 em produção (VF-2-03ab);
 *  2. credencial do servidor (service account → token OAuth2); sem ela, 501/502 (erro de CONFIGURAÇÃO, não 401);
 *  3. lê o estado ATUAL do chamador na API administrativa (`accounts:lookup`) e exige `admin === true` (403);
 *  4. GET lista usuários (`accounts:batchGet`, paginado); POST grava `customAttributes` preservando as demais
 *     claims e impede a auto-revogação.
 * Toda rejeição registra um MOTIVO técnico em `console.error` (sem token, chave ou dados pessoais).
 *
 * Env (servidor): `FIREBASE_SERVICE_ACCOUNT` (JSON, JSON entre aspas ou base64; `private_key` aceita `\n` literal),
 * opcionais `FIREBASE_PROJECT_ID` (padrão: o do app). Emulador (`FIREBASE_AUTH_EMULATOR_HOST`): tokens sem assinatura,
 * `Bearer owner`, sem service account.
 */
import { createSign, createVerify, createPublicKey } from 'node:crypto';
import { firebaseConfig } from '../../js/firebase/config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_TARGET = 128;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5; // teto de 5.000 usuários por listagem
const CLOCK_SKEW_S = 300;

const json = (status, body) => ({ status, body });
const fail = (status, error, message) => json(status, { ok: false, error, message });
const b64url = (input) => Buffer.from(input).toString('base64url');

/** Registro de diagnóstico para os logs da Vercel: só códigos/motivos, nunca tokens, chaves ou e-mails. */
function reject(status, error, message, detail = {}) {
  console.error(JSON.stringify({ event: 'admin_claims_rejected', status, reason: error, ...detail }));
  return fail(status, error, message);
}

// ---------------------------------------------------------------------------
// Service account
// ---------------------------------------------------------------------------

/** JWT RS256 (grant de service account). */
export function signServiceAccountJwt(account, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
}

/** `private_key` colada em env costuma vir com `\n` LITERAL (barra + n) — vira quebra de linha real. */
export const normalizePrivateKey = (key) => String(key ?? '').replace(/\\r\\n|\\n/g, '\n').trim();

/**
 * Lê a service account do ambiente. Aceita JSON, JSON entre aspas (simples/duplas) ou base64 do JSON; tolera espaços
 * e `\n` literal na chave. Retorna { account } ou { error: 'motivo' } (sem expor o conteúdo).
 */
export function parseServiceAccount(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { error: 'empty' };
  const candidates = [];
  const unquoted = /^(['"])([\s\S]*)\1$/.exec(text)?.[2];
  if (unquoted) candidates.push(unquoted);
  candidates.push(text);
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) candidates.push(Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8'));
  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed); // JSON dentro de string (dupla codificação)
      if (parsed?.client_email && parsed?.private_key) {
        const key = normalizePrivateKey(parsed.private_key);
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) return { error: 'private_key_format' };
        return { account: { ...parsed, private_key: key } };
      }
      return { error: 'missing_fields' };
    } catch { /* tenta a próxima forma */ }
  }
  return { error: 'unparseable' };
}

/** Compat: devolve a conta ou null. */
export const readServiceAccount = (env) => parseServiceAccount(env?.FIREBASE_SERVICE_ACCOUNT).account ?? null;

let cachedToken = null; // { value, exp, email }
let cachedCerts = null; // { certs, exp }

/** Limpa caches (testes). */
export function resetAdminClaimsCache() {
  cachedToken = null;
  cachedCerts = null;
}

/** Credencial do servidor: { token, base } | { error: { status, code, message } }. */
async function serverCredential({ env, fetch, now }) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST) return { token: 'owner', base: `http://${env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` };
  const parsed = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!parsed.account) {
    const code = parsed.error === 'empty' ? 'not_configured' : 'bad_service_account';
    return { error: { status: code === 'not_configured' ? 501 : 500, code, message: code === 'not_configured' ? 'Servidor sem FIREBASE_SERVICE_ACCOUNT: a administração de usuários não está configurada.' : 'FIREBASE_SERVICE_ACCOUNT inválida (formato). Verifique o valor na Vercel.', detail: { configProblem: parsed.error } } };
  }
  const { account } = parsed;
  if (cachedToken && cachedToken.email === account.client_email && cachedToken.exp > now() + 60000) {
    return { token: cachedToken.value, base: 'https://identitytoolkit.googleapis.com' };
  }
  let assertion;
  try {
    assertion = signServiceAccountJwt(account, now());
  } catch {
    return { error: { status: 500, code: 'bad_service_account', message: 'A chave privada da service account é inválida.', detail: { configProblem: 'sign_failed' } } };
  }
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
  } catch {
    return { error: { status: 502, code: 'server_credential_failed', message: 'Não foi possível contatar o Google para obter a credencial do servidor.', detail: { step: 'token_exchange_network' } } };
  }
  if (!res.ok) {
    let google = null;
    try { google = (await res.json())?.error; } catch { /* sem corpo */ }
    return { error: { status: 502, code: 'server_credential_failed', message: 'O Google recusou a credencial da service account (confira a chave/projeto).', detail: { step: 'token_exchange', http: res.status, google: typeof google === 'string' ? google : undefined } } };
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: now() + (Number(data.expires_in) || 3600) * 1000, email: account.client_email };
  return { token: data.access_token, base: 'https://identitytoolkit.googleapis.com' };
}

// ---------------------------------------------------------------------------
// ID token do Firebase (verificação local RS256)
// ---------------------------------------------------------------------------

async function googleCerts({ fetch, now }) {
  if (cachedCerts && cachedCerts.exp > now()) return cachedCerts.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`certs_http_${res.status}`);
  const certs = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers?.get?.('cache-control') ?? '')?.[1]) || 3600;
  cachedCerts = { certs, exp: now() + maxAge * 1000 };
  return certs;
}

/**
 * Verifica o ID token localmente. Retorna { ok: true, uid } ou { ok: false, reason, status? }.
 * `reason`: token_malformed | token_alg | token_kid_unknown | token_signature | token_expired | token_not_yet_valid |
 * token_aud | token_iss | token_sub | certs_unavailable (este com status 502: não é culpa do token).
 */
export async function verifyFirebaseIdToken(idToken, { projectId, fetch, now }) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'token_malformed' };
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'token_malformed' };
  }
  if (header?.alg !== 'RS256') return { ok: false, reason: 'token_alg' };
  let certs;
  try {
    certs = await googleCerts({ fetch, now });
  } catch {
    return { ok: false, reason: 'certs_unavailable', status: 502 };
  }
  const pem = certs?.[header.kid];
  if (!pem) return { ok: false, reason: 'token_kid_unknown' };
  let valid = false;
  try {
    valid = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey(pem), parts[2], 'base64url');
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'token_signature' };
  const nowS = Math.floor(now() / 1000);
  if (!(Number(payload.exp) > nowS)) return { ok: false, reason: 'token_expired' };
  if (Number(payload.iat) > nowS + CLOCK_SKEW_S) return { ok: false, reason: 'token_not_yet_valid' };
  if (payload.aud !== projectId) return { ok: false, reason: 'token_aud' };
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false, reason: 'token_iss' };
  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'token_sub' };
  return { ok: true, uid: payload.sub };
}

// ---------------------------------------------------------------------------
// Guarda de administrador (comum a GET e POST)
// ---------------------------------------------------------------------------

const parseClaims = (user) => {
  try { return JSON.parse(user?.customAttributes || '{}') ?? {}; } catch { return {}; }
};

async function authorizeAdmin(request, { env, fetch, now }) {
  const auth = String(request.headers?.authorization ?? request.headers?.Authorization ?? '');
  const idToken = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!idToken) return { response: reject(401, 'missing_token', 'Envie o ID token no cabeçalho Authorization: Bearer.', { step: 'bearer' }) };

  const projectId = env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
  const emulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);
  let uid;
  if (emulator) {
    // Emulador: tokens sem assinatura — valida pela consulta do próprio emulador.
    try {
      const res = await fetch(`http://${env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=emulator`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
      });
      if (!res.ok) return { response: reject(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.', { step: 'emulator_lookup', http: res.status }) };
      uid = (await res.json())?.users?.[0]?.localId;
    } catch {
      return { response: reject(502, 'auth_unreachable', 'Não foi possível validar a sessão agora.', { step: 'emulator_lookup_network' }) };
    }
    if (!uid) return { response: reject(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.', { step: 'emulator_lookup_empty' }) };
  } else {
    const verified = await verifyFirebaseIdToken(idToken, { projectId, fetch, now });
    if (!verified.ok) {
      if (verified.status === 502) return { response: reject(502, 'auth_unreachable', 'Não foi possível validar a sessão agora (chaves públicas do Google indisponíveis).', { step: 'certs' }) };
      return { response: reject(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.', { step: 'verify_id_token', tokenReason: verified.reason }) };
    }
    uid = verified.uid;
  }

  const creds = await serverCredential({ env, fetch, now });
  if (creds.error) return { response: reject(creds.error.status, creds.error.code, creds.error.message, creds.error.detail) };
  const adminUrl = (path) => `${creds.base}/v1/projects/${encodeURIComponent(projectId)}/${path}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` };

  let caller;
  try {
    const res = await fetch(adminUrl('accounts:lookup'), { method: 'POST', headers, body: JSON.stringify({ localId: [uid] }) });
    if (!res.ok) return { response: reject(502, 'lookup_failed', 'Falha ao consultar a conta do chamador.', { step: 'caller_lookup', http: res.status }) };
    caller = (await res.json())?.users?.[0];
  } catch {
    return { response: reject(502, 'lookup_failed', 'Falha ao consultar a conta do chamador.', { step: 'caller_lookup_network' }) };
  }
  if (!caller?.localId) return { response: reject(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.', { step: 'caller_not_found' }) };
  if (caller.disabled) return { response: reject(403, 'disabled', 'Conta desativada.', { step: 'caller_disabled' }) };
  if (parseClaims(caller).admin !== true) return { response: reject(403, 'forbidden', 'Apenas administradores podem acessar a administração de usuários.', { step: 'caller_not_admin' }) };
  return { caller, adminUrl, headers };
}

/** Lista usuários (paginada) com o indicador `admin`. */
async function listUsers({ adminUrl, headers, fetch }) {
  const users = [];
  let pageToken = '';
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${adminUrl('accounts:batchGet')}?maxResults=${PAGE_SIZE}${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { method: 'GET', headers: { authorization: headers.authorization } });
    if (!res.ok) throw new Error(`batchget_http_${res.status}`);
    const data = await res.json();
    for (const u of data?.users ?? []) {
      users.push({ uid: u.localId, email: u.email ?? null, displayName: u.displayName ?? null, disabled: Boolean(u.disabled), admin: parseClaims(u).admin === true, createdAt: u.createdAt ? Number(u.createdAt) : null });
    }
    pageToken = data?.nextPageToken ?? '';
    if (!pageToken) return { users, truncated };
  }
  truncated = Boolean(pageToken);
  return { users, truncated };
}

/** Admins primeiro, depois por e-mail. */
const byAdminThenEmail = (a, b) => Number(b.admin) - Number(a.admin) || String(a.email ?? a.uid).localeCompare(String(b.email ?? b.uid));

/**
 * Processa o pedido. `request`: { method, headers, body }. `deps`: { env, fetch, now } injetáveis.
 * GET → lista; POST → promove/revoga. Retorna { status, body } — nunca lança por erro do chamador.
 */
export async function handleAdminClaims(request, { env = process.env, fetch = globalThis.fetch, now = Date.now } = {}) {
  const method = request?.method;
  if (method !== 'POST' && method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET (listar) ou POST (promover/revogar).');

  let target = '';
  let wantAdmin;
  if (method === 'POST') {
    let body = request.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    target = typeof body?.target === 'string' ? body.target.trim() : '';
    wantAdmin = body?.admin;
    // Autorização antes da validação do corpo vazaria só o formato; mantemos 400 ANTES para não gastar credencial.
    if (!target || target.length > MAX_TARGET || typeof wantAdmin !== 'boolean') {
      return fail(400, 'invalid_body', 'Informe `target` (uid ou e-mail) e `admin` (true/false).');
    }
  }

  const guard = await authorizeAdmin(request, { env, fetch, now });
  if (guard.response) return guard.response;
  const { caller, adminUrl, headers } = guard;

  if (method === 'GET') {
    try {
      const { users, truncated } = await listUsers({ adminUrl, headers, fetch });
      return json(200, { ok: true, users: users.sort(byAdminThenEmail), truncated, total: users.length, me: caller.localId });
    } catch (error) {
      return reject(502, 'list_failed', 'Falha ao listar os usuários.', { step: 'batch_get', error: String(error?.message ?? error).slice(0, 60) });
    }
  }

  let targetUser;
  try {
    const query = target.includes('@') ? { email: [target.toLowerCase()] } : { localId: [target] };
    const res = await fetch(adminUrl('accounts:lookup'), { method: 'POST', headers, body: JSON.stringify(query) });
    if (!res.ok) return reject(502, 'lookup_failed', 'Falha ao consultar o usuário alvo.', { step: 'target_lookup', http: res.status });
    targetUser = (await res.json())?.users?.[0];
  } catch {
    return reject(502, 'lookup_failed', 'Falha ao consultar o usuário alvo.', { step: 'target_lookup_network' });
  }
  if (!targetUser?.localId) return fail(404, 'target_not_found', 'Usuário alvo não encontrado.');
  if (wantAdmin === false && targetUser.localId === caller.localId) {
    return fail(400, 'self_revoke', 'Você não pode revogar a própria claim de administrador (peça a outro administrador).');
  }

  const claims = parseClaims(targetUser);
  const previousAdmin = claims.admin === true;
  if (wantAdmin) claims.admin = true; else delete claims.admin;
  try {
    const res = await fetch(adminUrl('accounts:update'), {
      method: 'POST', headers, body: JSON.stringify({ localId: targetUser.localId, customAttributes: JSON.stringify(claims) }),
    });
    if (!res.ok) return reject(502, 'update_failed', 'Falha ao gravar a claim do usuário.', { step: 'update', http: res.status });
  } catch {
    return reject(502, 'update_failed', 'Falha ao gravar a claim do usuário.', { step: 'update_network' });
  }
  console.info(JSON.stringify({ event: 'admin_claim_changed', by: caller.localId, target: targetUser.localId, admin: wantAdmin, previousAdmin }));
  return json(200, {
    ok: true,
    target: { uid: targetUser.localId, email: targetUser.email ?? null },
    admin: wantAdmin,
    previousAdmin,
    note: 'O usuário precisa sair e entrar de novo (ou renovar o token) para a claim valer; o token atual pode levar até 1 hora para expirar.',
  });
}
