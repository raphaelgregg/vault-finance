/**
 * Service worker mínimo (PWA instalável). NÃO faz cache nem intercepta respostas: dados financeiros
 * sempre vêm da rede/Firestore, então nunca há saldo defasado. O listener de `fetch` existe só para o
 * Chrome tratar o app como instalável; sem `respondWith`, o navegador segue o fluxo normal.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
