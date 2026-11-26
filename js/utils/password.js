/**
 * Validação de troca de senha (VF-2-03x) — pura (sem DOM/rede). O mínimo é aplicado no app (VF-SEC-06); a verificação real da senha atual é feita pelo servidor (reautenticação).
 */
export const MIN_PASSWORD_LENGTH = 10; // VF-SEC-06: o Firebase aceita 6; a regra de 10 vale no app (política do servidor exige Identity Platform)
export const MAX_PASSWORD_LENGTH = 128;

/** Retorna { ok, errors: { currentPassword?, newPassword?, confirmPassword? } } com mensagens pt-BR. */
export function validatePasswordChange({ current, next, confirm } = {}) {
  const errors = {};
  if (!current) errors.currentPassword = 'Informe a senha atual.';
  if (!next) errors.newPassword = 'Informe a nova senha.';
  else if (next.length < MIN_PASSWORD_LENGTH) errors.newPassword = `A nova senha precisa ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  else if (next.length > MAX_PASSWORD_LENGTH) errors.newPassword = `A nova senha pode ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
  else if (current && next === current) errors.newPassword = 'A nova senha deve ser diferente da senha atual.';
  if (!confirm) errors.confirmPassword = 'Confirme a nova senha.';
  else if (next && confirm !== next) errors.confirmPassword = 'A confirmação não confere com a nova senha.';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Senha nova (cadastro): { ok, error }. Mínimo e máximo do app; recusa só espaços e senhas triviais repetidas. */
export function validateNewPassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `A senha precisa ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  if (value.length > MAX_PASSWORD_LENGTH) return { ok: false, error: `A senha pode ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.` };
  if (!value.trim() || /^(.)\1+$/.test(value)) return { ok: false, error: 'Escolha uma senha menos previsível.' };
  return { ok: true };
}

/** Provedores de login do usuário (`providerData[].providerId`). */
export const providerIds = (user) => (user?.providerData ?? []).map((p) => p?.providerId).filter(Boolean);

/** Só contas com provedor `password` podem trocar a senha por aqui. */
export const hasPasswordProvider = (user) => providerIds(user).includes('password');

const PROVIDER_LABELS = { 'google.com': 'Google', 'facebook.com': 'Facebook', 'github.com': 'GitHub', 'apple.com': 'Apple', 'twitter.com': 'Twitter/X', 'microsoft.com': 'Microsoft', phone: 'telefone' };

/** Nomes legíveis dos provedores externos (sem `password`). */
export const externalProviderLabels = (user) => providerIds(user).filter((id) => id !== 'password').map((id) => PROVIDER_LABELS[id] ?? id);
