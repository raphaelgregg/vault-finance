/**
 * Página de login: alterna formulários e chama apenas js/services/auth.js.
 * Não conhece Firestore.
 */
import { applyStoredTheme } from './components/theme.js';
import { configMissing } from './firebase/client.js';
import { connectEmulatorsOnce } from './firebase/client.js';
import { signIn, register, resetPassword, authErrorMessage } from './services/auth.js';
import { validateNewPassword } from './utils/password.js';
import { redirectIfAuthenticated } from './core/guard.js';
import { toast } from './components/dom.js';
import { registerPwa } from './pwa.js';

registerPwa();

applyStoredTheme();
connectEmulatorsOnce();

const forms = {
  login: document.getElementById('form-login'),
  register: document.getElementById('form-register'),
  reset: document.getElementById('form-reset'),
};
const tabs = {
  login: document.getElementById('tab-login'),
  register: document.getElementById('tab-register'),
  reset: document.getElementById('tab-reset'),
};

const warning = document.getElementById('config-warning');
if (configMissing) {
  warning.hidden = false;
  warning.textContent = 'Firebase não configurado — preencha js/firebase/config.js';
}

function show(mode) {
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== mode;
  for (const [key, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(key === mode));
}
for (const [mode, tab] of Object.entries(tabs)) {
  tab.addEventListener('click', () => show(mode));
}

function setError(id, message) {
  document.getElementById(id).textContent = message ?? '';
}
function setBusy(form, busy) {
  form.querySelector('button[type="submit"]').disabled = busy;
}

forms.login.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('login-error', '');
  const data = new FormData(forms.login);
  const email = String(data.get('email') ?? '').trim();
  const password = String(data.get('password') ?? '');
  if (!email || !password) return setError('login-error', 'Informe e-mail e senha.');
  setBusy(forms.login, true);
  try {
    await signIn(email, password);
    const next = new URLSearchParams(location.search).get('next');
    location.replace(next ? `pages/${next}` : 'pages/dashboard.html');
  } catch (error) {
    setError('login-error', authErrorMessage(error));
  } finally {
    setBusy(forms.login, false);
  }
});

forms.register.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('register-error', '');
  const data = new FormData(forms.register);
  const email = String(data.get('email') ?? '').trim();
  const password = String(data.get('password') ?? '');
  const name = String(data.get('name') ?? '').trim();
  if (!email || !password) return setError('register-error', 'Informe e-mail e senha.');
  const strength = validateNewPassword(password);
  if (!strength.ok) return setError('register-error', strength.error);
  setBusy(forms.register, true);
  try {
    await register(email, password, name);
    location.replace('pages/dashboard.html');
  } catch (error) {
    setError('register-error', authErrorMessage(error));
  } finally {
    setBusy(forms.register, false);
  }
});

forms.reset.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('reset-error', '');
  const email = String(new FormData(forms.reset).get('email') ?? '').trim();
  if (!email) return setError('reset-error', 'Informe o e-mail.');
  setBusy(forms.reset, true);
  try {
    await resetPassword(email);
    toast('Se o e-mail existir, o link de redefinição foi enviado.');
    show('login');
  } catch (error) {
    setError('reset-error', authErrorMessage(error));
  } finally {
    setBusy(forms.reset, false);
  }
});

const reason = new URLSearchParams(location.search).get('reason');
if (reason === 'auth') toast('Faça login para continuar.');
if (reason === 'config') toast('Configuração do Firebase ausente: veja o README.', 6000);

// Falha ao ler a sessão não pode virar erro não tratado: a página de login segue utilizável.
redirectIfAuthenticated().catch((error) => console.error('[auth] sessão indisponível', error));
