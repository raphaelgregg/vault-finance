/** Registra o service worker (necessário para instalar o app no Chrome). Falha silenciosa: o app funciona sem ele. */
export function registerPwa() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => console.warn('[pwa] service worker não registrado', error));
}
