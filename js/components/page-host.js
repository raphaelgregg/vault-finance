/**
 * Anfitrião das páginas — navegação SEM recarregar (VF-PERF-02).
 *
 * Depois do primeiro carregamento, trocar de página não refaz HTML, SDK do Firebase, autenticação nem menu: o anfitrião
 * importa o módulo da página (em cache depois da primeira vez), descarta a página anterior e renderiza a nova no
 * mesmo `<main>`. Contrato de uma página (`js/modules/<id>.js`):
 *   export async function render(container, { user, signal })   // `container` é UM elemento novo a cada visita
 *   export function destroy?()                                   // opcional: limpeza (timers, assinaturas)
 *   export const meta?                                           // { title, icon }
 * Regras para as páginas: desenhar SÓ em `container` (nunca no <main> global: uma página antiga que termine de carregar
 * depois da navegação escreveria na nova); listeners em `document`/`window` com `{ signal }` — o sinal é abortado ao sair.
 * Chamadas simultâneas: vale a mais recente (`ticket`); a anterior é descartada sem tocar na tela.
 */
import { refreshIcons } from './dom.js';

const mark = (name) => { try { performance.mark(name); } catch { /* sem User Timing */ } };
const measure = (name, from, to) => { try { performance.measure(name, from, to); } catch { /* marca ausente */ } };

/**
 * @param {{ modules: Record<string, () => Promise<object>>, container: HTMLElement, user: object,
 *   chrome?: { setTitle?: (t: string) => void, setActive?: (id: string) => void, closeMobile?: () => void },
 *   titleOf?: (id: string, module: object) => string, closeModal?: () => void }} options
 */
export function createPageHost({ modules, container, user, chrome = {}, titleOf = (id, module) => module?.meta?.title ?? id, closeModal = () => {} }) {
  let current = null; // { id, module, controller }
  let ticketCounter = 0;
  const prefetched = new Set();
  container.tabIndex = -1; // recebe o foco ao trocar de página (leitores de tela anunciam o novo conteúdo)

  const teardown = () => {
    if (!current) return;
    current.controller.abort();
    try { current.module.destroy?.(); } catch (error) { console.error('[page-host] falha ao encerrar a página', error); }
    current = null;
    closeModal(); // um modal aberto da página anterior não sobrevive à navegação
  };

  return {
    /** Id da página exibida (ou null antes da primeira). */
    get currentId() { return current?.id ?? null; },

    /** Começa a baixar o módulo de uma página (passar o mouse/tocar no link); idempotente e silencioso. */
    prefetch(id) {
      const load = modules[id];
      if (!load || prefetched.has(id)) return;
      prefetched.add(id);
      load().catch(() => prefetched.delete(id));
    },

    /**
     * Exibe a página `id`. `focus`: move o foco/rola ao topo (navegação do usuário, não na carga inicial).
     * Retorna 'rendered' ou 'superseded' (uma navegação mais nova assumiu). Erros são relançados.
     */
    async show(id, { hash = '', focus = false } = {}) {
      const load = modules[id];
      if (!load) throw new Error(`Página desconhecida: ${id}`);
      const ticket = ++ticketCounter;
      document.body.dataset.navigating = 'true';
      mark('vf:nav:start');
      try {
        const module = await load();
        if (ticket !== ticketCounter) return 'superseded';

        teardown();
        const root = document.createElement('div');
        root.className = 'page-root';
        container.replaceChildren(root);
        document.body.dataset.page = id; // o CSS depende de body[data-page="…"]
        const title = titleOf(id, module);
        document.title = `${title} — Vault Finance`;
        chrome.setTitle?.(title);
        chrome.setActive?.(id);
        chrome.closeMobile?.();

        const controller = new AbortController();
        current = { id, module, controller };
        await module.render(root, { user, signal: controller.signal });
        if (ticket !== ticketCounter) return 'superseded';

        refreshIcons();
        if (hash === '#novo') { // "Lançar" (barra inferior) abre a página já com o formulário de criação
          history.replaceState(null, '', location.pathname + location.search);
          root.querySelector('.btn--primary')?.click();
        }
        if (focus) {
          window.scrollTo(0, 0);
          container.scrollTop = 0;
          container.focus({ preventScroll: true });
        }
        mark('vf:nav:content');
        measure('vf:nav', 'vf:nav:start', 'vf:nav:content');
        return 'rendered';
      } finally {
        if (ticket === ticketCounter) delete document.body.dataset.navigating;
      }
    },
  };
}
