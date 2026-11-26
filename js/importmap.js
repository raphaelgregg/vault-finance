/**
 * Fonte única do import map (o app é estático, sem bundler).
 *
 * Script clássico e síncrono: roda antes de qualquer <script type="module">
 * e injeta o <script type="importmap"> no <head>. Para trocar a versão do SDK,
 * altere FIREBASE_VERSION aqui — nenhum HTML precisa ser editado.
 *
 * Se por algum motivo a página já tiver um import map declarado, nada é feito.
 *
 * SRI: a chave `integrity` do import map (suportada em navegadores recentes; ignorada nos
 * demais) fixa o hash SHA-384 dos módulos. Ao trocar FIREBASE_VERSION, recalcule os hashes
 * (openssl dgst -sha384 -binary <arquivo> | openssl base64 -A, sobre o arquivo do pacote
 * npm `firebase@<versão>`) E o hash CSP do import map em `vercel.json`
 * (tests/services/security-headers.test.mjs falha se algo ficar fora de sincronia).
 * Mantenha este bloco em uma única forma serializável: o CSP autoriza o script inline
 * por hash do JSON gerado.
 */
(function injectImportMap() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('script[type="importmap"]')) return;

  var FIREBASE_VERSION = '10.12.2';
  var base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';

  var map = {
    imports: {
      'firebase/app': base + 'firebase-app.js',
      'firebase/auth': base + 'firebase-auth.js',
      'firebase/app-check': base + 'firebase-app-check.js',
      'firebase/firestore': base + 'firebase-firestore.js',
    },
    integrity: {},
  };
  map.integrity[base + 'firebase-app.js'] = 'sha384-stTNz2qNbq7DNZ/YGSW5tO9xP6QJJfI4FWVs8ua/u1eqMw9QYxdFg859xCkme49a';
  map.integrity[base + 'firebase-app-check.js'] = 'sha384-qCiaskHigbAxo3zE6GaxVXn+HD1J+O19Qxe3qFTVvqYGk3rNdsN+muOaV7TQSi4p';
  map.integrity[base + 'firebase-auth.js'] = 'sha384-xc1TV9O0/6B1UfdVv335cLLPR5z0/W7C/tHMVb0Io3DzsB2qscQnsXnZgVh/+kdU';
  map.integrity[base + 'firebase-firestore.js'] = 'sha384-mr45ONjFgd7GUimISmrEP4jMaKhbf2j/wb50swz+5/wVp7Oh6QSDbkxxa7y+YgF0';

  var script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(map);
  document.head.appendChild(script);
})();
