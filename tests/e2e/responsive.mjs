/**
 * E2E — responsividade e modais: em 390px (celular) e 768px (tablet), com dados reais semeados (seedFullTestSuite):
 *  - nenhuma página estoura a largura (sem rolagem horizontal do documento);
 *  - todo modal de criação/edição abre dentro da tela e com o botão principal (Salvar/Criar) VISÍVEL sem rolar;
 *  - o modal tem role="dialog" e aria-modal, foco dentro e fecha com ESC;
 *  - nenhum erro de console/página.
 * Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const PAGES = ['dashboard', 'bancos', 'categorias', 'receitas', 'despesas', 'transferencias', 'devedores', 'cartoes', 'metas', 'orcamentos', 'assinaturas', 'relatorios', 'configuracoes', 'manutencao-dados'];
const VIEWPORTS = [['celular', 390, 844], ['tablet', 768, 1024]];
// botões que abrem modais de formulário (criação/edição); cada um é aberto, medido e fechado — nunca confirmado
const FORM_OPENERS = /^(nov[oa]\b|editar )/i;

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  log('seed: massa de testes completa (services reais)');
  await page.evaluate(async () => {
    const { seedFullTestSuite } = await import('/js/services/seed.js');
    const { auth } = await import('/js/firebase/client.js');
    await seedFullTestSuite(auth.currentUser.uid, { volume: 1 });
  });

  let modalsChecked = 0;
  for (const [vpName, width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    for (const id of PAGES) {
      log(`${vpName} ${width}px — ${id}: sem estouro horizontal e modais de formulário com o botão principal visível`);
      await page.goto(`${app.base}/pages/${id}.html`);
      await page.waitForSelector('#page-content .panel', { timeout: 15000 });
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      assert.ok(over.scrollWidth <= over.clientWidth + 1, `${id} @${width}px estoura a largura: ${over.scrollWidth} > ${over.clientWidth}`);

      const labels = await page.evaluate((src) => {
        const re = new RegExp(src, 'i'); const seen = new Set(); const out = [];
        for (const b of document.querySelectorAll('#page-content button')) {
          const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
          const key = label.split(' ').slice(0, 2).join(' ');
          if (!label || !re.test(label) || seen.has(key) || b.disabled || b.getBoundingClientRect().width === 0) continue;
          seen.add(key); out.push(label);
        }
        return out.slice(0, 4);
      }, FORM_OPENERS.source);
      for (const label of labels) {
        await page.getByRole('button', { name: label, exact: true }).first().scrollIntoViewIfNeeded();
        await page.getByRole('button', { name: label, exact: true }).first().click();
        await page.waitForSelector('.modal__dialog', { timeout: 5000 });
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
          const d = document.querySelector('.modal__dialog'); const r = d.getBoundingClientRect();
          const primary = d.querySelector('.modal__footer .btn--primary, button[type=submit]'); const pr = primary?.getBoundingClientRect();
          return {
            role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), focusInside: d.contains(document.activeElement),
            insideX: r.left >= 0 && r.right <= innerWidth + 1, insideY: r.top >= 0 && r.bottom <= innerHeight + 1,
            primaryVisible: pr ? pr.top >= 0 && pr.bottom <= innerHeight + 1 : null, hasPrimary: Boolean(primary),
          };
        });
        const where = `${id} @${width}px — "${label}"`;
        assert.deepEqual([m.role, m.modal], ['dialog', 'true'], `${where}: role/aria-modal`);
        assert.ok(m.focusInside, `${where}: o foco deve ir para dentro do modal`);
        assert.ok(m.insideX && m.insideY, `${where}: o modal sai da tela`);
        if (m.hasPrimary) assert.ok(m.primaryVisible, `${where}: o botão principal fica fora da tela (precisa rolar)`);
        // Prisão de foco: muitas teclas Tab/Shift+Tab nunca levam o foco para fora do diálogo
        for (let i = 0; i < 40; i += 1) {
          await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
          assert.ok(await page.evaluate(() => document.querySelector('.modal__dialog')?.contains(document.activeElement)), `${where}: o foco saiu do modal (Tab nº ${i + 1})`);
        }
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden', `${where}: o fundo deveria estar sem rolagem`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('.modal__dialog', { state: 'detached', timeout: 3000 });
        // ao fechar, o foco volta para o botão que abriu o modal
        assert.equal(await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim()), label, `${where}: o foco deveria voltar ao botão que abriu`);
        modalsChecked += 1;
      }
    }
  }
  assert.ok(modalsChecked >= 20, `poucos modais verificados: ${modalsChecked}`);
  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info(`E2E responsividade OK (${modalsChecked} modais verificados)`);
} catch (error) {
  console.error(`E2E responsividade FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-responsive-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
