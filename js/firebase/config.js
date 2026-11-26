/**
 * Configuração do Firebase — projeto vault-finance-d1603 (plano Spark, região nam5).
 *
 * Isto NÃO é credencial administrativa: a chave de API web é pública por design
 * (identifica o projeto no SDK web; não concede acesso a dados).
 * A segurança real está em firestore.rules + Authentication.
 *
 * NUNCA coloque aqui service account, Admin SDK, client_secret ou chave privada.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyC4ATj4qAmzvoVppZw_sdKZJ8fqQPwRyr0',
  authDomain: 'vault-finance-d1603.firebaseapp.com',
  projectId: 'vault-finance-d1603',
  storageBucket: 'vault-finance-d1603.firebasestorage.app',
  messagingSenderId: '13396578383',
  appId: '1:13396578383:web:b1ca1d8d0d0bdcac9f1a3a',
};

/**
 * VF-SEC-03 — App Check (reCAPTCHA v3). Chave do SITE (pública por design). Vazia = App Check desligado.
 * Crie em Firebase Console → App Check → Apps → Web → reCAPTCHA v3 e cole aqui a "site key".
 */
export const APP_CHECK_SITE_KEY = '';

/** true = config ainda não preenchida (a UI mostra aviso em vez de falhar em silêncio) */
export function isConfigPlaceholder(config = firebaseConfig) {
  return Object.values(config).some(
    (value) => typeof value === 'string' && value.startsWith('COLE_AQUI')
  );
}

/** true quando há um ambiente de navegador (os testes em Node não têm window). */
const hasBrowser = typeof window !== 'undefined' && typeof window.location !== 'undefined';

/** Emuladores locais: usados apenas quando a página roda em localhost/127.0.0.1 */
export const USE_EMULATORS =
  hasBrowser &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  new URLSearchParams(window.location.search).get('emulator') !== '0';

export const EMULATOR_HOST = '127.0.0.1';

/**
 * Alternância explícita de modo (configuração explícita, não implícita):
 * - ?mode=demo     → força modo DEMO contra os emuladores locais (só faz sentido em localhost).
 * - ?mode=firebase → força a config real mesmo em localhost (ignora emuladores).
 * - sem parâmetro  → automático: DEMO em localhost enquanto a config for placeholder;
 *                    com a config real preenchida, usa o Firebase de verdade.
 */
export function resolveMode() {
  const mode = hasBrowser
    ? new URLSearchParams(window.location.search).get('mode')
    : null;
  if (mode === 'demo' || mode === 'firebase') {
    // A escolha explícita persiste na aba: links internos não carregam ?mode=...
    try { sessionStorage.setItem('vault-mode', mode); } catch { /* storage indisponível */ }
    return mode;
  }
  if (mode === 'auto') {
    try { sessionStorage.removeItem('vault-mode'); } catch { /* idem */ }
    return 'auto';
  }
  try {
    const saved = sessionStorage.getItem('vault-mode');
    if (saved === 'demo' || saved === 'firebase') return saved;
  } catch { /* storage indisponível */ }
  return 'auto';
}
