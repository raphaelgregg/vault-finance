#!/usr/bin/env node
/**
 * Gera o PDF do manual do usuário (VF-DOC-02): docs/manual/manual-usuario.md → assets/manual/manual-vault-finance.pdf.
 * Ferramentas de AUTOR (não entram em produção nem no package.json): `pandoc` (Markdown → HTML) e `playwright`/Chromium (HTML → PDF).
 * Rode `npm run manual:build` depois de editar o Markdown e comite o PDF gerado.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs/manual/manual-usuario.md');
const output = join(root, 'assets/manual/manual-vault-finance.pdf');
const work = mkdtempSync(join(tmpdir(), 'vault-manual-'));
const html = join(work, 'manual.html');

execFileSync('pandoc', [source, '--standalone', '--toc', '--toc-depth=2', '--metadata', 'toc-title=Sumário',
  '--css', join(root, 'docs/manual/manual.css'), '--embed-resources', '-o', html], { stdio: 'inherit' });

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(html).href);
  mkdirSync(dirname(output), { recursive: true });
  const pdf = await page.pdf({
    format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#667">Vault Finance — Manual do usuário · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
  });
  writeFileSync(output, pdf);
  console.info(`Manual gerado: ${output} (${(readFileSync(output).length / 1024).toFixed(0)} KB)`);
} finally {
  await browser.close();
}
