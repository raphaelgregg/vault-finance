/**
 * Rotas das páginas internas para a navegação SEM recarregar (VF-PERF-02) — PURO (sem DOM, rede ou Firebase).
 *
 * As páginas continuam existindo como arquivos HTML (carga direta, atualizar, favoritos). Depois que uma delas
 * carrega, os cliques nos links internos são tratados no próprio documento (`js/app.js`): só o conteúdo muda.
 * Este módulo decide QUAL página um endereço representa, QUAIS cliques podem ser interceptados e QUAL endereço usar.
 */

/** "/despesas", "/despesas.html", "/pages/despesas", "/pages/despesas.html" → "despesas" (se for página conhecida). */
export function pageIdFromPath(pathname, ids) {
  const match = /^\/(?:pages\/)?([a-z][a-z0-9-]*?)(?:\.html)?\/?$/.exec(String(pathname ?? ''));
  const id = match?.[1];
  return id && ids.includes(id) ? id : null;
}

/**
 * Endereço de uma página, no mesmo estilo do atual: em `/pages/…` (servidor local) usa `/pages/<id>.html`; na Vercel
 * (URLs limpas) usa `/<id>`. Mantém consistência com o que o usuário veria ao recarregar.
 */
export function pageUrl(id, currentPathname = '/') {
  return String(currentPathname).startsWith('/pages/') ? `/pages/${id}.html` : `/${id}`;
}

/**
 * Decide se um clique em `<a>` vira navegação interna. `click`: { button, metaKey, ctrlKey, shiftKey, altKey,
 * defaultPrevented }; `link`: { href, target, download, origin } (href já resolvido); `origin`: origem atual.
 * Retorna { id, hash } ou null (deixa o navegador agir).
 */
export function internalTarget({ click, link, origin, ids }) {
  if (!click || click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (link.download || (link.target && link.target !== '_self')) return null;
  let url;
  try { url = new URL(link.href); } catch { return null; }
  if (url.origin !== origin) return null;
  const id = pageIdFromPath(url.pathname, ids);
  return id ? { id, hash: url.hash, search: url.search } : null;
}
