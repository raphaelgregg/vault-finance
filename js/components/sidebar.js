/** Menu lateral recolhível com Lucide. Colapsa em desktop, gaveta no mobile. */
import { NAV_ITEMS } from '../utils/nav.js';
import { el, refreshIcons } from './dom.js';

const COLLAPSE_KEY = 'pf:sidebar-collapsed';

export function mountSidebar(root, { activeId } = {}) {
  const app = root.closest('.app') ?? document.body;
  const collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  app.dataset.collapsed = String(collapsed);
  app.dataset.mobileOpen = 'false';

  const brand = el('a', { class: 'sidebar__brand', href: 'dashboard.html' }, [
    el('span', { class: 'sidebar__logo', 'aria-hidden': 'true', text: 'PF' }),
    el('span', { class: 'sidebar__name', text: 'Vault Finance' }),
  ]);

  const nav = el('nav', { class: 'sidebar__nav', 'aria-label': 'Menu principal' });
  for (const item of NAV_ITEMS) {
    const isActive = item.id === activeId;
    const link = el(
      'a',
      {
        class: 'nav-item',
        href: item.href,
        title: item.label,
        ...(isActive ? { 'aria-current': 'page' } : {}),
      },
      [
        el('i', { 'data-lucide': item.icon, 'aria-hidden': 'true' }),
        el('span', { text: item.label }),
      ]
    );
    nav.append(link);
  }

  const collapseButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost sidebar__collapse',
    'aria-label': 'Recolher ou expandir o menu',
  });
  collapseButton.innerHTML =
    '<i data-lucide="panel-left-close" aria-hidden="true"></i><span class="sidebar__collapse-label">Recolher menu</span>';
  collapseButton.addEventListener('click', () => {
    const next = app.dataset.collapsed !== 'true';
    app.dataset.collapsed = String(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    if (window.lucide) window.lucide.createIcons();
  });

  root.replaceChildren(brand, nav, el('div', { class: 'sidebar__footer' }, [collapseButton]));
  refreshIcons();

  return {
    closeMobile() {
      app.dataset.mobileOpen = 'false';
    },
    openMobile() {
      app.dataset.mobileOpen = 'true';
    },
    toggleMobile() {
      app.dataset.mobileOpen = app.dataset.mobileOpen === 'true' ? 'false' : 'true';
    },
  };
}
