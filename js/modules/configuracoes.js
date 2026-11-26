/**
 * Configurações: perfil (profile/main) e tema (settings/main), persistidos por usuário.
 * O módulo só monta a UI; leitura/escrita/validação ficam em services/preferences.js.
 */
import { el, toast, refreshIcons } from '../components/dom.js';
import { applyThemePreference } from '../components/theme.js';
import { changePassword, sendResetToCurrentUser, sendVerificationToCurrentUser, refreshEmailVerified } from '../services/auth.js';
import { hasPasswordProvider, externalProviderLabels, MIN_PASSWORD_LENGTH } from '../utils/password.js';
import {
  getProfile,
  getSettings,
  saveProfile,
  saveSettings,
  defaultProfileName,
  PROFILE_NAME_MAX,
} from '../services/preferences.js';

export const meta = { title: 'Configurações', icon: 'settings' };

const THEME_OPTIONS = [
  { value: 'system', label: 'Seguir o sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
];

export async function render(container, { user }) {
  let profile = null;
  let settings = null;
  let loadError = false;
  try {
    [profile, settings] = await Promise.all([getProfile(user.uid), getSettings(user.uid)]);
  } catch (error) {
    console.error('[configuracoes] falha ao carregar preferências', error);
    loadError = true;
  }

  const nameInput = el('input', {
    type: 'text',
    id: 'profile-name',
    name: 'name',
    maxlength: PROFILE_NAME_MAX,
    autocomplete: 'name',
    value: profile?.name ?? defaultProfileName(user?.email),
  });
  const themeSelect = el(
    'select',
    { id: 'settings-theme', name: 'theme' },
    THEME_OPTIONS.map((o) =>
      el('option', { value: o.value, selected: (settings?.theme ?? 'system') === o.value }, o.label)
    )
  );
  const nameError = el('span', { class: 'form-error', 'data-for': 'name' });
  const themeError = el('span', { class: 'form-error', 'data-for': 'theme' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Salvar' });

  const form = el('form', { id: 'preferences-form', novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { for: 'profile-email', text: 'E-mail (login)' }),
      el('input', { type: 'email', id: 'profile-email', value: user?.email ?? '', disabled: true }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'profile-name', text: 'Nome *' }),
      nameInput,
      nameError,
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'settings-theme', text: 'Tema' }),
      themeSelect,
      el('span', { class: 'field__hint', text: 'Também alternável na barra superior; vale em todos os seus dispositivos.' }),
      themeError,
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field__hint', text: 'Moeda: R$ (BRL) · Idioma: pt-BR · valores armazenados em centavos.' }),
    ]),
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    nameError.textContent = '';
    themeError.textContent = '';
    submit.disabled = true;
    try {
      const profileResult = await saveProfile(user.uid, {
        name: nameInput.value,
        email: user?.email,
      });
      const settingsResult = await saveSettings(user.uid, { theme: themeSelect.value });
      if (!profileResult.ok || !settingsResult.ok) {
        nameError.textContent = profileResult.errors?.name ?? profileResult.errors?._form ?? '';
        themeError.textContent = settingsResult.errors?.theme ?? settingsResult.errors?._form ?? '';
        toast('Corrija os campos destacados.', 5000);
        return;
      }
      applyThemePreference(themeSelect.value);
      toast('Preferências salvas.');
    } catch (error) {
      console.error('[configuracoes] falha ao salvar', error);
      toast('Não foi possível salvar. Tente novamente.', 5000);
    } finally {
      submit.disabled = false;
    }
  });

  container.replaceChildren(
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'settings', 'aria-hidden': 'true' })]),
        el('div', {}, [
          el('h2', { text: 'Configurações' }),
          el('p', { class: 'card__hint', text: 'Perfil e preferências de exibição, salvos na sua conta.' }),
        ]),
      ]),
      loadError
        ? el('p', { class: 'form-error', role: 'alert', text: 'Não foi possível carregar suas preferências.' })
        : null,
      form,
    ]),
    buildPasswordPanel(user),
    hasPasswordProvider(user) ? buildEmailVerificationPanel(user) : null,
    // Atalho à manutenção de dados (qualquer usuário autenticado; ações do próprio uid).
    el('section', { class: 'panel' }, [el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: 'Ferramentas de dados: apagar meus dados, massa de testes e importação/exportação CSV.' }),
      el('a', { class: 'btn btn--secondary', href: 'manutencao-dados.html', id: 'link-manutencao', text: 'Abrir manutenção de dados' }),
    ])])
  );
  refreshIcons();
}

/**
 * Segurança — verificação de e-mail (VF-SEC-06): mostra o estado e permite reenviar o link; "Já verifiquei" recarrega
 * o usuário e renova o token (necessário se o servidor exigir `email_verified`).
 */
function buildEmailVerificationPanel(user) {
  const status = el('p', { class: user.emailVerified ? 'notice' : 'card__hint', id: 'email-verify-status', role: 'status',
    text: user.emailVerified ? `E-mail verificado: ${user.email}.` : `E-mail ainda não verificado: ${user.email}. Enviamos um link no cadastro; reenvie se não encontrar.` });
  const sendBtn = el('button', { type: 'button', class: 'btn btn--secondary', id: 'email-verify-send', text: 'Enviar e-mail de verificação' });
  const doneBtn = el('button', { type: 'button', class: 'btn btn--secondary', id: 'email-verify-done', text: 'Já verifiquei' });
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    try {
      const r = await sendVerificationToCurrentUser(user);
      toast(r.ok ? (r.already ? 'Seu e-mail já está verificado.' : `Link enviado para ${r.email}. Verifique a caixa de entrada e o spam.`) : r.errors._form, 6000);
    } finally {
      sendBtn.disabled = false;
    }
  });
  doneBtn.addEventListener('click', async () => {
    doneBtn.disabled = true;
    try {
      const r = await refreshEmailVerified(user);
      if (r.ok && r.verified) {
        status.className = 'notice';
        status.textContent = `E-mail verificado: ${user.email}.`;
        toast('E-mail verificado com sucesso.');
      } else {
        toast(r.ok ? 'Ainda não consta como verificado. Abra o link do e-mail e tente de novo.' : r.errors._form, 6000);
      }
    } finally {
      doneBtn.disabled = false;
    }
  });
  const actions = user.emailVerified ? [] : [sendBtn, doneBtn];
  return el('section', { class: 'panel', id: 'panel-email-verify' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'mail-check', 'aria-hidden': 'true' })]),
      el('div', {}, [el('h2', { text: 'Segurança — e-mail' })]),
    ]),
    el('div', { class: 'panel__body' }, [status, ...actions]),
  ]);
}

/**
 * Segurança — senha (VF-2-03x). Contas com provedor `password`: senha atual + nova + confirmação, com
 * reautenticação antes de `updatePassword`; alternativa por e-mail de redefinição. Contas só com provedor
 * externo (ex.: Google): aviso de que a senha é gerenciada pelo provedor.
 */
function buildPasswordPanel(user) {
  const header = el('div', { class: 'panel__header' }, [
    el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'key-round', 'aria-hidden': 'true' })]),
    el('div', {}, [el('h2', { text: 'Segurança — senha' })]),
  ]);

  if (!hasPasswordProvider(user)) {
    const providers = externalProviderLabels(user);
    return el('section', { class: 'panel', id: 'panel-password' }, [
      header,
      el('div', { class: 'panel__body' }, [
        el('p', { class: 'notice', id: 'password-external', role: 'status', text: `Sua conta entra por ${providers.length ? providers.join(', ') : 'um provedor externo'}: a senha é gerenciada por esse provedor e não pode ser alterada aqui.` }),
      ]),
    ]);
  }

  const input = (id, name, autocomplete, label) => ({
    id,
    node: el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      el('input', { type: 'password', id, name, autocomplete, required: true, maxlength: 128 }),
      el('span', { class: 'form-error', 'data-for': name, role: 'alert' }),
    ]),
  });
  const fields = [
    input('pw-current', 'currentPassword', 'current-password', 'Senha atual'),
    input('pw-new', 'newPassword', 'new-password', `Nova senha (mínimo ${MIN_PASSWORD_LENGTH} caracteres)`),
    input('pw-confirm', 'confirmPassword', 'new-password', 'Confirmar nova senha'),
  ];
  const formError = el('p', { class: 'form-error', id: 'pw-form-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', id: 'pw-submit', text: 'Alterar senha' });
  const form = el('form', { id: 'password-form', novalidate: true }, [...fields.map((f) => f.node), formError, submit]);

  const showErrors = (errors) => {
    for (const node of form.querySelectorAll('.form-error')) node.textContent = '';
    for (const [name, message] of Object.entries(errors)) {
      const target = name === '_form' ? formError : form.querySelector(`.form-error[data-for="${name}"]`);
      if (target) target.textContent = message;
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    showErrors({});
    try {
      const value = (name) => form.elements[name].value;
      const result = await changePassword(user, { current: value('currentPassword'), next: value('newPassword'), confirm: value('confirmPassword') });
      if (result.ok) {
        form.reset();
        toast('Senha alterada com sucesso.');
      } else {
        showErrors(result.errors);
      }
    } finally {
      submit.disabled = false;
    }
  });

  const resetBtn = el('button', { type: 'button', class: 'btn btn--secondary', id: 'pw-reset-email', text: 'Enviar e-mail de redefinição' });
  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    try {
      const r = await sendResetToCurrentUser(user);
      if (r.ok) toast(`E-mail de redefinição enviado para ${r.email}. Verifique a caixa de entrada e o spam.`, 6000);
      else toast(r.errors._form, 6000);
    } finally {
      resetBtn.disabled = false;
    }
  });

  return el('section', { class: 'panel', id: 'panel-password' }, [
    header,
    el('div', { class: 'panel__body' }, [
      form,
      el('p', { class: 'card__hint', text: 'Prefere redefinir por e-mail? Enviamos um link seguro para o e-mail da sua conta.' }),
      resetBtn,
    ]),
  ]);
}
