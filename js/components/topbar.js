/** Barra superior: título, busca (placeholder sem ação), tema, perfil e logout. */
import { el, refreshIcons, toast } from './dom.js';
import { mountThemeToggle } from './theme.js';
import { signOut } from '../services/auth.js';

export function mountTopbar(root, { title, user, onMenuClick } = {}) {
  const menuButton = el('button', {
    type: 'button',
    class: 'btn btn--icon',
    'aria-label': 'Abrir menu',
  });
  menuButton.innerHTML = '<i data-lucide="menu" aria-hidden="true"></i>';
  menuButton.addEventListener('click', () => onMenuClick?.());

  const heading = el('h1', { class: 'topbar__title', text: title ?? 'Vault Finance' });

  const search = el('div', { class: 'topbar__search', role: 'search' }, [
    el('i', { 'data-lucide': 'search', 'aria-hidden': 'true' }),
    el('input', {
      type: 'search',
      placeholder: 'Pesquisar (em breve)',
      'aria-label': 'Pesquisa global, ainda não disponível',
      onInput: () => toast('A pesquisa global ainda não está disponível — nada foi consultado.'),
    }),
  ]);

  const logout = el('button', { type: 'button', class: 'btn btn--ghost', title: 'Sair', 'aria-label': 'Sair' });
  logout.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i><span>Sair</span>';
  logout.addEventListener('click', async () => {
    await signOut();
    window.location.replace('../index.html');
  });

  const userLabel = el('span', {
    class: 'badge',
    title: user?.email ?? 'Sessão ativa',
    text: user?.displayName || user?.email || 'Conta',
  });

  root.replaceChildren(menuButton, heading, search, el('div', { class: 'topbar__spacer' }), userLabel);
  mountThemeToggle(root);
  root.append(logout);
  refreshIcons();
}
