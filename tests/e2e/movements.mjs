/**
 * E2E dos módulos de movimentação (VF-4-03 / VF-3-02): bancos, receitas, despesas e transferências
 * contra os emuladores. Cobre CRUD pela UI, filtros, paginação por cursor ("Carregar mais antigas"),
 * ordenação, saldo derivado sob demanda e exclusão bloqueada de conta com vínculos.
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
const go = async (path) => {
  await page.goto(`${app.base}/pages/${path}.html`);
  await page.waitForSelector('#page-content .panel', { timeout: 15000 });
};
const content = () => page.locator('#page-content').innerText();
const rows = () => page.locator('#page-content tbody tr');
const iso = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + offsetDays * 86400000));
const brDate = (isoDate) => isoDate.split('-').reverse().join('/');
const waitText = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#page-content').innerText), re.source);
const waitRow = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#page-content tbody')?.innerText ?? ''), re.source);
const SEED = 105; // > PAGE_SIZE (100): força a segunda página

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('bancos: estado vazio, criar contas pela UI e saldo inicial visível');
  await go('bancos');
  assert.match(await content(), /Nenhuma conta cadastrada/);
  const createAccount = async (institution, name, type, initial) => {
    await page.getByRole('button', { name: 'Nova conta' }).click();
    await page.fill('#institution', institution);
    await page.fill('#name', name);
    await page.selectOption('#type', type);
    if (initial) await page.fill('#initialBalanceCents', initial);
    await page.locator('#account-form button[type="submit"]').click();
    await page.waitForFunction((n) => document.querySelector('#page-content').innerText.includes(n), name);
  };
  await createAccount('Banco A', 'Conta A', 'checking', '1.000,00');
  await createAccount('Banco B', 'Conta B', 'savings', '');
  assert.match(await rows().filter({ hasText: 'Conta A' }).innerText(), /R\$\s?1\.000,00/); // regressão: coluna lia campo inexistente
  assert.match(await content(), /Saldo atual derivado das movimentações/); // saldo atual calculado ao abrir a tela

  log('seed: categorias via service');
  const cats = await page.evaluate(async () => {
    const { createCategory } = await import('/js/services/categories.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const inc = await createCategory(uid, { name: 'Salário', kind: 'income', color: '#1f8a5b' });
    const exp = await createCategory(uid, { name: 'Mercado', kind: 'expense', color: '#c0392b' });
    return { inc: inc.id, exp: exp.id };
  });
  const accounts = await page.evaluate(async () => {
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const all = await listAccounts(auth.currentUser.uid);
    return Object.fromEntries(all.map((a) => [a.name, a.id]));
  });

  log('receitas: criar pela UI, filtrar, marcar recebida');
  await go('receitas');
  await page.getByRole('button', { name: 'Nova receita' }).click();
  await page.fill('#description', 'Salário UI');
  await page.selectOption('#categoryId', cats.inc);
  await page.fill('#amountCents', '2.000,00');
  await page.selectOption('#accountId', accounts['Conta A']);
  await page.selectOption('#status', 'pending');
  await page.locator('#income-form button[type="submit"]').click();
  await waitText(/Salário UI/);
  await page.selectOption('#filter-status', 'received');
  assert.match(await content(), /Nenhuma receita encontrada/);
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await waitText(/Salário UI/);
  await page.getByRole('button', { name: 'Marcar Salário UI como recebida' }).click();
  await waitRow(/Recebida/);
  await page.selectOption('#filter-status', 'received');
  assert.equal(await rows().count(), 1);

  log('receitas: paginação por cursor (100 + carregar mais), ordem decrescente');
  await page.evaluate(async ([n, account, category]) => {
    const { createIncome } = await import('/js/services/incomes.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const day = (i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - i * 86400000));
    for (let i = 1; i <= n; i += 1) {
      const r = await createIncome(uid, { description: `Seed R ${i}`, categoryId: category, amountCents: '1,00', expectedDate: day(i), accountId: account, status: 'pending', recurrence: 'none' });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
    }
  }, [SEED, accounts['Conta A'], cats.inc]);
  await go('receitas');
  assert.equal(await rows().count(), 100);
  assert.match(await page.locator('#pager-footer').innerText(), /Mostrando as 100 receitas mais recentes/);
  assert.doesNotMatch(await content(), /Seed R 105\b/);
  const firstDates = await rows().locator('td:nth-child(4)').allInnerTexts();
  assert.match(firstDates[0], new RegExp(brDate(iso(0)))); // mais recente primeiro (hoje)
  await page.locator('#pager-more').click();
  await page.waitForFunction(() => document.querySelectorAll('#page-content tbody tr').length === 106);
  assert.equal(await page.locator('#pager-footer').count(), 0);
  assert.match(await content(), /Seed R 105\b/);
  const texts = await rows().allInnerTexts();
  assert.equal(new Set(texts.map((t) => t.split('\t')[0])).size, 106, 'sem duplicados entre páginas');

  log('despesas: criar pela UI, pagar, paginação com ordem crescente de vencimento');
  await go('despesas');
  await page.getByRole('button', { name: 'Nova despesa' }).click();
  await page.fill('#description', 'Compras UI');
  await page.selectOption('#categoryId', cats.exp);
  await page.fill('#amountCents', '300,00');
  await page.selectOption('#accountId', accounts['Conta A']);
  await page.selectOption('#status', 'pending');
  await page.locator('#expense-form button[type="submit"]').click();
  await waitText(/Compras UI/);
  await page.getByRole('button', { name: 'Marcar Compras UI como paga' }).click();
  await waitRow(/Paga/);
  await page.evaluate(async ([n, account, category]) => {
    const { createExpense } = await import('/js/services/expenses.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const day = (i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - i * 86400000));
    for (let i = 1; i <= n; i += 1) {
      const d = day(i);
      const r = await createExpense(uid, { description: `Seed D ${i}`, categoryId: category, amountCents: '1,00', accountId: account, purchaseDate: d, dueDate: d, status: 'pending', recurrence: 'none' });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
    }
  }, [SEED, accounts['Conta A'], cats.exp]);
  await go('despesas');
  assert.equal(await rows().count(), 100);
  assert.match(await page.locator('#pager-footer').innerText(), /Mostrando as 100 despesas mais recentes/);
  assert.doesNotMatch(await content(), /Seed D 105\b/);
  const dueCells = await rows().locator('td:nth-child(4)').allInnerTexts();
  const toIso = (br) => br.split('/').reverse().join('-');
  const dueIso = dueCells.map(toIso);
  assert.deepEqual(dueIso, [...dueIso].sort(), 'vencimentos em ordem crescente (comportamento anterior preservado)');
  assert.equal(dueIso.at(-1), iso(0)); // a mais recente por último
  await page.locator('#pager-more').click();
  await page.waitForFunction(() => document.querySelectorAll('#page-content tbody tr').length === 106);
  const allDue = (await rows().locator('td:nth-child(4)').allInnerTexts()).map(toIso);
  assert.deepEqual(allDue, [...allDue].sort());
  assert.equal(allDue[0], iso(-SEED));
  assert.match(await content(), /Seed D 105\b/);

  log('transferências: criar pela UI, confirmar, paginação');
  await go('transferencias');
  await page.getByRole('button', { name: 'Nova transferência' }).click();
  await page.selectOption('#fromAccountId', accounts['Conta A']);
  await page.selectOption('#toAccountId', accounts['Conta B']);
  await page.fill('#amountCents', '500,00');
  await page.fill('#reason', 'Reserva UI');
  await page.selectOption('#status', 'pending');
  await page.locator('#transfer-form button[type="submit"]').click();
  await waitText(/Reserva UI/);
  await page.getByRole('button', { name: /Confirmar transferência de R\$\s?500,00/ }).click();
  await waitRow(/Confirmada/);
  const uiRow = await rows().filter({ hasText: 'Reserva UI' }).innerText();
  assert.match(uiRow, /Banco A — Conta A/); // regressão: colunas liam campos inexistentes (origem/destino/valor)
  assert.match(uiRow, /Banco B — Conta B/);
  assert.match(uiRow, /R\$\s?500,00/);
  await page.evaluate(async ([n, from, to]) => {
    const { createTransfer } = await import('/js/services/transfers.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    for (let i = 1; i <= n; i += 1) {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - i * 86400000));
      const r = await createTransfer(uid, { fromAccountId: from, toAccountId: to, amountCents: '1,00', date: d, reason: `Seed T ${i}`, status: 'pending' });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
    }
  }, [SEED, accounts['Conta A'], accounts['Conta B']]);
  await go('transferencias');
  assert.equal(await rows().count(), 100);
  assert.match(await page.locator('#pager-footer').innerText(), /Mostrando as 100 transferências mais recentes/);
  assert.doesNotMatch(await content(), /Seed T 105\b/);
  await page.locator('#pager-more').click();
  await page.waitForFunction(() => document.querySelectorAll('#page-content tbody tr').length === 106);
  assert.match(await content(), /Seed T 105\b/);
  assert.equal(await page.locator('#pager-footer').count(), 0);

  log('bancos: saldo atual derivado sob demanda e exclusão bloqueada');
  await go('bancos');
  // A: 1000 + 2000 (recebida) − 300 (paga) − 500 (transferência confirmada) = 2200 · B: 500
  await page.getByRole('button', { name: 'Recalcular saldo atual' }).click();
  await waitText(/Saldo atual derivado/);
  assert.match(await rows().filter({ hasText: 'Conta A' }).innerText(), /R\$\s?2\.200,00/);
  assert.match(await rows().filter({ hasText: 'Conta B' }).innerText(), /R\$\s?500,00/);
  assert.match(await content(), /R\$\s?2\.700,00/);
  log('VF-2-03o: meta vinculada a conta (caixinha) segue o saldo da conta; sem aporte duplicado');
  await go('metas');
  await page.getByRole('button', { name: 'Nova meta' }).click();
  await page.fill('#name', 'Caixinha UI');
  await page.fill('#targetCents', '1.000,00');
  await page.fill('#deadline', '2027-12-31'); // regressão: prazo ia como string e as Rules negavam (permission-denied)
  await page.selectOption('#accountId', accounts['Conta B']);
  await page.locator('#goal-form button[type="submit"]').click();
  await waitRow(/Caixinha UI/);
  assert.doesNotMatch(await content(), /\bnull\b/); // regressão: replaceChildren(null) renderizava o texto "null"
  const goalRow = await rows().filter({ hasText: 'Caixinha UI' }).innerText();
  assert.match(goalRow, /saldo de Banco B — Conta B/);
  assert.match(goalRow, /R\$\s?500,00/); // saldo da Conta B (transferência confirmada)
  assert.match(goalRow, /50%/);
  assert.match(goalRow, /31\/12\/2027/); // prazo gravado como Timestamp e lido de volta
  assert.equal(await page.getByRole('button', { name: 'Aportar em Caixinha UI' }).count(), 0); // fonte única: transferências

  log('VF-ARQ-02: despesa paga e receita recebida são imutáveis; a correção é por ESTORNO (compensatório, com motivo); saldo derivado volta');
  const reverse = async (label, summaryRe) => {
    await page.getByRole('button', { name: label }).click();
    await page.waitForSelector('.modal');
    assert.match(await page.locator('.modal').innerText(), summaryRe); // resumo do lançamento antes de confirmar
    await page.fill('#reason', 'Lançado por engano (E2E)');
    await page.locator('#reversal-form button[type="submit"]').click();
    await page.waitForFunction(() => /Estorno registrado/.test(document.querySelector('.toast')?.innerText ?? ''));
  };
  await go('despesas');
  await waitText(/Conta debitada|CONTA DEBITADA/);
  assert.match(await content(), /Cartões \/ Faturas/); // despesa direta × fatura de cartão
  assert.match(await rows().filter({ hasText: 'Compras UI' }).innerText(), /Banco A — Conta A/);
  assert.equal(await page.getByRole('button', { name: 'Excluir Compras UI' }).count(), 0, 'despesa paga não tem excluir');
  assert.equal(await page.getByRole('button', { name: 'Editar Compras UI' }).count(), 0, 'despesa paga não tem editar');
  await reverse('Estornar Compras UI', /Compras UI/);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Estornar Compras UI"]')); // a lista recarrega após a confirmação do servidor
  assert.ok(await page.getByRole('button', { name: 'Excluir Compras UI' }).count() > 0, 'estornada volta a pendente (editável/excluível)');
  await go('receitas');
  assert.equal(await page.getByRole('button', { name: 'Excluir Salário UI' }).count(), 0, 'receita recebida não tem excluir');
  await reverse('Estornar Salário UI', /Salário UI/);
  await go('bancos');
  await page.getByRole('button', { name: 'Recalcular saldo atual' }).click();
  await waitText(/Saldo atual derivado/);
  assert.match(await rows().filter({ hasText: 'Conta A' }).innerText(), /R\$\s?500,00/); // 1000 − 500 (transferência); estornos devolvem/retiram o que foi liquidado

  await page.getByRole('button', { name: 'Excluir Conta A' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForFunction(() => /não pode ser apagada|arquive-a/.test(document.querySelector('.toast')?.innerText ?? ''));

  log('contas sem nome: criar só com instituição, editar, receita vinculada persiste só accountId, rótulos sem duplicar');
  await go('bancos');
  await page.getByRole('button', { name: 'Nova conta' }).click();
  await page.fill('#institution', 'Alelo Pod');
  await page.selectOption('#type', 'benefit');
  await page.locator('#account-form button[type="submit"]').click();
  await waitText(/Alelo Pod/);
  await page.getByRole('button', { name: 'Editar Alelo Pod' }).click();
  await page.fill('#institution', 'Alelo Pod');
  await page.locator('#account-form button[type="submit"]').click();
  await page.waitForFunction(() => /atualizada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.getByRole('button', { name: 'Nova conta' }).click();
  await page.fill('#institution', 'Sodexo');
  await page.fill('#name', 'Sodexo');
  await page.selectOption('#type', 'benefit');
  await page.locator('#account-form button[type="submit"]').click();
  await waitText(/Sodexo/);
  await go('receitas');
  await page.getByRole('button', { name: 'Nova receita' }).click();
  const labels = await page.locator('#accountId option').allInnerTexts();
  assert.ok(labels.includes('Alelo Pod'), `rótulos: ${labels}`);
  assert.ok(labels.includes('Sodexo') && !labels.some((l) => /Sodexo — Sodexo|Alelo Pod — /.test(l)), `rótulos: ${labels}`);
  assert.ok(labels.includes('Banco A — Conta A'), `rótulos: ${labels}`);
  const alelo = await page.evaluate(async () => {
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listAccounts(auth.currentUser.uid)).find((a) => a.institution === 'Alelo Pod');
  });
  assert.equal('name' in alelo, false, 'conta só com instituição não grava `name`');
  await page.fill('#description', 'Vale UI');
  await page.selectOption('#categoryId', cats.inc);
  await page.fill('#amountCents', '300,00');
  await page.selectOption('#accountId', alelo.id);
  await page.selectOption('#status', 'pending');
  await page.locator('#income-form button[type="submit"]').click();
  await waitText(/Vale UI/);
  const stored = await page.evaluate(async () => {
    const { listIncomes } = await import('/js/services/incomes.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listIncomes(auth.currentUser.uid)).find((i) => i.description === 'Vale UI');
  });
  assert.equal(stored.accountId, alelo.id);
  assert.equal('institution' in stored || 'name' in stored, false, 'receita não persiste institution/name');
  await page.getByRole('button', { name: 'Editar Vale UI' }).click();
  await page.fill('#description', 'Vale UI editado');
  await page.locator('#income-form button[type="submit"]').click();
  await waitText(/Vale UI editado/);
  const edited = await page.evaluate(async () => {
    const { listIncomes } = await import('/js/services/incomes.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listIncomes(auth.currentUser.uid)).find((i) => i.description === 'Vale UI editado');
  });
  assert.equal(edited.accountId, alelo.id, 'edição preserva o vínculo');
  console.info('  payload persistido:', JSON.stringify(Object.keys(edited).sort()));

  log('transferências: confirmada de conta sem saldo é bloqueada; pendente é aceita e a confirmação também é bloqueada');
  await go('transferencias');
  const transferFromEmpty = async (status, reason) => {
    await page.getByRole('button', { name: 'Nova transferência' }).click();
    await page.selectOption('#fromAccountId', alelo.id); // conta vazia (saldo 0)
    await page.selectOption('#toAccountId', accounts['Conta A']);
    await page.fill('#amountCents', '10,00');
    await page.fill('#reason', reason);
    await page.selectOption('#status', status);
    await page.locator('#transfer-form button[type="submit"]').click();
  };
  await transferFromEmpty('confirmed', 'Sem saldo UI');
  await page.waitForFunction(() => /Saldo insuficiente em Alelo Pod: disponível R\$ 0,00/.test(document.querySelector('#transfer-form')?.innerText ?? ''));
  await page.getByRole('button', { name: /Cancelar|Fechar/ }).first().click().catch(() => {});
  const leaked = await page.evaluate(async () => {
    const { listTransfers } = await import('/js/services/transfers.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listTransfers(auth.currentUser.uid)).some((t) => t.reason === 'Sem saldo UI');
  });
  assert.equal(leaked, false, 'transferência sem saldo não pode ser gravada');

  log('transferências: estornar confirmada (compensatório) e excluir pendente pela UI');
  await go('transferencias');
  const createTransferUi = async (status, reason) => {
    await page.getByRole('button', { name: 'Nova transferência' }).click();
    await page.selectOption('#fromAccountId', accounts['Conta A']);
    await page.selectOption('#toAccountId', alelo.id);
    await page.fill('#amountCents', '10,00');
    await page.fill('#reason', reason);
    await page.selectOption('#status', status);
    await page.locator('#transfer-form button[type="submit"]').click();
    await waitText(new RegExp(reason));
  };
  const balanceOf = (id) => page.evaluate(async (accountId) => {
    const { listAccounts } = await import('/js/services/accounts.js');
    const { loadBalances } = await import('/js/services/balances.js');
    const { auth } = await import('/js/firebase/client.js');
    const accs = await listAccounts(auth.currentUser.uid);
    return (await loadBalances(auth.currentUser.uid, accs)).balances.get(accountId);
  }, id);
  const before = await balanceOf(alelo.id);
  await createTransferUi('confirmed', 'Apagar confirmada UI');
  assert.equal(await balanceOf(alelo.id), before + 1000);
  const confirmedRow = rows().filter({ hasText: 'Apagar confirmada UI' });
  assert.equal(await confirmedRow.getByRole('button', { name: 'Excluir transferência' }).count(), 0, 'transferência confirmada não tem excluir');
  await confirmedRow.getByRole('button', { name: 'Estornar transferência' }).click(); // VF-ARQ-02: correção por estorno compensatório
  await page.waitForSelector('.modal');
  await page.fill('#reason', 'Valor errado (E2E)');
  await page.locator('#reversal-form button[type="submit"]').click();
  await page.waitForFunction(() => /Estorno registrado/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.equal(await balanceOf(alelo.id), before, 'saldo volta ao valor anterior');
  await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].some((tr) => /Apagar confirmada UI/.test(tr.innerText) && /Cancelada/.test(tr.innerText))); // original preservado, status compensado
  await createTransferUi('pending', 'Apagar pendente UI');
  await rows().filter({ hasText: 'Apagar pendente UI' }).getByRole('button', { name: 'Excluir transferência' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForFunction(() => !/Apagar pendente UI/.test(document.querySelector('#page-content').innerText));
  assert.equal(await balanceOf(alelo.id), before);

  log('transferências ↔ metas: aportar (conta → meta), sacar (meta → conta), saldo insuficiente e resgate acima do guardado');
  const goalId = await page.evaluate(async () => {
    const { createGoal } = await import('/js/services/goals.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await createGoal(auth.currentUser.uid, { name: 'Viagem UI', targetCents: '1.000,00' })).id;
  });
  const goalSavedNow = (id) => page.evaluate(async (g) => {
    const { listGoalTransactions, goalSavedCents } = await import('/js/services/goals.js');
    const { auth } = await import('/js/firebase/client.js');
    return goalSavedCents(await listGoalTransactions(auth.currentUser.uid, g));
  }, id);
  const goalTransferUi = async (from, to, amount, reason) => {
    await go('transferencias');
    await page.getByRole('button', { name: 'Nova transferência' }).click();
    await page.selectOption('#fromAccountId', from);
    await page.selectOption('#toAccountId', to);
    await page.fill('#amountCents', amount);
    await page.fill('#reason', reason);
    await page.locator('#transfer-form button[type="submit"]').click();
  };
  const balA = await balanceOf(accounts['Conta A']);
  await goalTransferUi(accounts['Conta A'], `goal:${goalId}`, '20,00', 'Aporte UI');
  await waitText(/Aporte \(conta → meta\)/);
  assert.equal(await balanceOf(accounts['Conta A']), balA - 2000);
  assert.equal(await goalSavedNow(goalId), 2000);
  assert.match(await content(), /Viagem UI/);

  await goalTransferUi(`goal:${goalId}`, accounts['Conta A'], '5,00', 'Saque UI');
  await waitText(/Resgate \(meta → conta\)/);
  assert.equal(await balanceOf(accounts['Conta A']), balA - 1500);
  assert.equal(await goalSavedNow(goalId), 1500);

  await goalTransferUi(`goal:${goalId}`, accounts['Conta A'], '100,00', 'Saque demais UI');
  await page.waitForFunction(() => /excede|insuficiente|maior/i.test(document.querySelector('#transfer-form')?.innerText ?? ''));
  assert.equal(await goalSavedNow(goalId), 1500, 'resgate acima do guardado não grava');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await goalTransferUi(alelo.id, `goal:${goalId}`, '10,00', 'Aporte sem saldo UI');
  await page.waitForFunction(() => /Saldo insuficiente em Alelo Pod/.test(document.querySelector('#transfer-form')?.innerText ?? ''));
  assert.equal(await goalSavedNow(goalId), 1500, 'aporte sem saldo não grava');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  log('saldo de abertura: ajustar para o saldo real (só a abertura muda) e previsão do mês no dashboard');
  await go('bancos');
  await page.getByRole('button', { name: 'Nova conta' }).click();
  await page.fill('#institution', 'Ajuste Bank');
  await page.selectOption('#type', 'checking');
  await page.locator('#account-form button[type="submit"]').click();
  await waitText(/Ajuste Bank/);
  const adj = () => rows().filter({ hasText: 'Ajuste Bank' });
  await page.getByRole('button', { name: 'Ajustar saldo de Ajuste Bank' }).click();
  await page.fill('#realBalance', '1.234,56');
  await page.waitForFunction(() => /Abertura:.*→.*1\.234,56/.test(document.querySelector('#adjust-form')?.innerText ?? ''));
  await page.locator('#adjust-form button[type="submit"]').click().catch(async () => page.getByRole('button', { name: 'Confirmar ajuste' }).click());
  await page.waitForFunction(() => /ajustado/.test(document.querySelector('.toast')?.innerText ?? ''));
  await waitText(/1\.234,56/);
  assert.equal((await adj().innerText().then((t) => t.match(/R\$\s?1\.234,56/g) ?? [])).length, 2, `abertura e saldo atual = 1.234,56: ${await adj().innerText()}`);
  const ajuste = await page.evaluate(async () => {
    const { listAccounts } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await listAccounts(auth.currentUser.uid)).find((a) => a.institution === 'Ajuste Bank');
  });
  assert.equal(ajuste.initialBalanceCents, 123456);
  assert.equal('openingDate' in ajuste, false);

  await go('dashboard');
  await waitText(/Previsão do mês/);
  assert.match(await content(), /Saldo projetado ao fim do mês/);
  await page.locator('#dashboard-forecast-details > summary').click(); // detalhes recolhidos por padrão
  assert.match(await content(), /Como o saldo projetado foi calculado/);
  assert.match(await content(), /Compromissos dos próximos meses/);
  await page.locator('#include-debtors').check();
  await waitText(/A receber de devedores/);

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E movimentos OK');
} catch (error) {
  console.error(`E2E movimentos FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-movements-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-movements-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
