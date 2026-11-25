/**
 * VF-SEC-02 — guarda de configuração (sem dependências; importável por qualquer função).
 * Variáveis de emulador fazem o Admin SDK e `/api/admin-claims` aceitarem ID tokens SEM assinatura. Em produção/preview da
 * Vercel isso seria um bypass total de autenticação: a combinação é recusada (erro de configuração, nunca silencioso).
 */
export const EMULATOR_ENV_VARS = Object.freeze(['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST']);

/** Lança `Error` com `code: 'EMULATOR_IN_PRODUCTION'` se houver variável de emulador em ambiente hospedado. */
export function assertNoEmulatorInProduction(env = process.env) {
  const hosted = env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
  const set = EMULATOR_ENV_VARS.filter((name) => env[name]);
  if (hosted && set.length) {
    const error = new Error(`Configuração insegura: ${set.join(', ')} não pode existir em produção/preview. Remova a variável na Vercel.`);
    error.code = 'EMULATOR_IN_PRODUCTION';
    throw error;
  }
}
