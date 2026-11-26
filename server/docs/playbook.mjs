/**
 * Playbook (VF-DOC-01) — SERVIDOR. `GET /api/docs` devolve `docs/playbook/index.json` SOMENTE a administradores.
 *
 * Por que uma função e não um arquivo estático: `docs/` não é servido publicamente (redirect em `vercel.json`); o conteúdo
 * descreve a arquitetura e a operação do sistema. A autorização é a MESMA de `/api/admin-claims` (`authorizeAdmin`): ID
 * token verificado localmente + claim `admin` ATUAL consultada no Auth (revogação vale na hora) + conta ativa.
 * O arquivo vai no pacote da função por `functions["api/docs.mjs"].includeFiles` (vercel.json).
 */
import { readFile } from 'node:fs/promises';
import { authorizeAdmin } from '../admin/claims.mjs';
import { assertNoEmulatorInProduction } from '../env-guard.mjs';

const INDEX_URL = new URL('../../docs/playbook/index.json', import.meta.url);
const json = (status, body) => ({ status, body });

/** `request`: { method, headers }. `deps`: { env, fetch, now, readIndex } injetáveis nos testes. */
export async function handleDocs(request, { env = process.env, fetch = globalThis.fetch, now = Date.now, readIndex = () => readFile(INDEX_URL, 'utf8') } = {}) {
  if (request?.method !== 'GET') return json(405, { ok: false, error: 'method_not_allowed', message: 'Use GET.' });
  try { assertNoEmulatorInProduction(env); } catch (error) { return json(500, { ok: false, error: error.code, message: error.message }); }

  const guard = await authorizeAdmin(request, { env, fetch, now });
  if (guard.response) return guard.response;

  try {
    const playbook = JSON.parse(await readIndex());
    return json(200, { ok: true, playbook });
  } catch (error) {
    console.error(JSON.stringify({ event: 'docs_unavailable', reason: String(error?.code ?? error?.message ?? error).slice(0, 80) }));
    return json(500, { ok: false, error: 'docs_unavailable', message: 'Playbook indisponível no servidor (rode `npm run docs:build` e faça o deploy).' });
  }
}
