/** Barra inferior (celular/tablet): Início, Lançar (receita, despesa ou transferência), Cartões e Mais (abre o menu lateral). */
import { el, refreshIcons } from './dom.js';

const QUICK = [
  { href: 'despesas.html#novo', label: 'Nova despesa' },
  { href: 'receitas.html#novo', label: 'Nova receita' },
  { href: 'transferencias.html#novo', label: 'Nova transferência' },
];

export function mountBottomNav(root, { activeId, onMore } = {}) {
  const items = new Map();
  const item = (id, href, icon, label) => { const node = el('a', { class: 'bottom-nav__item', href, ...(activeId === id ? { 'aria-current': 'page' } : {}) }, [
    el('i', { 'data-lucide': icon, 'aria-hidden': 'true' }), el('span', { text: label }),
  ]); items.set(id, node); return node; };
  const menu = el('div', { class: 'quick-menu', id: 'quick-menu', hidden: true }, QUICK.map((q) => el('a', { href: q.href, text: q.label })));
  const launch = el('button', { type: 'button', class: 'bottom-nav__item bottom-nav__item--primary', 'aria-expanded': 'false', 'aria-controls': 'quick-menu' }, [
    el('span', { class: 'bottom-nav__plus', 'aria-hidden': 'true', text: '+' }), el('span', { text: 'Lançar' }),
  ]);
  const setOpen = (open) => { menu.hidden = !open; launch.setAttribute('aria-expanded', String(open)); };
  launch.addEventListener('click', () => setOpen(menu.hidden));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
  menu.addEventListener('click', () => setOpen(false));
  const more = el('button', { type: 'button', class: 'bottom-nav__item', onClick: () => { setOpen(false); onMore?.(); } }, [
    el('i', { 'data-lucide': 'menu', 'aria-hidden': 'true' }), el('span', { text: 'Mais' }),
  ]);
  root.replaceChildren(item('dashboard', 'dashboard.html', 'layout-dashboard', 'Início'), launch, item('cartoes', 'cartoes.html', 'credit-card', 'Cartões'), more);
  root.after(menu);
  refreshIcons();
  return {
    /** Marca o item da página atual (navegação sem recarregar, VF-PERF-02). */
    setActive(id) {
      for (const [itemId, node] of items) {
        if (itemId === id) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
      }
    },
  };
}
