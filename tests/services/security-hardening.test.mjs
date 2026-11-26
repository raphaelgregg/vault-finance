/**
 * VF-SEC-01/02/04 — endurecimento: login recente em operação destrutiva, guarda de emulador em produção e
 * arquivos internos fora do deploy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleFinance } from '../../server/finance/index.mjs';
import { assertNoEmulatorInProduction } from '../../server/env-guard.mjs';
import { handleAdminClaims } from '../../server/admin/claims.mjs';
import { RECENT_LOGIN_SECONDS } from '../../server/finance/core.mjs';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const nowS = Math.floor(NOW / 1000);
const run = (decoded) => handleFinance(
  { method: 'POST', headers: { authorization: 'Bearer t' }, body: { op: 'data.clearOwn', operationId: 'op-12345678', params: { confirm: 'ERRADA' } } },
  { db: {}, verifyIdToken: async () => decoded, now: () => NOW, log: () => {} },
);

describe('VF-SEC-01 — data.clearOwn exige login recente', () => {
  it('sem auth_time ou antigo → 403 RECENT_LOGIN_REQUIRED (antes de validar/tocar o banco)', async () => {
    for (const decoded of [{ uid: 'a' }, { uid: 'a', auth_time: nowS - RECENT_LOGIN_SECONDS - 1 }, { uid: 'a', auth_time: 'x' }]) {
      const r = await run(decoded);
      assert.deepEqual([r.status, r.body.error], [403, 'RECENT_LOGIN_REQUIRED']);
    }
  });
  it('login recente passa pela guarda (e cai na validação da frase: 400)', async () => {
    const r = await run({ uid: 'a', auth_time: nowS - 10 });
    assert.deepEqual([r.status, r.body.error], [400, 'CONFIRMATION_REQUIRED']);
  });
  it('operações comuns não exigem login recente', async () => {
    const r = await handleFinance(
      { method: 'POST', headers: { authorization: 'Bearer t' }, body: { op: 'transfer.create', operationId: 'op-12345678', params: {} } },
      { db: {}, verifyIdToken: async () => ({ uid: 'a' }), now: () => NOW, log: () => {} },
    );
    assert.notEqual(r.body.error, 'RECENT_LOGIN_REQUIRED');
  });
});

describe('VF-SEC-02 — variáveis de emulador recusadas em produção/preview', () => {
  it('guarda', () => {
    for (const VERCEL_ENV of ['production', 'preview']) {
      for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST']) {
        assert.throws(() => assertNoEmulatorInProduction({ VERCEL_ENV, [name]: '127.0.0.1:9099' }), { code: 'EMULATOR_IN_PRODUCTION' });
      }
    }
    assert.doesNotThrow(() => assertNoEmulatorInProduction({ VERCEL_ENV: 'production' }));
    assert.doesNotThrow(() => assertNoEmulatorInProduction({ VERCEL_ENV: 'development', FIREBASE_AUTH_EMULATOR_HOST: 'x' }));
    assert.doesNotThrow(() => assertNoEmulatorInProduction({ FIRESTORE_EMULATOR_HOST: 'x' })); // local/testes
  });
  it('/api/admin-claims recusa (500) antes de aceitar qualquer token', async () => {
    const out = await handleAdminClaims(
      { method: 'GET', headers: { authorization: 'Bearer owner' } },
      { env: { VERCEL_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, fetch: async () => { throw new Error('não deve chamar a rede'); } },
    );
    assert.deepEqual([out.status, out.body.error], [500, 'EMULATOR_IN_PRODUCTION']);
  });
});

describe('VF-SEC-04 — arquivos internos fora do deploy', () => {
  const ignore = readFileSync(new URL('../../.vercelignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  it('.vercelignore exclui o que é interno e mantém o que as funções importam', () => {
    for (const p of ['PLAN.md', 'CLAUDE.md', 'tests/', 'docs/', 'scripts/', '.github/', 'firestore.rules']) assert.ok(ignore.includes(p), p);
    for (const p of ['server/', 'api/', 'js/', 'package.json', 'package-lock.json']) assert.ok(!ignore.includes(p), `${p} é necessário às funções`);
  });
  it('vercel.json redireciona /server, /tests, /docs e /scripts', () => {
    const { redirects } = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
    const rule = redirects.find((r) => /server/.test(r.source));
    assert.ok(rule && /tests/.test(rule.source) && rule.permanent === false);
  });
});

describe('VF-SEC-09 — o servidor carrega sem require() de módulo ESM (runtime da Vercel)', () => {
  it('importa a camada financeira e a validação com --no-experimental-require-module', async () => {
    // Regressão: firebase-admin 14 → jwks-rsa → jose (ESM) quebrava na Vercel com ERR_REQUIRE_ESM (500 em /api/finance),
    // mas passava local porque o Node recente permite require(esm).
    const { execFileSync } = await import('node:child_process');
    const code = "Promise.all([import('./server/finance/index.mjs'), import('./server/validation/center.mjs'), import('./server/admin/claims.mjs')]).then(() => console.info('ok'))";
    const out = execFileSync(process.execPath, ['--no-experimental-require-module', '-e', code], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
    assert.match(out, /ok/);
  });
});
