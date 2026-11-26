/**
 * VF-2-03x — troca de senha: validação pura, provedores, reautenticação antes de updatePassword,
 * tradução de erros e e-mail de redefinição.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePasswordChange, hasPasswordProvider, externalProviderLabels, providerIds, MIN_PASSWORD_LENGTH } from '../../js/utils/password.js';
import { changePassword, sendResetToCurrentUser, sendVerificationToCurrentUser, refreshEmailVerified, authErrorMessage } from '../../js/services/auth.js';

const userWith = (...providers) => ({ email: 'a@b.com', providerData: providers.map((providerId) => ({ providerId })) });
const pwUser = () => userWith('password');
const fbError = (code) => Object.assign(new Error(code), { code });

describe('validatePasswordChange (puro)', () => {
  it('aceita senha atual + nova válida + confirmação igual', () => {
    assert.deepEqual(validatePasswordChange({ current: 'antiga1', next: 'novaSenha10', confirm: 'novaSenha10' }), { ok: true, errors: {} });
  });
  it('erros por campo: vazios, curta, igual à atual, confirmação divergente', () => {
    assert.deepEqual(Object.keys(validatePasswordChange({}).errors).sort(), ['confirmPassword', 'currentPassword', 'newPassword']);
    assert.match(validatePasswordChange({ current: 'x', next: '12345', confirm: '12345' }).errors.newPassword, new RegExp(String(MIN_PASSWORD_LENGTH)));
    assert.match(validatePasswordChange({ current: 'mesmaSenha123', next: 'mesmaSenha123', confirm: 'mesmaSenha123' }).errors.newPassword, /diferente/);
    assert.match(validatePasswordChange({ current: 'a', next: 'novaSenha10', confirm: 'outraSenha' }).errors.confirmPassword, /não confere/);
    assert.match(validatePasswordChange({ current: 'a', next: 'x'.repeat(129), confirm: 'x'.repeat(129) }).errors.newPassword, /no máximo/);
  });
  it('provedores: só `password` permite trocar; externos viram rótulo legível', () => {
    assert.equal(hasPasswordProvider(pwUser()), true);
    assert.equal(hasPasswordProvider(userWith('google.com')), false);
    assert.equal(hasPasswordProvider(userWith('google.com', 'password')), true); // conta vinculada: pode
    assert.equal(hasPasswordProvider(null), false);
    assert.deepEqual(providerIds({}), []);
    assert.deepEqual(externalProviderLabels(userWith('google.com', 'password', 'apple.com', 'x.y')), ['Google', 'Apple', 'x.y']);
  });
});

describe('changePassword (reautentica ANTES de atualizar)', () => {
  const makeIo = ({ reauth = async () => {}, update = async () => {} } = {}) => {
    const calls = [];
    return {
      calls,
      io: {
        credential: (email, pwd) => ({ email, pwd }),
        reauthenticate: async (u, c) => { calls.push(['reauth', c]); return reauth(u, c); },
        update: async (u, pwd) => { calls.push(['update', pwd]); return update(u, pwd); },
      },
    };
  };
  const input = { current: 'antiga1', next: 'novaSenha1', confirm: 'novaSenha1' };

  it('fluxo feliz: credencial do e-mail + senha atual, depois updatePassword, nessa ordem', async () => {
    const { io, calls } = makeIo();
    assert.deepEqual(await changePassword(pwUser(), input, io), { ok: true });
    assert.deepEqual(calls, [['reauth', { email: 'a@b.com', pwd: 'antiga1' }], ['update', 'novaSenha1']]);
  });
  it('validação local falha: nenhuma chamada ao Firebase', async () => {
    const { io, calls } = makeIo();
    const r = await changePassword(pwUser(), { ...input, confirm: 'diferente' }, io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.confirmPassword);
    assert.equal(calls.length, 0);
  });
  it('senha atual errada (invalid-credential/wrong-password) → erro no campo e NÃO atualiza', async () => {
    for (const code of ['auth/invalid-credential', 'auth/wrong-password']) {
      const { io, calls } = makeIo({ reauth: async () => { throw fbError(code); } });
      const r = await changePassword(pwUser(), input, io);
      assert.deepEqual(r, { ok: false, errors: { currentPassword: 'Senha atual incorreta.' } });
      assert.equal(calls.some(([k]) => k === 'update'), false);
    }
  });
  it('erros traduzidos: too-many-requests e rede na reautenticação; weak-password e requires-recent-login no update', async () => {
    const a = await changePassword(pwUser(), input, makeIo({ reauth: async () => { throw fbError('auth/too-many-requests'); } }).io);
    assert.match(a.errors._form, /Muitas tentativas/);
    const b = await changePassword(pwUser(), input, makeIo({ reauth: async () => { throw fbError('auth/network-request-failed'); } }).io);
    assert.match(b.errors._form, /conexão/);
    const c = await changePassword(pwUser(), input, makeIo({ update: async () => { throw fbError('auth/weak-password'); } }).io);
    assert.match(c.errors.newPassword, /10 caracteres/);
    const d = await changePassword(pwUser(), input, makeIo({ update: async () => { throw fbError('auth/requires-recent-login'); } }).io);
    assert.match(d.errors._form, /entre novamente/);
  });
  it('conta só com provedor externo ou sem e-mail: recusa sem tocar no Firebase', async () => {
    const { io, calls } = makeIo();
    const ext = await changePassword(userWith('google.com'), input, io);
    assert.equal(ext.ok, false);
    assert.match(ext.errors._form, /provedor externo/);
    assert.equal((await changePassword({ providerData: [{ providerId: 'password' }] }, input, io)).ok, false);
    assert.equal((await changePassword(null, input, io)).ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('e-mail de redefinição e mensagens', () => {
  it('envia para o e-mail do usuário autenticado; erro traduzido', async () => {
    const sent = [];
    assert.deepEqual(await sendResetToCurrentUser(pwUser(), { send: async (e) => { sent.push(e); } }), { ok: true, email: 'a@b.com' });
    assert.deepEqual(sent, ['a@b.com']);
    const r = await sendResetToCurrentUser(pwUser(), { send: async () => { throw fbError('auth/too-many-requests'); } });
    assert.match(r.errors._form, /Muitas tentativas/);
    assert.equal((await sendResetToCurrentUser({}, { send: async () => {} })).ok, false);
  });
  it('traduz os códigos pedidos', () => {
    const expected = {
      'auth/invalid-credential': /incorretos/, 'auth/wrong-password': /incorreta/, 'auth/weak-password': /10 caracteres/, 'auth/password-does-not-meet-requirements': /10 caracteres/,
      'auth/too-many-requests': /Muitas tentativas/, 'auth/requires-recent-login': /entre novamente/, 'auth/network-request-failed': /conexão/,
    };
    for (const [code, re] of Object.entries(expected)) assert.match(authErrorMessage({ code }), re, code);
    assert.equal(authErrorMessage({}), 'Falha de autenticação.');
  });
});

describe('verificação de e-mail (VF-SEC-06)', () => {
  it('reenvia o link; já verificado não reenvia; erro vira mensagem', async () => {
    let sent = 0;
    const ok = await sendVerificationToCurrentUser({ email: 'a@b.com', emailVerified: false }, { send: async () => { sent += 1; } });
    assert.deepEqual([ok.ok, ok.email, sent], [true, 'a@b.com', 1]);
    const already = await sendVerificationToCurrentUser({ email: 'a@b.com', emailVerified: true }, { send: async () => { sent += 1; } });
    assert.deepEqual([already.ok, already.already, sent], [true, true, 1]);
    const bad = await sendVerificationToCurrentUser({ email: 'a@b.com' }, { send: async () => { throw fbError('auth/too-many-requests'); } });
    assert.match(bad.errors._form, /Muitas tentativas/);
    assert.equal((await sendVerificationToCurrentUser({}, {})).ok, false);
  });
  it('"Já verifiquei": recarrega o usuário e renova o token; reflete emailVerified', async () => {
    const calls = [];
    const user = { emailVerified: false, reload: async () => { calls.push('reload'); user.emailVerified = true; }, getIdToken: async (force) => { calls.push(`token:${force}`); } };
    assert.deepEqual(await refreshEmailVerified(user), { ok: true, verified: true });
    assert.deepEqual(calls, ['reload', 'token:true']);
    assert.equal((await refreshEmailVerified({ reload: async () => { throw fbError('auth/network-request-failed'); } })).ok, false);
    assert.deepEqual(await refreshEmailVerified(null), { ok: false, verified: false });
  });
});
