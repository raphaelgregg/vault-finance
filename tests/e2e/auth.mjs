/**
 * E2E da troca de senha (VF-2-03x) contra o emulador de Auth: validações, senha atual errada, reautenticação +
 * updatePassword, login só com a nova senha e e-mail de redefinição. Sem `playwright`, sai com aviso (código 0).
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
const err = (name) => page.locator(`#password-form .form-error[data-for="${name}"]`).innerText();
const fill = async (current, next, confirm) => {
  await page.fill('#pw-current', current);
  await page.fill('#pw-new', next);
  await page.fill('#pw-confirm', confirm);
  await page.click('#pw-submit');
};
const toastText = () => page.waitForFunction(() => document.querySelector('.toast')?.innerText ?? '', null, { timeout: 15000 }).then((h) => h.jsonValue());

try {
  const { email, password } = await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('configurações: conta com senha mostra o formulário (sem aviso de provedor externo)');
  await page.goto(`${app.base}/pages/configuracoes.html`);
  await page.waitForSelector('#password-form');
  assert.equal(await page.locator('#password-external').count(), 0);

  log('validações locais: vazio, nova curta, igual à atual e confirmação divergente');
  await fill('', '', '');
  assert.match(await err('currentPassword'), /Informe a senha atual/);
  assert.match(await err('newPassword'), /Informe a nova senha/);
  await fill(password, '12345', '12345');
  assert.match(await err('newPassword'), /ao menos 10/);
  await fill(password, password, password);
  assert.match(await err('newPassword'), /diferente da senha atual/);
  await fill(password, 'NovaSenha#2026', 'OutraSenha#2026');
  assert.match(await err('confirmPassword'), /não confere/);

  log('senha atual errada: erro no campo e a senha NÃO muda');
  await fill('senha-errada-xyz', 'NovaSenha#2026', 'NovaSenha#2026');
  await page.waitForFunction(() => /Senha atual incorreta/.test(document.querySelector('#password-form .form-error[data-for="currentPassword"]')?.innerText ?? ''));

  log('troca bem-sucedida: reautentica e atualiza; o formulário é limpo');
  await fill(password, 'NovaSenha#2026', 'NovaSenha#2026');
  await page.waitForFunction(() => /Senha alterada com sucesso/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.equal(await page.inputValue('#pw-current'), '');
  assert.equal(await page.inputValue('#pw-new'), '');

  log('login: a senha antiga deixa de funcionar e a nova entra');
  const tryLogin = (pwd) => page.evaluate(async ([mail, p]) => {
    const { signIn, signOut } = await import('/js/services/auth.js');
    await signOut();
    try { await signIn(mail, p); return 'ok'; } catch (e) { return e.code; }
  }, [email, pwd]);
  assert.match(await tryLogin(password), /auth\/(invalid-credential|wrong-password)/);
  assert.equal(await tryLogin('NovaSenha#2026'), 'ok');

  log('e-mail de redefinição: feedback de sucesso com o e-mail da conta');
  await page.goto(`${app.base}/pages/configuracoes.html`);
  await page.waitForSelector('#pw-reset-email');
  await page.click('#pw-reset-email');
  await page.waitForFunction((mail) => (document.querySelector('.toast')?.innerText ?? '').includes(`E-mail de redefinição enviado para ${mail}`), email);

  // 400 do Auth é ESPERADO: vêm das tentativas propositalmente erradas (senha atual errada e senha antiga).
  const unexpected = app.problems.filter((p) => !/status of 400 \(Bad Request\)/.test(p));
  assert.deepEqual(unexpected, [], `erros de console/página: ${unexpected.join(' | ')}`);
  assert.ok(app.problems.length <= 3, `mais 400 que o esperado: ${app.problems.length}`);
  console.info('E2E senha OK');
} catch (error) {
  console.error(`E2E senha FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-auth-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-auth-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
