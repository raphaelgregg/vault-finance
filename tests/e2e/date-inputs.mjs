/**
 * Campos de data em DD/MM/AAAA, independentes do idioma do navegador (o contexto do teste é en-US, onde o
 * <input type=date> nativo mostraria mm/dd/aaaa): máscara ao digitar, valor gravado em ISO, data inválida e calendário.
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
  await page.evaluate(async () => {
    const { createCard } = await import('/js/services/creditCards.js');
    const { auth } = await import('/js/firebase/client.js');
    const r = await createCard(auth.currentUser.uid, { name: 'Cartão Datas', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 17 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  });
  const purchaseDates = () => page.evaluate(async () => {
    const { listCards, listCardPurchases } = await import('/js/services/creditCards.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = await listCards(uid);
    return (await listCardPurchases(uid, card.id)).map((p) => [p.description, p.purchaseDate]);
  });

  log('campo de data é texto DD/MM/AAAA (hoje já no formato brasileiro) e tem botão de calendário');
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.getByRole('button', { name: 'Nova compra em Cartão Datas' }).click();
  const field = page.locator('#purchaseDate');
  assert.match(await field.inputValue().then((v) => v), /^\d{2}\/\d{2}\/\d{4}$/, 'valor inicial em DD/MM/AAAA');
  assert.equal(await field.getAttribute('type'), 'text');
  assert.equal(await page.locator('.modal .date-wrap__btn').count(), 1);

  log('digitar só números aplica a máscara e grava a data certa (05/11/2026 → 2026-11-05)');
  await page.fill('#description', 'Compra datada');
  await page.fill('#amountCents', '100,00');
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('05112026');
  assert.equal(await field.inputValue(), '05/11/2026');
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 15000 });
  assert.deepEqual(await purchaseDates(), [['Compra datada', '2026-11-05']]);

  log('data inexistente (31/02/2026) é recusada com a mensagem em DD/MM/AAAA');
  await page.getByRole('button', { name: 'Nova compra em Cartão Datas' }).click();
  await page.fill('#description', 'Data ruim');
  await page.fill('#amountCents', '50,00');
  await page.locator('#purchaseDate').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('31022026');
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await page.locator('.modal').innerText(), /DD\/MM\/AAAA/);
  assert.equal((await purchaseDates()).length, 1, 'nada gravado');
  await page.keyboard.press('Escape');

  log('mês em MM/AAAA: o seletor do dashboard mostra 11/2026 e digitar muda o mês dos indicadores');
  await page.goto(`${app.base}/pages/dashboard.html`);
  await page.waitForSelector('#dashboard-month');
  assert.match(await page.locator('#dashboard-month').inputValue(), /^\d{2}\/\d{4}$/);
  await page.locator('#dashboard-month').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('062026');
  assert.equal(await page.locator('#dashboard-month').inputValue(), '06/2026');
  await page.locator('#dashboard-month').press('Tab');
  await page.waitForFunction(() => /06\/2026/.test(document.querySelector('#page-content').innerText) && /Exibindo: 06\/2026/.test(document.querySelector('#page-content').innerText));

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E datas OK');
} catch (error) {
  console.error(`E2E datas FALHOU na etapa "${step}":`, error.message);
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
