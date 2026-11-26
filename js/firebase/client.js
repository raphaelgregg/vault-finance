/**
 * Inicialização única do SDK do Firebase (v10 modular via CDN).
 * Exporta instâncias de app, auth e firestore já conectadas aos emuladores
 * quando estiver rodando localmente.
 *
 * Regra: se a config real ainda são placeholders E estamos em localhost, usamos
 * uma config DEMO apontando para o Emulator Suite. Isso permite desenvolver sem
 * projeto Firebase; nada disso alcança a nuvem.
 */
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
} from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider, getToken as getAppCheckTokenSdk } from 'firebase/app-check';
import { firebaseConfig, isConfigPlaceholder, USE_EMULATORS, EMULATOR_HOST, resolveMode, APP_CHECK_SITE_KEY } from './config.js';

/** Config fictícia: só funciona contra os emuladores locais. */
const DEMO_CONFIG = Object.freeze({
  apiKey: 'demo-api-key',
  authDomain: 'demo-vault-finance.firebaseapp.com',
  projectId: 'demo-vault-finance',
  storageBucket: 'demo-vault-finance.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:demo',
});

/** Modo pedido na URL (?mode=demo | ?mode=firebase) ou 'auto'. */
export const mode = resolveMode();

/**
 * DEMO quando: pedido explicitamente (?mode=demo, só em localhost, onde os emuladores
 * existem), ou automaticamente em localhost enquanto a config real for placeholder.
 * Com a config real preenchida, localhost usa o Firebase de verdade — a menos que
 * ?mode=demo seja pedido.
 */
export const usingDemoConfig =
  (mode === 'demo' && USE_EMULATORS) ||
  (mode === 'auto' && USE_EMULATORS && isConfigPlaceholder(firebaseConfig));

/** true = sem config real e sem emulador: a UI avisa em vez de falhar em silêncio. */
export const configMissing = isConfigPlaceholder(firebaseConfig) && !usingDemoConfig;

const activeConfig = usingDemoConfig ? DEMO_CONFIG : firebaseConfig;

const app = getApps().length ? getApps()[0] : initializeApp(activeConfig);

// VF-SEC-03: App Check só com chave configurada, fora do modo DEMO/emulador e no navegador. Antes de Auth/Firestore.
let appCheck = null;
if (APP_CHECK_SITE_KEY && !usingDemoConfig && typeof window !== 'undefined') {
  try {
    appCheck = initializeAppCheck(app, { provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
  } catch (error) {
    console.warn('[app-check] não inicializado', error);
  }
}

/** Token do App Check para a API própria (`X-Firebase-AppCheck`); null quando desligado ou indisponível. */
export async function getAppCheckToken() {
  if (!appCheck) return null;
  try { return (await getAppCheckTokenSdk(appCheck, false)).token ?? null; } catch { return null; }
}

export const auth = getAuth(app);
export const db = getFirestore(app);

let emulatorsConnected = false;
export function connectEmulatorsOnce() {
  if (emulatorsConnected || !usingDemoConfig) return;
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  emulatorsConnected = true;
  console.info(`[firebase] modo DEMO — conectado aos emuladores locais (auth:9099, firestore:8080)`);
}

export { app };
