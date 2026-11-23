/** Helpers mínimos de DOM e feedback visual (el, $, $$, toast, refreshIcons). Único lugar de js/ fora dos módulos que cria nós. */
export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // só com conteúdo próprio/confiável
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

let toastTimer = null;
export function toast(message, timeout = 3200) {
  const previous = document.querySelector('.toast');
  if (previous) previous.remove();
  const node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  node.textContent = message;
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), timeout);
}

/** Re-renderiza ícones Lucide quando presentes na página. */
export function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
