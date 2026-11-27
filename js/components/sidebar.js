/** Menu lateral recolhível com Lucide. Colapsa em desktop, gaveta no mobile. */
import { NAV_ITEMS } from '../utils/nav.js';
import { el, refreshIcons } from './dom.js';

const COLLAPSE_KEY = 'pf:sidebar-collapsed';

export function mountSidebar(root, { activeId } = {}) {
  const app = root.closest('.app') ?? document.body;
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* armazenamento indisponível */ }
  app.dataset.collapsed = String(collapsed);
  app.dataset.mobileOpen = 'false';

  const brand = el('a', { class: 'sidebar__brand', href: 'dashboard.html' }, [
    el('span', { class: 'sidebar__logo', 'aria-hidden': 'true', text: 'PF' }),
    el('span', { class: 'sidebar__name', text: 'Vault Finance' }),
  ]);

  const nav = el('nav', { class: 'sidebar__nav', 'aria-label': 'Menu principal' });
  const links = new Map();
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
    links.set(item.id, link);
    nav.append(link);
  }

  const collapseButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost sidebar__collapse',
    'aria-label': 'Recolher ou expandir o menu',
  });
  const renderCollapseButton = () => {
    const isCollapsed = app.dataset.collapsed === 'true';
    const icon = isCollapsed ? 'panel-left-open' : 'panel-left-close';
    const label = isCollapsed ? 'Expandir menu' : 'Recolher menu';
    collapseButton.title = label;
    collapseButton.setAttribute('aria-expanded', String(!isCollapsed));
    collapseButton.innerHTML =
      `<i data-lucide="${icon}" aria-hidden="true"></i><span class="sidebar__collapse-label">${label}</span>`;
    refreshIcons();
  };
  collapseButton.addEventListener('click', () => {
    // Até 1024px o menu é uma gaveta (o CSS ignora data-collapsed): o botão fecha a gaveta.
    if (window.matchMedia('(max-width: 1024px)').matches) {
      app.dataset.mobileOpen = 'false';
      return;
    }
    const next = app.dataset.collapsed !== 'true';
    app.dataset.collapsed = String(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* armazenamento indisponível */ }
    renderCollapseButton();
  });

  root.replaceChildren(brand, nav, el('div', { class: 'sidebar__footer' }, [collapseButton]));
  renderCollapseButton();

  return {
    /** Marca o item da página atual (navegação sem recarregar, VF-PERF-02); páginas fora do menu desmarcam todos. */
    setActive(id) {
      for (const [itemId, link] of links) {
        if (itemId === id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      }
    },
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
