/**
 * E2E de Devedores (VF-2-03j): fechamento do mês e detalhamento de parcelas de cartão vinculadas.
 * Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const content = () => page.locator('#page-content').innerText();
const waitText = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#page-content').innerText), re.source);

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('seed: cartão, devedor e compra parcelada vinculada (service real)');
  const seeded = await page.evaluate(async () => {
    const { createCard, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const card = await createCard(uid, { name: 'Cartão E2E', brand: 'Visa', limitCents: '5.000,00', closingDay: 28, dueDay: 5 });
    const debtor = await createDebtor(uid, { name: 'Maria', lentCents: '1.000,00', loanDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const buy = await registerCardPurchase(uid, card.id, {
      description: 'Geladeira', amountCents: '300,00', installmentsTotal: 3, purchaseDate: today, debtorId: debtor.id,
    });
    return { ok: buy.ok, errors: buy.errors, months: buy.invoiceMonths };
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded.errors));
  // `invoiceMonths` do service traz ids de fatura (`<cardId>_<YYYY-MM>`): extrai o mês.
  const [firstMonth] = seeded.months.map((id) => id.split('_').pop()).sort();
  const [y, m] = firstMonth.split('-');

  log('devedores: total do mês destacado e emprestado consolidado (1.000 + 300)');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content .panel');
  await page.fill('#closing-month', firstMonth);
  await page.waitForFunction((label) => document.querySelector('#page-content thead').innerText.toLowerCase().includes(label), `a receber em ${m}/${y}`);
  const row = page.locator('#page-content tbody tr', { hasText: 'Maria' });
  assert.match(await row.innerText(), /R\$\s?1\.300,00/); // emprestado = 1.000 + 300 de cartão
  assert.match(await row.locator('td strong').innerText(), /R\$\s?100,00/); // 1ª parcela de 3
  assert.match(await content(), new RegExp(`A receber em ${m}/${y}`, 'i'));

  log('detalhamento: parcela 1/3, cartão, valor e status da fatura');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.waitForSelector('#statement-month');
  const modal = page.locator('.modal');
  await modal.getByText('Geladeira').first().waitFor();
  const detail = await modal.innerText();
  assert.match(detail, /1\/3/);
  assert.match(detail, /Cartão E2E/);
  assert.match(detail, /R\$\s?100,00/);
  assert.match(detail, /Pendente/);
  assert.match(detail, new RegExp(`Total a receber em ${m}/${y}`, 'i'));

  log('VF-2-03l: devedor sem empréstimo inicial pela UI e compra de cartão vinculada pela modal');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Novo devedor' }).click();
  await page.fill('#name', 'Zero Inicial');
  await page.locator('#debtor-form button[type="submit"]').click();
  await page.waitForFunction(() => /Zero Inicial/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Zero Inicial' }).innerText(), /R\$\s?0,00/);
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Nova compra em Cartão E2E' }).click();
  await page.fill('#description', 'Fogão');
  await page.fill('#amountCents', '200,00');
  const options = await page.locator('#debtorId option').allInnerTexts();
  assert.ok(options.some((t) => t.startsWith('Zero Inicial')), `seletor sem o devedor: ${options.join(' | ')}`);
  await page.selectOption('#debtorId', { label: options.find((t) => t.startsWith('Zero Inicial')) });
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForFunction(() => /Compra lançada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Zero Inicial' }).innerText(), /R\$\s?200,00/);
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Zero Inicial' }).click();
  await page.waitForSelector('#statement-month');
  // a fatura pode cair no mês seguinte (fechamento dia 28): escolhe o último mês listado
  const monthValues = await page.locator('#statement-month option').evaluateAll((opts) => opts.map((o) => o.value));
  await page.selectOption('#statement-month', monthValues.at(-1));
  await page.locator('.modal').getByText('Fogão').first().waitFor();

  log('VF-2-03m: dívida parcelada pela UI convive com a de cartão (lista única, total em aberto somado)');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.getByRole('button', { name: 'Nova dívida', exact: true }).click();
  await page.fill('#description', 'Moto');
  await page.fill('#totalCents', '600,00');
  await page.fill('#installments', '3');
  await page.locator('#debt-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida criada em 3 parcelas/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all');
  await page.waitForFunction(() => /Moto/.test(document.querySelector('.modal')?.innerText ?? ''));
  const all = await page.locator('.modal').innerText();
  for (const re of [/Moto\s+1\/3/, /Moto\s+2\/3/, /Moto\s+3\/3/, /Geladeira/, /Parcelada/, /Cartão/]) assert.match(all, re);
  assert.match(all, /Total em aberto\s+R\$\s?1\.900,00/); // 1.000 + 300 (cartão) + 600 (dívida)
  assert.doesNotMatch(all, /duplicidade/i);

  log('VF-2-03n: antecipar a parcela 3/3 e quitar o restante da dívida (cartão intacto)');
  const accountId = await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const r = await createAccount(auth.currentUser.uid, { institution: 'Banco E2E', name: 'Corrente', type: 'checking', initialBalanceCents: '0,00', color: '#1f7a5c', status: 'active' });
    return r.id;
  });
  const modalText = () => page.locator('.modal').innerText();
  // o modal carrega as contas ao abrir: reabre para enxergar a conta recém-criada
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.waitForSelector('#statement-month');
  await page.getByRole('button', { name: 'Quitar parcela 3 de Moto' }).click();
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Parcela antecipada e quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /Total em aberto\s+R\$\s?1\.700,00/.test(document.querySelector('.modal')?.innerText ?? '')); // 1.900 − 200
  assert.match(await modalText(), /Moto\s+3\/3[^\n]*R\$\s?200,00[^\n]*R\$\s?200,00[^\n]*Paga/);
  await page.getByRole('button', { name: 'Quitar dívida Moto' }).first().click();
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-settle-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /Total em aberto\s+R\$\s?1\.300,00/.test(document.querySelector('.modal')?.innerText ?? '')); // 1.000 + 300 de cartão
  const after = await modalText();
  assert.equal((after.match(/Moto\s+\d\/3[^\n]*Paga/g) ?? []).length, 3);
  assert.match(after, /Geladeira[^\n]*Pendente/); // compras de cartão intactas
  assert.equal(await page.getByRole('button', { name: /Quitar dívida Moto/ }).count(), 0);

  log('VF-2-03ak: quitar parcela individual e todas as parcelas pendentes de um mês (cartão + dívida), com Firestore e indicadores');
  const renan = await page.evaluate(async () => {
    const { listCards, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = (await listCards(uid)).filter((c) => c.name === 'Cartão E2E');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const debtor = await createDebtor(uid, { name: 'Renan', lentCents: '0,00', loanDate: today });
    let month = null;
    for (const [description, amountCents] of [['Água', '25,00'], ['Mercado', '78,00'], ['Supermercado', '28,00']]) {
      const r = await registerCardPurchase(uid, card.id, { description, amountCents, installmentsTotal: 1, purchaseDate: today, debtorId: debtor.id });
      month = r.invoiceMonths[0].split('_').pop();
    }
    // dívida parcelada em 2x de R$ 50: a 1ª vence no mês da fatura, a 2ª no seguinte
    await createDebtPlan(uid, { debtorId: debtor.id, description: 'Parcela', totalCents: '100,00', installments: 2, firstDueDate: `${month}-28` });
    return { id: debtor.id, month };
  });
  const snapshot = async () => page.evaluate(async ([debtorId, month]) => {
    const { loadDashboard } = await import('/js/services/dashboard.js');
    const { loadBalances } = await import('/js/services/balances.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const accs = await listAccounts(uid);
    const acc = accs.find((a) => a.institution === 'Banco E2E');
    const bal = (await loadBalances(uid, accs)).balances.get(acc.id);
    const dash = await loadDashboard(uid, { month, includeDebtors: true });
    const payments = (await list(uid, 'debtPayments', { where: [['debtorId', '==', debtorId]] })).map(({ id, debtId, purchaseId, amountCents, date, accountId }) => ({ id, debtId, purchaseId, amountCents, date, accountId }));
    const debtors = await list(uid, 'debtors', {});
    const debts = await list(uid, 'debts', { where: [['debtorId', '==', debtorId]] });
    return { bal, receivable: dash.monthlyForecast.debtors.receivableCents, payments, debtor: debtors.find((d) => d.id === debtorId), debts: debts.map((d) => ({ n: d.installmentNumber, status: d.status, due: d.dueDate })), accId: acc.id };
  }, [renan.id, renan.month]);
  const base0 = await snapshot();
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Renan' }).click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', renan.month);
  await page.waitForSelector('#month-settlement');
  assert.match(await page.locator('#month-settlement').innerText(), /4 pendente\(s\) · 0 paga\(s\)/);
  assert.match(await page.locator('#month-settlement').innerText(), /R\$\s?181,00/); // 25 + 78 + 28 + 50
  assert.equal(await page.getByRole('button', { name: /^Quitar dívida/ }).count(), 1); // dívida parcelada: quitar a dívida inteira é outra operação
  // — quitar UMA parcela (Água)
  await page.getByRole('button', { name: 'Quitar parcela 1 de Água' }).click();
  await page.selectOption('#accountId', base0.accId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Parcela (antecipada e )?quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /3 pendente\(s\) · 1 paga\(s\)/.test(document.querySelector('#month-settlement')?.innerText ?? ''));
  assert.equal(await page.locator('.modal [data-status="paid"]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Quitar parcela 1 de Água' }).count(), 0); // já paga: sem ação
  assert.equal(await page.getByRole('button', { name: 'Quitar parcela 1 de Mercado' }).count(), 1);
  const afterOne = await snapshot();
  assert.equal(afterOne.bal, base0.bal + 2500);
  assert.equal(afterOne.debtor.receivedCents, 2500);
  assert.deepEqual(afterOne.payments.map((p) => [!!p.id, !!p.purchaseId, !!p.debtId, p.amountCents]), [[true, true, false, 2500]]); // VF-ARQ-02: o ID do recebimento é do servidor (sem convenção)
  assert.equal(base0.receivable - afterOne.receivable, 2500); // a receber do mês (dashboard/previsão) caiu
  // — quitar TODAS as pendentes do mês, com confirmação
  await page.getByRole('button', { name: 'Quitar todas as parcelas pendentes deste mês' }).click();
  await page.waitForSelector('#debt-month-form');
  const confirmText = await page.locator('#debt-month-form').innerText();
  assert.match(confirmText, /3 parcela\(s\) pendente\(s\)/);
  assert.match(confirmText, /R\$\s?156,00/); // 78 + 28 + 50 (a Água já paga ficou de fora)
  await page.selectOption('#debt-month-form #accountId', base0.accId);
  await page.locator('#debt-month-form button[type="submit"]').click();
  await page.waitForFunction(() => /Mês quitado: 3 parcela/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /0 pendente\(s\) · 4 paga\(s\)/.test(document.querySelector('#month-settlement')?.innerText ?? ''));
  assert.equal(await page.getByRole('button', { name: 'Quitar todas as parcelas pendentes deste mês' }).count(), 0);
  const afterMonth = await snapshot();
  assert.equal(afterMonth.bal, base0.bal + 18100); // cada recebimento entrou UMA vez na conta (25+78+28+50)
  assert.equal(afterMonth.debtor.receivedCents, 18100);
  assert.equal(afterMonth.payments.length, 4); // histórico: 1 individual + 3 do lote, sem duplicar a Água
  assert.equal(new Set(afterMonth.payments.map((p) => p.id)).size, 4);
  assert.ok(afterMonth.payments.every((p) => p.id && p.accountId === base0.accId));
  assert.equal(afterMonth.payments.filter((p) => p.debtId).length, 1);
  assert.deepEqual(afterMonth.debts.map((d) => [d.n, d.status]).sort(), [[1, 'paid'], [2, 'pending']]); // a parcela do OUTRO mês não mudou
  assert.equal(base0.receivable - afterMonth.receivable, 18100);
  assert.equal(afterMonth.debtor.status, 'open');
  // repetir não duplica: nada pendente neste mês
  const dupe = await page.evaluate(async ([debtorId, month, accountId]) => {
    const { settleMonthInstallments } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    return settleMonthInstallments(auth.currentUser.uid, debtorId, month, { date: '2031-01-01', accountId });
  }, [renan.id, renan.month, base0.accId]);
  assert.equal(dupe.ok, false);
  assert.equal((await snapshot()).payments.length, 4);
  await page.keyboard.press('Escape');

  log('VF-2-03al: recebimento parcial (40 + 60 de uma parcela de R$ 100), histórico independente, saldo uma vez e tentativa simultânea');
  const parcial = await page.evaluate(async () => {
    const { listCards, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = (await listCards(uid)).filter((c) => c.name === 'Cartão E2E');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const debtor = await createDebtor(uid, { name: 'Parcial', lentCents: '0,00', loanDate: today });
    let month = null;
    for (const description of ['Sofá', 'Cadeira']) {
      const r = await registerCardPurchase(uid, card.id, { description, amountCents: '100,00', installmentsTotal: 1, purchaseDate: today, debtorId: debtor.id });
      month = r.invoiceMonths[0].split('_').pop();
    }
    const accounts = await listAccounts(uid);
    return { id: debtor.id, month, accId: accounts.find((a) => a.institution === 'Banco E2E').id };
  });
  const state = async () => page.evaluate(async ([debtorId, accId]) => {
    const { list } = await import('/js/services/firestore.js');
    const { loadBalances } = await import('/js/services/balances.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const accs = await listAccounts(uid);
    const bal = (await loadBalances(uid, accs)).balances.get(accId);
    const payments = (await list(uid, 'debtPayments', { where: [['debtorId', '==', debtorId]] })).map(({ id, purchaseId, amountCents, date }) => ({ id, purchaseId, amountCents, date }));
    const debtor = (await list(uid, 'debtors', {})).find((d) => d.id === debtorId);
    return { bal, payments: payments.sort((a, b) => a.id.localeCompare(b.id)), debtor };
  }, [parcial.id, parcial.accId]);
  const p0 = await state();
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Parcial' }).click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', parcial.month);
  await page.waitForSelector('#month-settlement');
  // 1) primeiro recebimento de R$ 40,00
  await page.getByRole('button', { name: 'Quitar parcela 1 de Sofá' }).click();
  await page.fill('#amountCents', '40,00');
  await page.selectOption('#accountId', parcial.accId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Recebimento parcial registrado \(restam R\$\s?60,00\)/.test(document.querySelector('.toast')?.innerText ?? ''));
  // 2) segue pendente (parcial), com o valor recebido visível
  await page.waitForFunction(() => /Parcial · recebido R\$\s?40,00 de R\$\s?100,00/.test(document.querySelector('.modal')?.innerText ?? ''));
  assert.equal(await page.locator('.modal [data-status="partial"]').count(), 1);
  assert.match(await page.locator('#month-settlement').innerText(), /2 pendente\(s\) \(1 com recebimento parcial\) · 0 paga\(s\)/);
  const p1 = await state();
  assert.deepEqual([p1.bal - p0.bal, p1.debtor.receivedCents, p1.payments.length], [4000, 4000, 1]);
  // 3–4) segundo recebimento de R$ 60,00 (valor sugerido = restante) → paga
  await page.getByRole('button', { name: 'Quitar parcela 1 de Sofá' }).click();
  assert.equal(await page.inputValue('#amountCents'), '60,00');
  await page.selectOption('#accountId', parcial.accId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Parcela (antecipada e )?quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /✓ Paga/.test(document.querySelector('.modal')?.innerText ?? ''));
  // 5–7) dois recebimentos independentes, total 100,00 e saldo +100,00 exatamente
  const p2 = await state();
  const sofa = p2.payments.filter((p) => p.purchaseId);
  assert.equal(p2.payments.length, 2);
  assert.deepEqual(p2.payments.map((p) => p.amountCents).sort((a, b) => a - b), [4000, 6000]);
  assert.equal(new Set(p2.payments.map((p) => p.id)).size, 2);
  assert.ok(sofa.every((p) => p.purchaseId));
  assert.equal(p2.debtor.receivedCents, 10000);
  assert.equal(p2.bal - p0.bal, 10000);
  // nada de receber acima do restante: a parcela paga não tem mais ação
  assert.equal(await page.getByRole('button', { name: 'Quitar parcela 1 de Sofá' }).count(), 0);
  await page.keyboard.press('Escape');
  // tentativa SIMULTÂNEA (transação do servidor): dois recebimentos de R$ 60,00 sobre a parcela "Cadeira" de R$ 100,00
  const race = await page.evaluate(async ([debtorId, accId]) => {
    const { settleInstallment } = await import('/js/services/debtPayments.js');
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const chair = (await list(uid, 'cardPurchases', { where: [['debtorId', '==', debtorId]] })).find((p) => p.description === 'Cadeira');
    const attempt = () => settleInstallment(uid, debtorId, { purchaseId: chair.id }, { amountCents: '60,00', date: '2026-12-20', accountId: accId }).then((r) => ({ ok: r.ok }), (e) => ({ ok: false, code: e.code }));
    const results = await Promise.all([attempt(), attempt()]);
    return { results, chairId: chair.id };
  }, [parcial.id, parcial.accId]);
  assert.equal(race.results.filter((r) => r.ok).length, 1, JSON.stringify(race.results)); // exatamente uma passa
  const p3 = await state();
  const chairPays = p3.payments.filter((p) => p.purchaseId === race.chairId);
  assert.equal(chairPays.length, 1);
  assert.equal(chairPays[0].amountCents, 6000);
  assert.equal(p3.debtor.receivedCents, 10000 + 6000); // o total do devedor == soma dos recebimentos (sem perda/excesso)
  assert.equal(p3.bal - p0.bal, 10000 + 6000);

  log('VF-2-03am: devedor quitado mantém ações, recebe nova dívida pela lista e nova compra de cartão (reabre)');
  const quit = await page.evaluate(async () => {
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan, settleMonthInstallments } = await import('/js/services/debtPayments.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const debtor = await createDebtor(uid, { name: 'Quitado Teste', lentCents: '0,00', loanDate: today });
    const plan = await createDebtPlan(uid, { debtorId: debtor.id, description: 'Primeira', totalCents: '100,00', installments: 1, firstDueDate: today });
    const acc = (await listAccounts(uid)).find((a) => a.institution === 'Banco E2E');
    const done = await settleMonthInstallments(uid, debtor.id, today.slice(0, 7), { date: today, accountId: acc.id });
    return { id: debtor.id, ok: plan.ok && done.ok, debtorPaid: done.debtorPaid };
  });
  assert.equal(quit.ok, true);
  assert.equal(quit.debtorPaid, true);
  const debtorState = () => page.evaluate(async (id) => {
    const { getDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    const d = await getDebtor(auth.currentUser.uid, id);
    return { status: d.status, lentCents: d.lentCents, receivedCents: d.receivedCents };
  }, quit.id);
  assert.deepEqual(await debtorState(), { status: 'paid', lentCents: 10000, receivedCents: 10000 });
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  const quitRow = page.locator('#page-content tbody tr', { hasText: 'Quitado Teste' });
  assert.match(await quitRow.innerText(), /Quitado/);
  // ações disponíveis para devedor quitado (antes: só "Parcelas" e "Excluir")
  for (const name of ['Parcelas e recebimentos de Quitado Teste', 'Nova dívida para Quitado Teste', 'Editar Quitado Teste', 'Excluir Quitado Teste']) {
    assert.equal(await page.getByRole('button', { name }).count(), 1, name);
  }
  assert.equal(await page.getByRole('button', { name: 'Cancelar Quitado Teste' }).count(), 0); // cancelar só de quem está em aberto
  await page.getByRole('button', { name: 'Nova dívida para Quitado Teste' }).click();
  await page.waitForSelector('#debt-form');
  await page.fill('#description', 'Segunda');
  await page.fill('#totalCents', '50,00');
  await page.locator('#debt-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida à vista criada/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtorState(), { status: 'open', lentCents: 15000, receivedCents: 10000 }); // reaberto: emprestado soma 50,00
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('#page-content tbody tr');
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Quitado Teste' }).innerText(), /Em aberto/);
  // quita de novo e lança compra de cartão vinculada ao devedor quitado (aparece no seletor e reabre)
  await page.evaluate(async (id) => {
    const { settleMonthInstallments, listDebts } = await import('/js/services/debtPayments.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const acc = (await listAccounts(uid)).find((a) => a.institution === 'Banco E2E');
    const [debt] = (await listDebts(uid, id)).filter((d) => d.status === 'pending');
    await settleMonthInstallments(uid, id, debt.dueDate.slice(0, 7), { date: debt.dueDate, accountId: acc.id });
  }, quit.id);
  assert.equal((await debtorState()).status, 'paid');
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Nova compra em Cartão E2E' }).click();
  await page.fill('#description', 'Compra pós quitação');
  await page.fill('#amountCents', '40,00');
  const labels = await page.locator('#debtorId option').allInnerTexts();
  const quitLabel = labels.find((t) => t.startsWith('Quitado Teste'));
  assert.ok(quitLabel && /quitado/.test(quitLabel), `seletor sem o devedor quitado: ${labels.join(' | ')}`);
  await page.selectOption('#debtorId', { label: quitLabel });
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForFunction(() => /Compra lançada/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtorState(), { status: 'open', lentCents: 19000, receivedCents: 15000 }); // reaberto: +40,00 emprestado

  log('VF-2-03p: pagar fatura com conta bancária e cancelar fatura vazia (modal Faturas e compras)');
  const seeded2 = await page.evaluate(async () => {
    const { listCards } = await import('/js/services/creditCards.js');
    const { create } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = await listCards(uid);
    await create(uid, 'invoices', { cardId: card.id, referenceMonth: '2031-01', dueDate: '2031-01-17', status: 'open' }, `${card.id}_2031-01`);
    return card.id;
  });
  assert.ok(seeded2);
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Faturas e compras de Cartão E2E' }).click();
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).count(), 1); // fatura R$ 0,00 sem compras
  assert.equal(await page.getByRole('button', { name: 'Pagar fatura 01/2031' }).count(), 0); // zerada: não paga
  await page.getByRole('button', { name: /Pagar fatura/ }).first().click();
  await page.selectOption('#accountId', { label: 'Banco E2E — Corrente' });
  await page.locator('#invoice-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Fatura paga/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Paga[^\n]*Banco E2E — Corrente/); // paga com a conta
  await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).click();
  await page.getByRole('button', { name: 'Cancelar fatura', exact: true }).click();
  await page.waitForFunction(() => /Fatura cancelada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).count(), 0);
  // VF-2-03t: a fatura cancelada some da lista (oculta por padrão), reaparece sob demanda e pode ser EXCLUÍDA
  assert.doesNotMatch(await page.locator('.modal').innerText(), /01\/2031/);
  await page.getByRole('button', { name: /Mostrar faturas canceladas/ }).click();
  await page.waitForFunction(() => /01\/2031[^\n]*Cancelada/.test(document.querySelector('.modal')?.innerText ?? ''));
  await page.getByRole('button', { name: 'Excluir fatura 01/2031' }).click();
  await page.getByRole('button', { name: 'Excluir fatura', exact: true }).click();
  await page.waitForFunction(() => /Fatura excluída/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: /Mostrar faturas canceladas/ }).count(), 0); // nada mais cancelado
  assert.doesNotMatch(await page.locator('.modal').innerText(), /01\/2031/);
  await page.keyboard.press('Escape');

  log('VF-2-03t: excluir cartão sem compras cujas faturas estão canceladas/zeradas (antes: bloqueado)');
  await page.evaluate(async () => {
    const { createCard } = await import('/js/services/creditCards.js');
    const { create } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const c = await createCard(uid, { name: 'Inter', brand: 'Visa', limitCents: '1.000,00', closingDay: 10, dueDay: 17 });
    await create(uid, 'invoices', { cardId: c.id, referenceMonth: '2031-02', dueDate: '2031-02-17', status: 'cancelled', totalCents: 0 }, `${c.id}_2031-02`);
    await create(uid, 'invoices', { cardId: c.id, referenceMonth: '2031-03', dueDate: '2031-03-17', status: 'cancelled' }, `${c.id}_2031-03`);
  });
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Excluir Inter' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForFunction(() => /Cartão excluído/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => !/Inter/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  const orphans = await page.evaluate(async () => {
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await list(auth.currentUser.uid, 'invoices')).filter((i) => /2031-0[23]$/.test(i.id)).length;
  });
  assert.equal(orphans, 0); // faturas removidas junto, sem órfãs

  log('VF-2-03r: assinatura no cartão vira parcela na fatura; consolidado em fatura aberta; fatura paga intacta');
  await page.evaluate(async () => {
    const { createCategory } = await import('/js/services/categories.js');
    const { auth } = await import('/js/firebase/client.js');
    await createCategory(auth.currentUser.uid, { name: 'Streaming', kind: 'expense', color: '#1f8a5b' });
  });
  await page.goto(`${app.base}/pages/assinaturas.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Netflix');
  await page.fill('#amountCents', '55,90');
  await page.selectOption('#accountId', { label: 'Banco E2E — Corrente' });
  await page.selectOption('#categoryId', { index: 1 });
  await page.selectOption('#cardId', { label: 'Cartão E2E' });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Netflix/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Netflix' }).innerText(), /Cartão Cartão E2E \(fatura\)/);
  await page.getByRole('button', { name: 'Registrar cobrança de Netflix' }).click();
  await page.waitForFunction(() => /Cobrança lançada na fatura do cartão/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Faturas e compras de Cartão E2E' }).click();
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Netflix[^\n]*R\$\s?55,90[^\n]*Assinatura/);
  await page.getByRole('button', { name: 'Lançar consolidado' }).click();
  const paidMonth = await page.evaluate(async () => {
    const { listCards, listInvoices } = await import('/js/services/creditCards.js');
    const { auth } = await import('/js/firebase/client.js');
    const [c] = await listCards(auth.currentUser.uid);
    return (await listInvoices(auth.currentUser.uid, c.id)).find((i) => i.status === 'paid')?.referenceMonth;
  });
  assert.ok(paidMonth, 'há uma fatura paga');
  await page.fill('#referenceMonth', paidMonth); // fatura já PAGA acima: não pode ser alterada
  await page.fill('#amountCents', '10,00');
  await page.locator('#consolidation-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await page.locator('.modal').innerText(), /já está paga e não é alterada/);
  await page.fill('#referenceMonth', '2031-06');
  await page.fill('#amountCents', '123,45');
  await page.locator('#consolidation-form button[type="submit"]').click();
  await page.waitForFunction(() => /Consolidado lançado/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Consolidado da fatura 06\/2031[^\n]*R\$\s?123,45[^\n]*Consolidado/);
  await page.keyboard.press('Escape');

  log('VF-2-03q: dashboard — blocos de saldo livre/vinculado, previsto, faturas do mês e devedores');
  log('cancelar a DÍVIDA inteira (parcelada): cancela as parcelas pendentes sem recebimento e mantém as com recebimento');
  const cancelSeed = await page.evaluate(async () => {
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan, listDebts, settleInstallment, registerDebtPayment } = await import('/js/services/debtPayments.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const acc = (await listAccounts(uid)).find((a) => a.institution === 'Banco E2E');
    const make = async (name, description) => {
      const debtor = await createDebtor(uid, { name, lentCents: '300,00', loanDate: today });
      const plan = await createDebtPlan(uid, { debtorId: debtor.id, description, totalCents: '300,00', installments: 3, firstDueDate: today });
      return { debtor, plan };
    };
    const a = await make('Cancela Tudo', 'Sofá');
    const b = await make('Cancela Parcial', 'Mesa');
    const [first, second] = (await listDebts(uid, b.debtor.id)).sort((x, y) => x.installmentNumber - y.installmentNumber);
    const paid = await settleInstallment(uid, b.debtor.id, { debtId: first.id }, { date: today, accountId: acc.id });
    const partial = await registerDebtPayment(uid, second.id, { amountCents: '40,00', date: today, accountId: acc.id });
    return { aOk: a.plan.ok, bOk: b.plan.ok, paidOk: paid.ok && partial.ok, errors: [a.plan.errors, b.plan.errors, paid.errors, partial.errors] };
  });
  assert.deepEqual([cancelSeed.aOk, cancelSeed.bOk, cancelSeed.paidOk], [true, true, true], JSON.stringify(cancelSeed.errors));
  const debtStatuses = (name) => page.evaluate(async (devName) => {
    const { listDebtors } = await import('/js/services/debtors.js');
    const { listDebts } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const debtor = (await listDebtors(uid)).find((d) => d.name === devName);
    return (await listDebts(uid, debtor.id)).sort((x, y) => x.installmentNumber - y.installmentNumber).map((d) => d.status);
  }, name);
  const cancelFromUi = async (devName, debtName) => {
    await page.goto(`${app.base}/pages/devedores.html`);
    await page.waitForSelector('#page-content tbody tr');
    await page.getByRole('button', { name: `Parcelas e recebimentos de ${devName}` }).click();
    await page.waitForSelector('#statement-month');
    await page.getByRole('button', { name: `Cancelar dívida ${debtName}` }).first().click();
    return page.locator('.modal').last().innerText();
  };
  const cancelAllText = await cancelFromUi('Cancela Tudo', 'Sofá');
  assert.match(cancelAllText, /Cancelar 3 parcela\(s\) pendente\(s\) de "Sofá"/);
  await page.evaluate(() => document.querySelector('.toast')?.remove()); // toast antigo não pode satisfazer a espera abaixo
  await page.getByRole('button', { name: 'Cancelar dívida', exact: true }).click();
  await page.waitForFunction(() => /Dívida cancelada \(3 parcela\(s\)\)/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtStatuses('Cancela Tudo'), ['cancelled', 'cancelled', 'cancelled']);
  const partialText = await cancelFromUi('Cancela Parcial', 'Mesa');
  assert.match(partialText, /Cancelar 1 parcela\(s\)/);
  assert.match(partialText, /1 parcela\(s\) com recebimento serão mantidas/);
  await page.evaluate(() => document.querySelector('.toast')?.remove()); // toast antigo não pode satisfazer a espera abaixo
  await page.getByRole('button', { name: 'Cancelar dívida', exact: true }).click();
  await page.waitForFunction(() => /Dívida cancelada \(1 parcela\(s\)\)/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtStatuses('Cancela Parcial'), ['paid', 'pending', 'cancelled']); // 2ª tem recebimento parcial: mantida

  log('cancelar VÁRIAS parcelas selecionadas (meses diferentes) em uma única requisição');
  await page.evaluate(async () => {
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const debtor = await createDebtor(uid, { name: 'Cancela Varias', lentCents: '400,00', loanDate: today });
    await createDebtPlan(uid, { debtorId: debtor.id, description: 'Carro', totalCents: '400,00', installments: 4, firstDueDate: today });
  });
  const cancelManyRequests = [];
  page.on('request', (rq) => { if (rq.url().includes('/api/finance') && /debt\.cancel/.test(rq.postData() ?? '')) cancelManyRequests.push(rq.postDataJSON()); });
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Cancela Varias' }).click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all');
  await page.waitForSelector('.cancel-pick');
  assert.match(await page.locator('#cancel-selected-count').innerText(), /Nenhuma parcela selecionada/);
  assert.equal(await page.locator('#cancel-selected').isDisabled(), true);
  await page.getByLabel('Selecionar parcela 2 de Carro').check();
  await page.getByLabel('Selecionar parcela 4 de Carro').check();
  assert.match(await page.locator('#cancel-selected-count').innerText(), /2 parcela\(s\) selecionada\(s\) · R\$\s?200,00/);
  await page.locator('#cancel-selected').click();
  await page.evaluate(() => document.querySelector('.toast')?.remove()); // toast antigo não pode satisfazer a espera abaixo
  await page.getByRole('button', { name: 'Cancelar 2 parcela(s)', exact: true }).click();
  await page.waitForFunction(() => /2 parcela\(s\) cancelada\(s\)\./.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtStatuses('Cancela Varias'), ['pending', 'cancelled', 'pending', 'cancelled']);
  assert.equal(cancelManyRequests.length, 1, 'UMA requisição para as duas parcelas');
  assert.equal(cancelManyRequests[0].op, 'debt.cancelMany');
  assert.equal(cancelManyRequests[0].params.debtIds.length, 2);
  // seleção em massa das restantes (seleção anterior foi zerada ao cancelar)
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all');
  await page.getByRole('button', { name: /^Selecionar todas as pendentes de todos os meses \(2\)$/ }).click();
  await page.waitForSelector('#cancel-selected:not([disabled])');
  assert.match(await page.locator('#cancel-selected-count').innerText(), /2 parcela\(s\) selecionada\(s\)/);
  await page.locator('#cancel-selected').click();
  await page.evaluate(() => document.querySelector('.toast')?.remove()); // toast antigo não pode satisfazer a espera abaixo
  await page.getByRole('button', { name: 'Cancelar 2 parcela(s)', exact: true }).click();
  await page.waitForFunction(() => /2 parcela\(s\) cancelada\(s\)\./.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual(await debtStatuses('Cancela Varias'), ['cancelled', 'cancelled', 'cancelled', 'cancelled']);

  log('VF-COR-07: assinatura sem conta — com devedor (cria dívida a receber) e sem vínculo (só acompanhamento)');
  await page.evaluate(async () => {
    const { createDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await createDebtor(auth.currentUser.uid, { name: 'Roberta', lentCents: '0,00', loanDate: today });
  });
  await page.goto(`${app.base}/pages/assinaturas.html`);
  await page.waitForSelector('#page-content .panel');
  const robertaState = () => page.evaluate(async () => {
    const { listDebtors } = await import('/js/services/debtors.js');
    const { listDebts } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const debtor = (await listDebtors(uid)).find((d) => d.name === 'Roberta');
    const debts = await listDebts(uid, debtor.id);
    return { lentCents: debtor.lentCents, debts: debts.map((d) => [d.description, d.principalCents, d.status, d.installmentsTotal]) };
  });
  // 1) CRIAR já com devedor: o vínculo lança a dívida da PRÓXIMA fatura (a da data da assinatura — uma só, sem avançar a data)
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  assert.equal(await page.locator('#accountId').getAttribute('required'), null, 'conta não é mais obrigatória');
  await page.fill('#name', 'Disney');
  await page.fill('#amountCents', '33,90');
  await page.selectOption('#categoryId', { index: 1 });
  await page.selectOption('#debtorId', { label: 'Roberta' });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida de .* lançada para Roberta \(a receber\)/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /Disney/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Disney' }).innerText(), /Devedor Roberta/);
  assert.deepEqual(await robertaState(), { lentCents: 3390, debts: [['Disney', 3390, 'pending', 1]] }); // UMA dívida, sem futuras
  // 2) EDITAR para vincular o devedor também lança (uma vez); editar de novo sem trocar o devedor NÃO relança
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Hulu');
  await page.fill('#amountCents', '10,00');
  await page.selectOption('#categoryId', { index: 1 });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Hulu/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.equal((await robertaState()).debts.length, 1, 'sem devedor: nada é lançado');
  await page.getByRole('button', { name: /^Editar Hulu/ }).click();
  await page.selectOption('#debtorId', { label: 'Roberta' });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Hulu/.test(document.querySelector('#page-content tbody')?.innerText ?? '') && /Roberta/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  await page.waitForFunction(() => /Assinatura atualizada com sucesso\. Dívida de .* lançada para Roberta/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.deepEqual((await robertaState()).debts.map((d) => d[0]).sort(), ['Disney', 'Hulu']);
  await page.evaluate(() => document.querySelector('.toast')?.remove());
  await page.getByRole('button', { name: /^Editar Hulu/ }).click();
  await page.fill('#name', 'Hulu Plus');
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Hulu Plus/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.equal((await robertaState()).debts.length, 2, 'editar outro campo não relança a cobrança');
  // 3) DUAS cobranças simultâneas da MESMA assinatura/data nunca duplicam a dívida (id determinístico + Rules)
  const chargeRace = await page.evaluate(async () => {
    const { listSubscriptions, registerSubscriptionCharge } = await import('/js/services/subscriptions.js');
    const { listDebtors } = await import('/js/services/debtors.js');
    const { listDebts } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const disney = (await listSubscriptions(uid)).find((x) => x.name === 'Disney');
    const results = await Promise.all([registerSubscriptionCharge(uid, disney.id), registerSubscriptionCharge(uid, disney.id)]);
    const debtor = (await listDebtors(uid)).find((d) => d.name === 'Roberta');
    const dues = (await listDebts(uid, debtor.id)).filter((d) => d.description === 'Disney').map((d) => String(d.dueDate));
    return { oks: results.filter((r) => r.ok).length, dues };
  });
  assert.equal(new Set(chargeRace.dues).size, chargeRace.dues.length, `dívidas duplicadas para a mesma data: ${chargeRace.dues}`);
  assert.ok(chargeRace.oks >= 1 && chargeRace.dues.length === 1 + chargeRace.oks, JSON.stringify(chargeRace)); // 1ª (ao criar) + as que de fato passaram
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Cloud pessoal');
  await page.fill('#amountCents', '9,90');
  await page.selectOption('#categoryId', { index: 1 });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Cloud pessoal/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Cloud pessoal' }).innerText(), /Sem vínculo \(só acompanhamento\)/);
  await page.getByRole('button', { name: 'Registrar cobrança de Cloud pessoal' }).click();
  await page.waitForFunction(() => /Sem cartão nem devedor: não gera despesa/.test(document.querySelector('.toast')?.innerText ?? ''));

  log('VF-COR-10: a dívida do devedor ACOMPANHA a assinatura (criar em 06/12, editar para 06/11, valor, pausar, retomar, cancelar)');
  await page.evaluate(async () => {
    const { createDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    await createDebtor(auth.currentUser.uid, { name: 'Marta', lentCents: '0,00', loanDate: '2026-11-01' });
  });
  const marta = () => page.evaluate(async () => {
    const { listDebtors } = await import('/js/services/debtors.js');
    const { listDebts } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const debtor = (await listDebtors(uid)).find((d) => d.name === 'Marta');
    const debts = (await listDebts(uid, debtor.id)).map((d) => [String(d.dueDate), d.principalCents, d.status]).sort();
    return { lentCents: debtor.lentCents, debts };
  });
  const fresh = () => page.evaluate(() => document.querySelector('.toast')?.remove());
  const toastWait = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.toast')?.innerText ?? ''), re.source);
  const submit = () => page.locator('#subscription-form button[type="submit"]').click();
  const rowText = (name) => page.locator('#page-content tbody tr', { hasText: name }).innerText();
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Prime');
  await page.fill('#amountCents', '20,00');
  await page.fill('#nextChargeDate', '2026-12-06');
  await page.selectOption('#categoryId', { index: 1 });
  await page.selectOption('#debtorId', { label: 'Marta' });
  await fresh(); await submit();
  await toastWait(/Dívida de 06\/12\/2026 lançada para Marta/);
  assert.deepEqual(await marta(), { lentCents: 2000, debts: [['2026-12-06', 2000, 'pending']] });
  assert.match(await rowText('Prime'), /06\/12\/2026/); // a data da assinatura NÃO avançou: é a data da dívida lançada
  // EDITAR a data para 06/11: a MESMA dívida é reagendada (não surge outra e o emprestado não dobra)
  await page.getByRole('button', { name: /^Editar Prime/ }).click();
  await page.fill('#nextChargeDate', '2026-11-06');
  await fresh(); await submit();
  await toastWait(/reagendada para 06\/11\/2026/);
  assert.deepEqual(await marta(), { lentCents: 2000, debts: [['2026-11-06', 2000, 'pending']] });
  assert.match(await rowText('Prime'), /06\/11\/2026/);
  // EDITAR o valor: a dívida e o emprestado acompanham a diferença
  await page.getByRole('button', { name: /^Editar Prime/ }).click();
  await page.fill('#amountCents', '30,00');
  await fresh(); await submit();
  await toastWait(/reagendada para 06\/11\/2026/);
  assert.deepEqual(await marta(), { lentCents: 3000, debts: [['2026-11-06', 3000, 'pending']] });
  // PAUSAR cancela a dívida pendente (o emprestado volta); RETOMAR lança de novo
  await fresh();
  await page.getByRole('button', { name: 'Pausar Prime' }).click();
  await toastWait(/Assinatura pausada\. A dívida pendente de 06\/11\/2026 de Marta foi cancelada/);
  assert.deepEqual(await marta(), { lentCents: 0, debts: [['2026-11-06', 3000, 'cancelled']] });
  await fresh();
  await page.getByRole('button', { name: 'Retomar Prime' }).click();
  await toastWait(/Assinatura retomada\. Dívida de 06\/11\/2026 lançada para Marta/);
  assert.deepEqual(await marta(), { lentCents: 3000, debts: [['2026-11-06', 3000, 'cancelled'], ['2026-11-06', 3000, 'pending']] });
  // REGISTRAR COBRANÇA fecha o ciclo: mantém a desta data e lança a da próxima fatura (a data da assinatura avança junto)
  await fresh();
  await page.getByRole('button', { name: 'Registrar cobrança de Prime' }).click();
  await toastWait(/Cobrança registrada; dívida da próxima fatura \(06\/12\/2026\) lançada para Marta/);
  assert.deepEqual(await marta(), { lentCents: 6000, debts: [['2026-11-06', 3000, 'cancelled'], ['2026-11-06', 3000, 'pending'], ['2026-12-06', 3000, 'pending']] });
  assert.match(await rowText('Prime'), /06\/12\/2026/);
  // CANCELAR a assinatura tira só a dívida da PRÓXIMA fatura; a do ciclo já registrado segue devida
  await fresh();
  await page.getByRole('button', { name: 'Cancelar Prime' }).click();
  await page.getByRole('button', { name: 'Cancelar assinatura', exact: true }).click().catch(() => {});
  await toastWait(/Assinatura cancelada\. A dívida pendente de 06\/12\/2026 de Marta foi cancelada/);
  assert.deepEqual(await marta(), { lentCents: 3000, debts: [['2026-11-06', 3000, 'cancelled'], ['2026-11-06', 3000, 'pending'], ['2026-12-06', 3000, 'cancelled']] });

  log('VF-COR-09: assinatura mensal do dia 31 mantém o dia ao longo dos ciclos (28/02 → 31/03 → 30/04)');
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Licença dia 31');
  await page.fill('#amountCents', '20,00');
  await page.fill('#nextChargeDate', '2027-01-31');
  await page.selectOption('#categoryId', { index: 1 });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Licença dia 31/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  const nextOf = async () => (await page.locator('#page-content tbody tr', { hasText: 'Licença dia 31' }).innerText()).match(/\d{2}\/\d{2}\/\d{4}/)?.[0];
  assert.equal(await nextOf(), '31/01/2027');
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const before = await nextOf();
    await page.evaluate(() => document.querySelector('.toast')?.remove());
    await page.getByRole('button', { name: 'Registrar cobrança de Licença dia 31' }).click();
    await page.waitForFunction((b) => !(document.querySelector('#page-content tbody tr:has(td)') && [...document.querySelectorAll('#page-content tbody tr')].find((r) => /Licença dia 31/.test(r.innerText))?.innerText.includes(b)), before);
    seen.push(await nextOf());
  }
  assert.deepEqual(seen, ['28/02/2027', '31/03/2027', '30/04/2027']);
  const stored = await page.evaluate(async () => {
    const { listSubscriptions } = await import('/js/services/subscriptions.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listSubscriptions(auth.currentUser.uid)).find((x) => x.name === 'Licença dia 31').chargeDay;
  });
  assert.equal(stored, 31);

  await page.goto(`${app.base}/pages/dashboard.html`);
  await page.waitForSelector('#dashboard-month');
  const dash = await page.locator('#page-content').innerText();
  for (const re of [/Saldo total/i, /Livre/, /Vinculado a metas/, /Receitas/, /previsto/i, /Faturas a pagar/i, /Limite utilizado/i, /A receber em/i, /Total em aberto/i]) assert.match(dash, re);
  assert.doesNotMatch(dash, /\bnull\b/);
  assert.doesNotMatch(dash, /Não foi possível carregar:/);

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E devedores OK');
} catch (error) {
  console.error(`E2E devedores FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-debtors-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-debtors-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
