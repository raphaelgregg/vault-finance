/** Modal acessível: ESC fecha, clique no fundo fecha, foco vai para o diálogo. */
import { el } from './dom.js';

let current = null;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal({ title, body, footer = [], onClose, size }) {
  closeModal();

  const dialog = el('div', {
    class: size === 'wide' ? 'modal__dialog modal__dialog--wide' : 'modal__dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    tabindex: '-1',
  }, [
    el('div', { class: 'modal__header' }, [
      el('h2', { text: title }),
      el('button', {
        type: 'button',
        class: 'btn btn--icon',
        'aria-label': 'Fechar',
        onClick: () => closeModal(),
        html: '<i data-lucide="x" aria-hidden="true"></i>',
      }),
    ]),
    el('div', { class: 'modal__body' }, [].concat(body)),
    footer.length ? el('div', { class: 'modal__footer' }, footer) : null,
  ]);

  const overlay = el('div', { class: 'modal' }, [
    el('div', { class: 'modal__backdrop', onClick: () => closeModal() }),
    dialog,
  ]);

  // Se o corpo é um formulário e o footer contém o botão de submit, o footer
  // precisa ficar DENTRO do form — botão submit fora do form não dispara submit.
  const bodyNodes = [].concat(body);
  const formNode = bodyNodes.find((n) => n && n.tagName === 'FORM');
  const footerHasSubmit = footer.some(
    (b) => b && typeof b.getAttribute === 'function' && b.getAttribute('type') === 'submit'
  );
  if (formNode && footerHasSubmit) {
    formNode.append(el('div', { class: 'modal__footer' }, footer));
  }

  // Quem tinha o foco ao abrir (o botão que abriu o modal) recebe o foco de volta ao fechar.
  const opener = document.activeElement;

  const onKeyDown = (event) => {
    if (event.key === 'Escape') { closeModal(); return; }
    if (event.key !== 'Tab') return;
    // Prisão de foco: Tab/Shift+Tab circulam DENTRO do diálogo (nunca vão para a página atrás).
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!items.length) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
  };

  document.addEventListener('keydown', onKeyDown);
  document.body.append(overlay);
  document.body.classList.add('modal-open'); // trava a rolagem do fundo
  dialog.focus();

  current = {
    overlay,
    onClose,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      document.body.classList.remove('modal-open');
      if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      onClose?.();
    },
  };

  if (window.lucide) window.lucide.createIcons();
  return current;
}

export function closeModal() {
  if (current) {
    current.destroy();
    current = null;
  }
}
