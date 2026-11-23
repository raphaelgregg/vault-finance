/**
 * Rodapé de paginação (VF-4-03): aviso de truncamento + botão "Carregar mais antigas".
 * Devolve null quando não há mais páginas (o chamador filtra nulos).
 */
import { el } from './dom.js';

/**
 * @param {{ pager: { items: any[], hasMore: boolean }, noun: string, onLoadMore: () => Promise<void> }} opts
 */
export function createPagerFooter({ pager, noun, onLoadMore }) {
  if (!pager.hasMore) return null;
  const button = el('button', { type: 'button', class: 'btn btn--secondary', id: 'pager-more', text: 'Carregar mais antigas' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Carregando…';
    try {
      await onLoadMore();
    } catch (error) {
      console.error('[pager] falha ao carregar mais', error);
      button.disabled = false;
      button.textContent = 'Carregar mais antigas';
    }
  });
  return el('div', { class: 'notice', id: 'pager-footer', role: 'status' }, [
    el('p', {
      text: `Mostrando as ${pager.items.length} ${noun} mais recentes. Filtros, meses e totais consideram só o que está carregado.`,
    }),
    button,
  ]);
}
