/** Modal acessível: ESC fecha, clique no fundo fecha, foco vai para o diálogo. */
import { el } from './dom.js';

let current = null;

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

  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeModal();
  };

  document.addEventListener('keydown', onKeyDown);
  document.body.append(overlay);
  dialog.focus();

  current = {
    overlay,
    onClose,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
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
