/**
 * Corrigir compra lançada em fatura (troca atômica delete+create) com as Rules reais do emulador:
 * muda descrição e data (fatura nova), mantém valor/limite, bloqueia data em compra parcelada e em fatura fechada.
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  log('seed: cartão (fecha dia 10), compra à vista e compra 3x');
  await page.evaluate(async () => {
    const { createCard, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const c = await createCard(uid, { name: 'Banco Brasil', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 17 });
    const cardId = c.id ?? c.ids?.[0];
    const a = await registerCardPurchase(uid, cardId, { description: 'Fatura Dez', amountCents: '735,97', purchaseDate: '2026-11-01' });
    const b = await registerCardPurchase(uid, cardId, { description: 'Sofá', amountCents: '900,00', installmentsTotal: 3, purchaseDate: '2026-11-01' });
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a.errors, b.errors]));
  });

  log('abrir faturas e compras e corrigir descrição + data (vai para a fatura do novo ciclo)');
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.getByRole('button', { name: /Faturas e compras de Banco Brasil/ }).click();
  const dialog = page.locator('.modal__dialog');
  await dialog.getByRole('button', { name: 'Corrigir compra Fatura Dez' }).waitFor();
  await dialog.getByRole('button', { name: 'Corrigir compra Fatura Dez' }).click();
  await page.fill('#description', 'Compra de dezembro');
  await page.fill('#purchaseDate', '2026-12-20'); // após o fechamento (dia 10) → fatura 01/2027
  await page.locator('#purchase-edit-form button[type="submit"]').click();
  await page.waitForFunction(() => /Compra de dezembro/.test(document.querySelector('.modal__dialog')?.innerText ?? ''), null, { timeout: 15000 });
  const row = dialog.locator('tbody tr', { hasText: 'Compra de dezembro' });
  assert.match(await row.innerText(), /20\/12\/2026/);
  assert.match(await row.innerText(), /01\/2027/);
  assert.match(await row.innerText(), /R\$\s?735,97/);
  assert.equal(await dialog.getByText('Fatura Dez', { exact: true }).count(), 0, 'a compra antiga não permanece');
  assert.equal(await dialog.locator('tbody tr', { hasText: 'Compra de dezembro' }).count(), 1, 'sem duplicar');

  log('compra parcelada: data bloqueada, descrição editável');
  await dialog.getByRole('button', { name: 'Corrigir compra Sofá' }).first().click();
  assert.equal(await page.locator('#purchaseDate').isDisabled(), true);
  await page.fill('#description', 'Sofá novo');
  await page.locator('#purchase-edit-form button[type="submit"]').click();
  await page.waitForFunction(() => /Sofá novo/.test(document.querySelector('.modal__dialog')?.innerText ?? ''), null, { timeout: 15000 });
  assert.equal(await dialog.locator('tbody tr', { hasText: 'Sofá novo' }).count(), 1, 'só a parcela corrigida muda de descrição');
  assert.equal(await dialog.locator('tbody tr', { hasText: 'Sofá' }).count(), 3, 'as 3 parcelas continuam');

  log('limite usado não muda com a correção (735,97 + 900,00)');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /R\$\s?3\.364,03/.test(document.querySelector('#page-content').innerText)); // 5000 − 1635,97

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E corrigir compra OK');
} catch (error) {
  console.error(`E2E corrigir compra FALHOU na etapa "${step}":`, error.message);
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
