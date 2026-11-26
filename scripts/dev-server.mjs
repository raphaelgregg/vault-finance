/**
 * Servidor local de desenvolvimento/E2E (VF-ARQ-02): arquivos estáticos + `POST /api/finance` (o MESMO handler da função da
 * Vercel). Contra os emuladores, o Admin SDK não precisa de credencial; fora deles exige `FIREBASE_SERVICE_ACCOUNT`.
 * Uso: `npm run serve:api` (porta 5500). Em produção quem serve é a Vercel (`api/finance.mjs`).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { return text; }
}

export function startServer({ port = 5500, host = '127.0.0.1', handleFinance } = {}) {
  const loadFinance = async () => handleFinance ?? (await import('../server/finance/index.mjs')).handleFinance;
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/finance') {
      const finance = await loadFinance();
      const result = await finance({ method: req.method, headers: req.headers, body: req.method === 'POST' ? await readBody(req) : undefined });
      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
      return;
    }
    if (pathname === '/api/validation') { // Central de validação (VF-UI-02): endpoint próprio, só administradores
      const { handleValidation } = await import('../server/validation/center.mjs');
      const result = await handleValidation({ method: req.method, headers: req.headers, body: req.method === 'POST' ? await readBody(req) : undefined });
      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
      return;
    }
    if (pathname === '/api/docs') { // Playbook (VF-DOC-01): só administradores
      const { handleDocs } = await import('../server/docs/playbook.mjs');
      const result = await handleDocs({ method: req.method, headers: req.headers });
      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
      return;
    }
    const path = normalize(decodeURIComponent(pathname));
    const rewritten = path === '/' || path === '\\' ? 'index.html' : path;
    let file = join(root, rewritten);
    if (!extname(file) && existsSync(join(root, 'pages', `${rewritten}.html`))) file = join(root, 'pages', `${rewritten}.html`); // clean URLs
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    base: `http://localhost:${port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { base } = await startServer({ port: Number(process.env.PORT) || 5500 });
  console.info(`Vault Finance (dev) em ${base} — POST /api/finance ativo`);
}
