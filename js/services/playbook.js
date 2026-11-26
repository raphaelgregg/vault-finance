/**
 * Cliente do playbook (VF-DOC-01): lê `GET /api/docs` (função de servidor; SOMENTE administradores — o servidor valida o
 * ID token e a claim `admin` atual). A interface esconde a página de não-admins, mas a barreira real é o servidor.
 */
export const DOCS_ENDPOINT = '/api/docs';

const ERROR_MESSAGES = {
  missing_token: 'Sessão ausente. Entre novamente.',
  invalid_token: 'Sessão inválida ou expirada. Entre novamente.',
  forbidden: 'O playbook é restrito a administradores.',
  disabled: 'Sua conta está desativada.',
  not_configured: 'O servidor ainda não está configurado (falta FIREBASE_SERVICE_ACCOUNT na Vercel).',
  bad_service_account: 'A credencial FIREBASE_SERVICE_ACCOUNT da Vercel está em formato inválido.',
  server_credential_failed: 'O Google recusou a credencial do servidor (veja os logs da função na Vercel).',
  auth_unreachable: 'Não foi possível validar a sessão agora. Tente novamente.',
  lookup_failed: 'Falha ao consultar o Firebase Auth. Tente novamente.',
  docs_unavailable: 'O playbook não está disponível no servidor (rode `npm run docs:build` e faça o deploy).',
  method_not_allowed: 'Método não permitido.',
  EMULATOR_IN_PRODUCTION: 'Configuração insegura no servidor (variável de emulador em produção).',
};

/** Retorna { ok: true, playbook } ou { ok: false, error, status }. `io`: fetch injetável nos testes. */
export async function fetchPlaybook(user, io = {}) {
  if (!user || typeof user.getIdToken !== 'function') return { ok: false, error: 'Sessão necessária.' };
  let response;
  try {
    const idToken = await user.getIdToken();
    response = await (io.fetch ?? globalThis.fetch)(DOCS_ENDPOINT, { method: 'GET', headers: { authorization: `Bearer ${idToken}` } });
  } catch {
    return { ok: false, error: 'Sem conexão com o servidor. Tente novamente.' };
  }
  let body = null;
  try { body = await response.json(); } catch { /* corpo vazio ou não-JSON */ }
  if (response.ok && body?.ok && Array.isArray(body.playbook?.docs)) return { ok: true, playbook: body.playbook };
  return { ok: false, status: response.status, error: ERROR_MESSAGES[body?.error] ?? body?.message ?? `Erro ${response.status} do servidor.` };
}
