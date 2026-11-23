/**
 * VF-2-03aa/03ab — administradores: servidor (service account, ID token RS256 local, estado atual, listagem,
 * promoção/revogação, erros de configuração × token inválido) e cliente (validação, endpoint, auditoria, lista).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import {
  handleAdminClaims, signServiceAccountJwt, readServiceAccount, parseServiceAccount, normalizePrivateKey,
  verifyFirebaseIdToken, resetAdminClaimsCache,
} from '../../server/admin/claims.mjs';
import { setAdminClaim, parseAdminTarget, listAdminUsers, buildAdminUserRows, ADMIN_CLAIMS_ENDPOINT } from '../../js/services/adminClaims.js';

const PROJECT = 'proj';
const NOW = Date.UTC(2026, 10, 19, 12);
const nowS = Math.floor(NOW / 1000);
const pemOf = (key, type) => key.export({ type, format: 'pem' });

const svc = generateKeyPairSync('rsa', { modulusLength: 2048 }); // service account
const google = generateKeyPairSync('rsa', { modulusLength: 2048 }); // chave "securetoken" do Google (kid k1)
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 }); // atacante
const account = { client_email: 'svc@test.iam.gserviceaccount.com', private_key: pemOf(svc.privateKey, 'pkcs8') };
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify(account), FIREBASE_PROJECT_ID: PROJECT };

/** ID token RS256 como o do Firebase. */
function mkToken(sub, { key = google.privateKey, kid = 'k1', alg = 'RS256', aud = PROJECT, iss = `https://securetoken.google.com/${PROJECT}`, exp = nowS + 3600, iat = nowS - 10 } = {}) {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub, aud, iss, exp, iat, auth_time: iat })).toString('base64url');
  const sig = alg === 'RS256' ? createSign('RSA-SHA256').update(`${h}.${p}`).sign(key, 'base64url') : '';
  return `${h}.${p}.${sig}`;
}

const baseUsers = () => [
  { localId: 'adm1', email: 'adm@x.com', displayName: 'Admin Um', customAttributes: JSON.stringify({ admin: true }), createdAt: '1' },
  { localId: 'u1', email: 'user@x.com', customAttributes: JSON.stringify({ plan: 'pro' }) },
  { localId: 'u2', email: 'outro@x.com' },
  { localId: 'adm2', email: 'adm2@x.com', customAttributes: JSON.stringify({ admin: true, role: 'x' }) },
  { localId: 'off', email: 'off@x.com', disabled: true, customAttributes: JSON.stringify({ admin: true }) },
  { localId: 'ex', email: 'ex@x.com', customAttributes: JSON.stringify({}) },
];

/** Fake do Google: certs, OAuth, Identity Toolkit administrativo (lookup/update/batchGet). */
function makeGoogle({ users = baseUsers(), pageSize = 1000, tokenStatus = 200, batchStatus = 200, certsStatus = 200 } = {}) {
  const calls = [];
  const reply = (status, data, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => data });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    assert.doesNotMatch(u, /[?&]key=(?!emulator)/, 'produção não usa a chave de API web (restrita por referenciador)');
    if (u.includes('/robot/v1/metadata/x509/')) return certsStatus === 200 ? reply(200, { k1: pemOf(google.publicKey, 'spki') }, { 'cache-control': 'public, max-age=100' }) : reply(certsStatus, {});
    if (u.startsWith('https://oauth2.googleapis.com/token')) return tokenStatus === 200 ? reply(200, { access_token: 'SERVER_TOKEN', expires_in: 3600 }) : reply(tokenStatus, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    assert.equal(init.headers.authorization, 'Bearer SERVER_TOKEN');
    if (u.endsWith(`/projects/${PROJECT}/accounts:lookup`)) {
      const found = body.localId ? users.filter((x) => body.localId.includes(x.localId)) : users.filter((x) => body.email.includes(x.email));
      return reply(200, found.length ? { users: found } : {});
    }
    if (u.endsWith(`/projects/${PROJECT}/accounts:update`)) return reply(200, { localId: body.localId });
    if (u.includes(`/projects/${PROJECT}/accounts:batchGet`)) {
      if (batchStatus !== 200) return reply(batchStatus, {});
      const start = Number(new URL(u).searchParams.get('nextPageToken') || 0);
      const slice = users.slice(start, start + pageSize);
      return reply(200, { users: slice, ...(start + pageSize < users.length ? { nextPageToken: String(start + pageSize) } : {}) });
    }
    return reply(500, {});
  };
  return { fetch, calls, updates: () => calls.filter((c) => c.url.endsWith('accounts:update')).map((c) => c.body) };
}

const req = (token, body, method = 'POST') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
const deps = (g) => ({ env, fetch: g.fetch, now: () => NOW });

/** Captura console.error do servidor (diagnóstico para os logs da Vercel). */
function captureErrors(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (m) => logs.push(String(m));
  return Promise.resolve().then(fn).then((r) => { console.error = orig; return [r, logs]; }, (e) => { console.error = orig; throw e; });
}

beforeEach(() => resetAdminClaimsCache());

describe('FIREBASE_SERVICE_ACCOUNT: parsing tolerante e erros de configuração claros', () => {
  const json = JSON.stringify(account);
  it('aceita JSON, JSON entre aspas (simples/duplas), base64 e espaços/quebras ao redor', () => {
    for (const raw of [json, `  ${json}\n`, `'${json}'`, Buffer.from(json).toString('base64'), JSON.stringify(json)]) {
      const r = parseServiceAccount(raw);
      assert.equal(r.account?.client_email, account.client_email, raw.slice(0, 30));
    }
  });
  it('`private_key` com \\n LITERAL (barra+n) é normalizada para quebras reais e a chave assina de verdade', () => {
    const literal = JSON.stringify({ ...account, private_key: account.private_key.replace(/\n/g, '\\n') }).replace(/\\\\n/g, '\\\\n');
    const doubleEscaped = json.replace(/\\n/g, '\\\\n'); // após JSON.parse sobra `\n` literal na chave
    for (const raw of [literal, doubleEscaped]) {
      const { account: parsed } = parseServiceAccount(raw);
      assert.ok(parsed.private_key.includes('\n') && !parsed.private_key.includes('\\n'));
      const jwt = signServiceAccountJwt(parsed, NOW);
      const [h, c, s] = jwt.split('.');
      assert.equal(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(svc.publicKey, s, 'base64url'), true);
    }
    assert.equal(normalizePrivateKey('a\\nb\\r\\nc'), 'a\nb\nc');
  });
  it('erros de configuração distintos: vazio, ilegível, campos ausentes, chave fora do formato', () => {
    assert.deepEqual(parseServiceAccount(''), { error: 'empty' });
    assert.deepEqual(parseServiceAccount(undefined), { error: 'empty' });
    assert.equal(parseServiceAccount('lixo {{').error, 'unparseable');
    assert.equal(parseServiceAccount(JSON.stringify({ client_email: 'a@b' })).error, 'missing_fields');
    assert.equal(parseServiceAccount(JSON.stringify({ client_email: 'a@b', private_key: 'não é pem' })).error, 'private_key_format');
    assert.equal(readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: json }).client_email, account.client_email);
    assert.equal(readServiceAccount({}), null);
  });
  it('JWT da service account: RS256, claims e assinatura verificável', () => {
    const [h, c, s] = signServiceAccountJwt(account, NOW).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.deepEqual([claims.iss, claims.aud, claims.exp - claims.iat], [account.client_email, 'https://oauth2.googleapis.com/token', 3600]);
    assert.equal(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(svc.publicKey, s, 'base64url'), true);
  });
});

describe('ID token do Firebase: verificação local RS256 (sem chave de API web)', () => {
  const run = (token, g = makeGoogle()) => verifyFirebaseIdToken(token, { projectId: PROJECT, fetch: g.fetch, now: () => NOW });
  it('token válido → uid; motivos específicos para cada falha', async () => {
    assert.deepEqual(await run(mkToken('u1')), { ok: true, uid: 'u1' });
    const cases = {
      token_malformed: ['abc', 'a.b', '...'],
      token_alg: [mkToken('u1', { alg: 'none' })],
      token_kid_unknown: [mkToken('u1', { kid: 'desconhecido' })],
      token_signature: [mkToken('u1', { key: rogue.privateKey })],
      token_expired: [mkToken('u1', { exp: nowS - 1 })],
      token_not_yet_valid: [mkToken('u1', { iat: nowS + 3600, exp: nowS + 7200 })],
      token_aud: [mkToken('u1', { aud: 'outro-projeto' })],
      token_iss: [mkToken('u1', { iss: 'https://securetoken.google.com/outro' })],
      token_sub: [mkToken('') ],
    };
    for (const [reason, tokens] of Object.entries(cases)) {
      for (const t of tokens) assert.equal((await run(t)).reason, reason, `${reason}: ${t.slice(0, 20)}`);
    }
  });
  it('chaves públicas do Google indisponíveis → 502 (não é culpa do token) e cache respeita max-age', async () => {
    resetAdminClaimsCache();
    assert.deepEqual(await run(mkToken('u1'), makeGoogle({ certsStatus: 500 })), { ok: false, reason: 'certs_unavailable', status: 502 });
    resetAdminClaimsCache();
    const g = makeGoogle();
    await run(mkToken('u1'), g);
    await run(mkToken('u2'), g);
    assert.equal(g.calls.filter((c) => c.url.includes('x509')).length, 1);
  });
});

describe('POST: promover/revogar administradores', () => {
  it('admin promove por e-mail e por uid; preserva claims; aviso de renovação de token; sem usar a chave de API web', async () => {
    const g = makeGoogle();
    const byEmail = await handleAdminClaims(req(mkToken('adm1'), { target: 'USER@x.com', admin: true }), deps(g));
    assert.equal(byEmail.status, 200);
    assert.deepEqual([byEmail.body.target, byEmail.body.admin, byEmail.body.previousAdmin], [{ uid: 'u1', email: 'user@x.com' }, true, false]);
    assert.match(byEmail.body.note, /sair e entrar|renovar/);
    assert.equal((await handleAdminClaims(req(mkToken('adm1'), { target: 'u2', admin: true }), deps(g))).status, 200);
    const [a, b] = g.updates();
    assert.deepEqual([a.localId, JSON.parse(a.customAttributes)], ['u1', { plan: 'pro', admin: true }]);
    assert.deepEqual([b.localId, JSON.parse(b.customAttributes)], ['u2', { admin: true }]);
  });
  it('revoga só `admin` (mantém as outras claims); idempotente; auto-revogação, alvo inexistente e corpo inválido', async () => {
    const g = makeGoogle();
    const r = await handleAdminClaims(req(mkToken('adm1'), { target: 'adm2', admin: false }), deps(g));
    assert.deepEqual([r.status, r.body.previousAdmin], [200, true]);
    assert.deepEqual(JSON.parse(g.updates()[0].customAttributes), { role: 'x' });
    assert.equal((await handleAdminClaims(req(mkToken('adm1'), { target: 'adm1', admin: false }), deps(g))).body.error, 'self_revoke');
    assert.equal((await handleAdminClaims(req(mkToken('adm1'), { target: 'adm@x.com', admin: false }), deps(g))).body.error, 'self_revoke');
    assert.equal((await handleAdminClaims(req(mkToken('adm1'), { target: 'ninguem@x.com', admin: true }), deps(g))).status, 404);
    for (const body of [null, {}, { target: '', admin: true }, { target: 'u2' }, { target: 'u2', admin: 'true' }, { target: 'x'.repeat(129), admin: true }, 'não json']) {
      assert.equal((await handleAdminClaims(req(mkToken('adm1'), body), deps(g))).body.error, 'invalid_body');
    }
    assert.equal((await handleAdminClaims({ method: 'DELETE', headers: {}, body: null }, deps(g))).status, 405);
  });
});

describe('autorização: 401 só para token inválido; 403 para quem não é admin; configuração = 5xx/501', () => {
  it('token inexistente/ inválido → 401 com MOTIVO no console.error, sem pedir credencial do servidor nem tocar no Auth', async () => {
    const cases = [
      [req(null, { target: 'u2', admin: true }), 'missing_token'],
      [req('lixo', { target: 'u2', admin: true }), 'token_malformed'],
      [req(mkToken('adm1', { key: rogue.privateKey }), { target: 'u2', admin: true }), 'token_signature'],
      [req(mkToken('adm1', { exp: nowS - 5 }), { target: 'u2', admin: true }), 'token_expired'],
      [req(mkToken('adm1', { aud: 'x' }), { target: 'u2', admin: true }), 'token_aud'],
    ];
    for (const [r, reason] of cases) {
      resetAdminClaimsCache();
      const g = makeGoogle();
      const [out, logs] = await captureErrors(() => handleAdminClaims(r, deps(g)));
      assert.deepEqual([out.status, out.body.error], [401, reason === 'missing_token' ? 'missing_token' : 'invalid_token'], reason);
      assert.equal(g.updates().length, 0);
      assert.equal(g.calls.some((c) => c.url.startsWith('https://oauth2')), false);
      assert.ok(logs.some((l) => l.includes('admin_claims_rejected') && l.includes(reason)), `log: ${reason}`);
      assert.ok(logs.every((l) => !l.includes('SERVER_TOKEN') && !l.includes('PRIVATE KEY') && !l.includes(r.headers.authorization ?? '@@')), 'o log não vaza token');
    }
  });
  it('token VÁLIDO de usuário comum, sem claims, ex-admin (estado atual) ou desativado → 403 e nada é gravado', async () => {
    for (const [uid, error] of [['u1', 'forbidden'], ['u2', 'forbidden'], ['ex', 'forbidden'], ['off', 'disabled']]) {
      const g = makeGoogle();
      const [out, logs] = await captureErrors(() => handleAdminClaims(req(mkToken(uid), { target: 'u2', admin: true }), deps(g)));
      assert.deepEqual([out.status, out.body.error], [403, error], uid);
      assert.equal(g.updates().length, 0);
      assert.ok(logs.some((l) => l.includes('caller_not_admin') || l.includes('caller_disabled')));
    }
  });
  it('usuário do token inexistente no Auth (apagado) → 401', async () => {
    const [out] = await captureErrors(() => handleAdminClaims(req(mkToken('fantasma'), { target: 'u2', admin: true }), deps(makeGoogle())));
    assert.equal(out.status, 401);
  });
  it('erros de CONFIGURAÇÃO não viram 401: sem variável → 501; formato inválido → 500; Google recusa a credencial → 502 com motivo', async () => {
    const t = mkToken('adm1');
    const body = { target: 'u2', admin: true };
    const [none, l1] = await captureErrors(() => handleAdminClaims(req(t, body), { env: { FIREBASE_PROJECT_ID: PROJECT }, fetch: makeGoogle().fetch, now: () => NOW }));
    assert.deepEqual([none.status, none.body.error], [501, 'not_configured']);
    assert.ok(l1.some((l) => l.includes('not_configured')));
    const [bad, l2] = await captureErrors(() => handleAdminClaims(req(t, body), { env: { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: '{"client_email":"a@b","private_key":"x"}' }, fetch: makeGoogle().fetch, now: () => NOW }));
    assert.deepEqual([bad.status, bad.body.error], [500, 'bad_service_account']);
    assert.ok(l2.some((l) => l.includes('private_key_format')));
    resetAdminClaimsCache();
    const [refused, l3] = await captureErrors(() => handleAdminClaims(req(t, body), deps(makeGoogle({ tokenStatus: 400 }))));
    assert.deepEqual([refused.status, refused.body.error], [502, 'server_credential_failed']);
    assert.ok(l3.some((l) => l.includes('invalid_grant') && l.includes('token_exchange')));
    assert.ok(l3.every((l) => !l.includes('BEGIN PRIVATE KEY')));
    resetAdminClaimsCache();
    const [certs] = await captureErrors(() => handleAdminClaims(req(t, body), deps(makeGoogle({ certsStatus: 503 }))));
    assert.deepEqual([certs.status, certs.body.error], [502, 'auth_unreachable']);
  });
  it('emulador: valida pelo emulador (token sem assinatura) e usa `Bearer owner`', async () => {
    const seen = [];
    const ok = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });
    const fetch = async (url, init = {}) => {
      seen.push([String(url), init.headers?.authorization]);
      const body = init.body ? JSON.parse(init.body) : {};
      if (String(url).includes('accounts:lookup?key=')) return ok({ users: [{ localId: 'adm1' }] });
      if (String(url).endsWith('accounts:lookup')) return ok({ users: [body.localId?.[0] === 'adm1' ? baseUsers()[0] : baseUsers()[2]] });
      return ok({ localId: body.localId });
    };
    const out = await handleAdminClaims(req('TOKEN_DO_EMULADOR', { target: 'u2', admin: true }), { env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_PROJECT_ID: PROJECT }, fetch, now: () => NOW });
    assert.equal(out.status, 200);
    assert.ok(seen.every(([url]) => url.startsWith('http://127.0.0.1:9099/identitytoolkit.googleapis.com/')));
    assert.ok(seen.some(([, a]) => a === 'Bearer owner'));
  });
  it('a resposta nunca vaza token do servidor nem chave privada', async () => {
    for (const r of [req(mkToken('adm1'), { target: 'u1', admin: true }), req(mkToken('u1'), { target: 'u1', admin: true }), req(mkToken('adm1'), null, 'GET')]) {
      resetAdminClaimsCache();
      const [out] = await captureErrors(() => handleAdminClaims(r, deps(makeGoogle())));
      assert.doesNotMatch(JSON.stringify(out.body), /SERVER_TOKEN|PRIVATE KEY|svc@test/);
    }
  });
});

describe('GET: listar usuários e administradores', () => {
  it('admin recebe a lista (admin = claim atual), administradores primeiro, `me` e totais', async () => {
    const g = makeGoogle();
    const out = await handleAdminClaims(req(mkToken('adm1'), null, 'GET'), deps(g));
    assert.equal(out.status, 200);
    assert.deepEqual([out.body.ok, out.body.total, out.body.truncated, out.body.me], [true, 6, false, 'adm1']);
    const emails = out.body.users.map((u) => `${u.admin ? 'A' : 'U'}:${u.email}`);
    assert.deepEqual(emails, ['A:adm@x.com', 'A:adm2@x.com', 'A:off@x.com', 'U:ex@x.com', 'U:outro@x.com', 'U:user@x.com']);
    assert.deepEqual(out.body.users.find((u) => u.uid === 'adm1'), { uid: 'adm1', email: 'adm@x.com', displayName: 'Admin Um', disabled: false, admin: true, createdAt: 1 });
    assert.equal(out.body.users.find((u) => u.uid === 'off').disabled, true);
    assert.equal(g.updates().length, 0); // listar nunca grava
    assert.ok(out.body.users.every((u) => !('customAttributes' in u))); // só o necessário
  });
  it('pagina (várias páginas) e sinaliza truncamento no teto de páginas', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ localId: `p${i}`, email: `p${i}@x.com` }));
    const g = makeGoogle({ users: [baseUsers()[0], ...many], pageSize: 5 });
    const out = await handleAdminClaims(req(mkToken('adm1'), null, 'GET'), deps(g));
    assert.equal(out.body.total, 13);
    assert.equal(g.calls.filter((c) => c.url.includes('batchGet')).length, 3);
    const huge = Array.from({ length: 7 }, (_, i) => ({ localId: `h${i}`, email: `h${i}@x.com` }));
    const g2 = makeGoogle({ users: [baseUsers()[0], ...huge], pageSize: 1 });
    const cut = await handleAdminClaims(req(mkToken('adm1'), null, 'GET'), deps(g2));
    assert.equal(cut.body.truncated, true);
    assert.equal(cut.body.total, 5);
  });
  it('NÃO autorizado: sem token 401, token inválido 401, usuário comum 403, ex-admin 403; falha da API → 502 com motivo', async () => {
    const [noToken] = await captureErrors(() => handleAdminClaims(req(null, null, 'GET'), deps(makeGoogle())));
    assert.equal(noToken.status, 401);
    const [bad] = await captureErrors(() => handleAdminClaims(req(mkToken('adm1', { key: rogue.privateKey }), null, 'GET'), deps(makeGoogle())));
    assert.equal(bad.status, 401);
    for (const uid of ['u1', 'ex', 'off']) {
      const g = makeGoogle();
      const [out] = await captureErrors(() => handleAdminClaims(req(mkToken(uid), null, 'GET'), deps(g)));
      assert.equal(out.status, 403, uid);
      assert.equal(g.calls.some((c) => c.url.includes('batchGet')), false); // a lista nem é consultada
    }
    const [fail, logs] = await captureErrors(() => handleAdminClaims(req(mkToken('adm1'), null, 'GET'), deps(makeGoogle({ batchStatus: 403 }))));
    assert.deepEqual([fail.status, fail.body.error], [502, 'list_failed']);
    assert.ok(logs.some((l) => l.includes('batch_get')));
  });
});

describe('cliente', () => {
  const user = { uid: 'adm1', getIdToken: async () => 'T_ADM' };
  const okResponse = { ok: true, status: 200, json: async () => ({ ok: true, target: { uid: 'u1', email: 'user@x.com' }, admin: true, previousAdmin: false, note: 'renove o token' }) };

  it('valida o alvo (e-mail/uid) antes de chamar o servidor', () => {
    assert.deepEqual(parseAdminTarget(' User@X.com '), { ok: true, target: 'user@x.com', kind: 'email' });
    assert.deepEqual(parseAdminTarget('abc123'), { ok: true, target: 'abc123', kind: 'uid' });
    for (const bad of ['', '   ', 'a@b', 'com espaço', 'x'.repeat(129), null]) assert.equal(parseAdminTarget(bad).ok, false, String(bad));
  });
  it('promove/revoga: POST com Bearer e auditoria do executor; falhas viram mensagens e não auditam', async () => {
    const calls = [];
    const audits = [];
    const r = await setAdminClaim(user, { target: 'user@x.com', admin: true }, {
      fetch: async (url, init) => { calls.push([url, init]); return okResponse; },
      writeAudit: async (uid, entry) => { audits.push([uid, entry]); return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0][0], ADMIN_CLAIMS_ENDPOINT);
    assert.deepEqual([calls[0][1].method, calls[0][1].headers.authorization, JSON.parse(calls[0][1].body)], ['POST', 'Bearer T_ADM', { target: 'user@x.com', admin: true }]);
    assert.deepEqual([audits[0][0], audits[0][1].action, audits[0][1].docId, audits[0][1].after.adminUid], ['adm1', 'maintenance_admin_grant', 'u1', 'adm1']);
    const io = (status, data) => ({ fetch: async () => ({ ok: false, status, json: async () => data }), writeAudit: async (...a) => { audits.push(a); return { ok: true }; } });
    const before = audits.length;
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(403, { error: 'forbidden' }))).error, /Apenas administradores/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(501, { error: 'not_configured' }))).error, /FIREBASE_SERVICE_ACCOUNT/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(500, { error: 'bad_service_account' }))).error, /formato inválido/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(502, { error: 'server_credential_failed' }))).error, /recusou a credencial/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, { fetch: async () => { throw new Error('net'); } })).error, /conexão/);
    assert.equal(audits.length, before);
    assert.equal((await setAdminClaim(null, { target: 'u1', admin: true })).ok, false);
    assert.equal((await setAdminClaim(user, { target: 'u1', admin: 'sim' })).ok, false);
    const auditFail = await setAdminClaim(user, { target: 'u1', admin: true }, { fetch: async () => okResponse, writeAudit: async () => ({ ok: false, error: new Error('negado') }) });
    assert.match(auditFail.auditError, /negado/);
  });
  it('listAdminUsers: GET com Bearer; erros 401/403 viram mensagem; resposta inválida é rejeitada', async () => {
    const calls = [];
    const users = [{ uid: 'a', email: 'a@x.com', admin: true }];
    const ok = await listAdminUsers(user, { fetch: async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ ok: true, users, total: 1, truncated: false, me: 'adm1' }) }; } });
    assert.deepEqual([ok.ok, ok.users, ok.me], [true, users, 'adm1']);
    assert.deepEqual([calls[0][0], calls[0][1].method, calls[0][1].headers.authorization], [ADMIN_CLAIMS_ENDPOINT, 'GET', 'Bearer T_ADM']);
    const err = (status, error) => ({ fetch: async () => ({ ok: false, status, json: async () => ({ ok: false, error }) }) });
    assert.match((await listAdminUsers(user, err(403, 'forbidden'))).error, /Apenas administradores/);
    assert.match((await listAdminUsers(user, err(401, 'invalid_token'))).error, /Sessão inválida/);
    assert.equal((await listAdminUsers(user, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) })).ok, false);
    assert.match((await listAdminUsers(user, { fetch: async () => { throw new Error('x'); } })).error, /conexão/);
    assert.equal((await listAdminUsers(null)).ok, false);
  });
  it('buildAdminUserRows: administradores em destaque primeiro, ação rápida por linha, própria conta sem revogar', () => {
    const users = [
      { uid: 'u2', email: 'zeta@x.com', admin: false },
      { uid: 'adm1', email: 'me@x.com', admin: true },
      { uid: 'off', email: 'off@x.com', admin: false, disabled: true },
      { uid: 'adm2', email: 'alfa@x.com', admin: true },
      { uid: 'u1', email: null, displayName: 'Sem E-mail', admin: false },
    ];
    const { rows, admins, others } = buildAdminUserRows(users, 'adm1');
    assert.deepEqual([admins, others], [2, 3]);
    assert.deepEqual(rows.map((r) => r.uid), ['adm2', 'adm1', 'off', 'u1', 'u2']);
    assert.deepEqual(rows.map((r) => r.action), ['revoke', null, null, 'grant', 'grant']); // eu: sem revogar; desativado: sem promover
    assert.equal(rows.find((r) => r.uid === 'adm1').isMe, true);
    assert.equal(rows.find((r) => r.uid === 'u1').label, 'Sem E-mail');
    assert.deepEqual(buildAdminUserRows([], 'x'), { rows: [], admins: 0, others: 0 });
  });
});
