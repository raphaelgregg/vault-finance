/**
 * Cliente da camada financeira confiável (POST /api/finance — VF-ARQ-02).
 *  - autentica com o Firebase ID token do usuário (o servidor valida; nada de credencial administrativa aqui);
 *  - envia SEMPRE um `operationId`: uma repetição da MESMA operação (retry, timeout, duplo clique) reutiliza a chave e o
 *    servidor devolve o resultado já gravado em vez de gravar de novo;
 *  - timeout e retry com a MESMA chave só para falhas repetíveis (rede, timeout, 502/503/504, `retryable`);
 *  - erros de negócio do servidor (saldo insuficiente, excesso, estado inválido…) chegam INTACTOS em `FinanceApiError`
 *    (status, code, message, details) — a interface mostra o motivo real;
 *  - duplo envio da mesma chave dentro da página compartilha a mesma requisição (não há 2ª chamada).
 * A interface NUNCA atualiza saldos de forma otimista: recarrega os dados depois da confirmação do servidor.
 */
import { auth, getAppCheckToken } from '../firebase/client.js';

export const FINANCE_ENDPOINT = '/api/finance';

export class FinanceApiError extends Error {
  constructor({ status = 0, code = 'NETWORK_ERROR', message = 'Falha de comunicação com o servidor.', details, retryable = false } = {}) {
    super(message);
    this.name = 'FinanceApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

/** Chave de idempotência de UMA intenção do usuário (gerar ao abrir o formulário e reutilizar em retry/duplo clique). */
export const newOperationId = () => globalThis.crypto.randomUUID();

const inflight = new Map();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultToken(forceRefresh) {
  const user = auth.currentUser;
  if (!user) throw new FinanceApiError({ status: 401, code: 'UNAUTHENTICATED', message: 'Sessão expirada: entre novamente.' });
  return user.getIdToken(forceRefresh);
}

/**
 * Chama uma operação. `options`: { operationId, fetch, getToken, timeoutMs (15000), retries (3), sleep, endpoint }.
 * Resolve com o corpo `{ ok: true, ...resultado, operationId, idempotent }`; rejeita com `FinanceApiError`.
 */
export function callFinance(op, params = {}, options = {}) {
  const operationId = options.operationId ?? newOperationId();
  if (inflight.has(operationId)) return inflight.get(operationId);
  const promise = run(op, params, operationId, options).finally(() => inflight.delete(operationId));
  inflight.set(operationId, promise);
  return promise;
}

async function run(op, params, operationId, options) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const getToken = options.getToken ?? defaultToken;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15000;
  const endpoint = options.endpoint ?? FINANCE_ENDPOINT;
  let refreshToken = false;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const token = await getToken(refreshToken);
      refreshToken = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const appCheckToken = await (options.getAppCheckToken ?? getAppCheckToken)(); // VF-SEC-03 (null = App Check desligado)
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(appCheckToken ? { 'x-firebase-appcheck': appCheckToken } : {}) },
          body: JSON.stringify({ op, operationId, params }), signal: controller.signal,
        });
      } finally { clearTimeout(timer); }
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) return body;
      last = new FinanceApiError({
        status: response.status, code: body.error ?? 'HTTP_ERROR', message: body.message ?? `Erro ${response.status} do servidor.`,
        details: body.details, retryable: [502, 503, 504].includes(response.status) || body.retryable === true,
      });
      if (response.status === 401 && attempt === 0) { refreshToken = true; continue; } // token vencido: renova e repete uma vez
      if (!last.retryable) throw last;
    } catch (error) {
      if (error instanceof FinanceApiError && !error.retryable) throw error;
      if (error instanceof FinanceApiError) last = error;
      else last = new FinanceApiError({ code: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: error?.name === 'AbortError' ? 'O servidor demorou a responder.' : 'Sem conexão com o servidor.', retryable: true });
    }
    if (attempt < retries) await sleep(Math.min(400 * 2 ** attempt, 4000)); // mesma operationId no próximo envio
  }
  throw last;
}

/**
 * Adaptador para os services: { ok: true, ...corpo } ou { ok: false, errors: { _form: mensagem real }, code, status, details }.
 * Quando o servidor aponta um campo (`details.field`) o erro também vai para esse campo.
 */
export async function financeResult(op, params, options) {
  try {
    return await callFinance(op, params, options);
  } catch (error) {
    if (!(error instanceof FinanceApiError)) throw error;
    const errors = { _form: error.message };
    if (error.details?.field) errors[error.details.field] = error.message;
    return { ok: false, errors, code: error.code, status: error.status, details: error.details, retryable: error.retryable };
  }
}
