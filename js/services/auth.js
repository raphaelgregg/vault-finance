/**
 * Serviço de autenticação: única porta de entrada para o Firebase Auth.
 * Nenhuma tela chama o SDK diretamente.
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth';
import { auth } from '../firebase/client.js';
import { validatePasswordChange, hasPasswordProvider } from '../utils/password.js';

/** Códigos do Firebase traduzidos para mensagens acionáveis em pt-BR. */
const AUTH_ERRORS = {
  'auth/invalid-email': 'E-mail inválido.',
  'auth/user-not-found': 'Não existe conta com este e-mail.',
  'auth/wrong-password': 'Senha incorreta.',
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
  'auth/weak-password': 'Senha fraca: use ao menos 10 caracteres.',
  'auth/password-does-not-meet-requirements': 'A senha não atende à política de segurança: use ao menos 10 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
  'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
  'auth/operation-not-allowed': 'Login por e-mail/senha não está habilitado no Firebase.',
  'auth/requires-recent-login': 'Por segurança, entre novamente na sua conta e repita a operação.',
  'auth/user-mismatch': 'As credenciais não pertencem a esta conta.',
  'auth/user-disabled': 'Esta conta foi desativada.',
  'auth/missing-password': 'Informe a senha.',
  'auth/missing-email': 'Informe o e-mail.',
};

export function authErrorMessage(error) {
  return AUTH_ERRORS[error?.code] ?? error?.message ?? 'Falha de autenticação.';
}

export async function signIn(email, password) {
  await setPersistence(auth, browserLocalPersistence);
  return signInWithEmailAndPassword(auth, String(email).trim(), password);
}

export async function register(email, password, displayName) {
  const credential = await createUserWithEmailAndPassword(auth, String(email).trim(), password);
  if (displayName) await updateProfile(credential.user, { displayName });
  // VF-SEC-06: e-mail de verificação (melhor esforço; falha de envio não impede o cadastro).
  try { await sendEmailVerification(credential.user); } catch (error) { console.warn('[auth] verificação de e-mail não enviada', error); }
  return credential;
}

export async function resetPassword(email) {
  return sendPasswordResetEmail(auth, String(email).trim());
}

export async function signOut() {
  return fbSignOut(auth);
}

/** Guarda de sessão: resolve com o usuário atual (ou null). */
export function currentUser() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

/** Assinatura contínua do estado de sessão. */
export function onSessionChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Troca a senha do usuário autenticado (VF-2-03x): valida → REAUTENTICA com a senha atual
 * (`reauthenticateWithCredential` + `EmailAuthProvider.credential`, evita `auth/requires-recent-login`) →
 * `updatePassword`. Só para contas com provedor `password`. Retorna { ok, errors } (erros por campo/`_form`);
 * nunca registra senhas. `io` (reauthenticate, update, credential) é injetável nos testes.
 */
export async function changePassword(user, { current, next, confirm } = {}, io = {}) {
  if (!user?.email) return { ok: false, errors: { _form: 'Usuário não autenticado.' } };
  if (!hasPasswordProvider(user)) {
    return { ok: false, errors: { _form: 'Esta conta entra por um provedor externo: a senha é gerenciada por ele.' } };
  }
  const check = validatePasswordChange({ current, next, confirm });
  if (!check.ok) return { ok: false, errors: check.errors };
  const reauthenticate = io.reauthenticate ?? reauthenticateWithCredential;
  const update = io.update ?? updatePassword;
  const credential = (io.credential ?? EmailAuthProvider.credential)(user.email, current);
  try {
    await reauthenticate(user, credential);
  } catch (error) {
    if (['auth/invalid-credential', 'auth/wrong-password', 'auth/missing-password'].includes(error?.code)) {
      return { ok: false, errors: { currentPassword: 'Senha atual incorreta.' } };
    }
    return { ok: false, errors: { _form: authErrorMessage(error) } };
  }
  try {
    await update(user, next);
  } catch (error) {
    if (['auth/weak-password', 'auth/password-does-not-meet-requirements'].includes(error?.code)) return { ok: false, errors: { newPassword: authErrorMessage(error) } };
    return { ok: false, errors: { _form: authErrorMessage(error) } };
  }
  return { ok: true };
}

/** Envia o e-mail de redefinição para o e-mail do usuário autenticado. Retorna { ok, email, errors }. */
export async function sendResetToCurrentUser(user, io = {}) {
  if (!user?.email) return { ok: false, errors: { _form: 'Usuário sem e-mail cadastrado.' } };
  try {
    await (io.send ?? resetPassword)(user.email);
    return { ok: true, email: user.email };
  } catch (error) {
    return { ok: false, errors: { _form: authErrorMessage(error) } };
  }
}
