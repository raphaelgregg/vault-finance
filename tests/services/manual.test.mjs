import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { NAV_ITEMS } from '../../js/utils/nav.js';

const md = readFileSync(new URL('../../docs/manual/manual-usuario.md', import.meta.url), 'utf8');
const pdfPath = new URL('../../assets/manual/manual-vault-finance.pdf', import.meta.url);

test('manual do usuário cita cada item do menu', () => {
  for (const item of NAV_ITEMS) assert.ok(md.includes(item.label), `o manual não menciona "${item.label}"`);
});

test('manual cobre como as operações se comunicam e as garantias', () => {
  for (const term of ['estorno', 'Previsto', 'Realizado', 'servidor', 'duplicidade', 'Glossário']) {
    assert.ok(md.toLowerCase().includes(term.toLowerCase()), `faltou "${term}"`);
  }
});

test('o PDF existe, é um PDF e a Configurações oferece o download', () => {
  assert.ok(existsSync(pdfPath), 'rode `npm run manual:build` e comite o PDF');
  const head = readFileSync(pdfPath).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-');
  const cfg = readFileSync(new URL('../../js/modules/configuracoes.js', import.meta.url), 'utf8');
  assert.match(cfg, /\/assets\/manual\/manual-vault-finance\.pdf/);
});

test('o manual não expõe segredos nem detalhes internos de infraestrutura', () => {
  assert.doesNotMatch(md, /FIREBASE_SERVICE_ACCOUNT|firestore\.rules|service account|api\/finance/i);
});
