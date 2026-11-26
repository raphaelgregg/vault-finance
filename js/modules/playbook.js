/**
 * Playbook de manutenção (VF-DOC-01) — página SÓ para administradores (`/playbook`, fora do menu).
 * Layout: busca + filtros + sumário à esquerda, documento à direita. Atalhos: `/` foca a busca, `Esc` limpa.
 * Navegação por hash (`#doc/<id>` ou `#doc/<id>/<seção>`), então cada seção tem link compartilhável.
 * Renderiza Markdown como tokens do parser puro (`js/utils/markdown.js`) com `textContent`: sem `innerHTML`.
 * Segurança real: `GET /api/docs` valida o administrador no servidor; esconder a página aqui é só interface.
 */
import { el, refreshIcons } from '../components/dom.js';
import { isAdminUser } from '../services/maintenance.js';
import { fetchPlaybook } from '../services/playbook.js';
import { parseMarkdown } from '../utils/markdown.js';
import { buildIndex, search, facets, queryTerms, highlight } from '../utils/playbookSearch.js';

// ---------------------------------------------------------------------------------------------------------------
// Markdown → DOM
// ---------------------------------------------------------------------------------------------------------------

function renderInline(tokens, nav) {
  return tokens.map((t) => {
    if (t.t === 'text') return document.createTextNode(t.v);
    if (t.t === 'code') return el('code', { text: t.v });
    if (t.t === 'strong') return el('strong', {}, renderInline(t.c, nav));
    if (t.t === 'em') return el('em', {}, renderInline(t.c, nav));
    if (t.t === 'link') {
      const children = renderInline(t.c, nav);
      if (t.href.startsWith('doc:')) {
        const [docId, sectionId] = t.href.slice(4).split('#');
        const link = el('a', { href: `#doc/${docId}${sectionId ? `/${sectionId}` : ''}`, class: 'pb-link' }, children);
        link.addEventListener('click', (event) => { event.preventDefault(); nav(docId, sectionId); });
        return link;
      }
      if (t.href.startsWith('#')) return el('a', { href: t.href, class: 'pb-link' }, children);
      return el('a', { href: t.href, class: 'pb-link', target: '_blank', rel: 'noopener noreferrer' }, children);
    }
    return document.createTextNode('');
  });
}

function renderList(list, nav) {
  return el(list.type, { class: 'pb-list' }, list.items.map((item) => el('li', {}, [
    ...renderInline(item.inline, nav),
    item.children ? renderList(item.children, nav) : null,
  ])));
}

function copyButton(text) {
  const button = el('button', { type: 'button', class: 'btn btn--ghost pb-copy', text: 'Copiar', 'aria-label': 'Copiar código' });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copiado';
    } catch {
      button.textContent = 'Falhou';
    }
    setTimeout(() => { button.textContent = 'Copiar'; }, 1500);
  });
  return button;
}

export function renderBlocks(blocks, nav) {
  return blocks.map((b) => {
    if (b.type === 'heading') return el(`h${Math.min(6, b.level + 1)}`, { id: `pb-${b.id}`, class: 'pb-h' }, renderInline(b.inline, nav));
    if (b.type === 'p') return el('p', {}, renderInline(b.inline, nav));
    if (b.type === 'ul' || b.type === 'ol') return renderList(b, nav);
    if (b.type === 'quote') return el('blockquote', { class: 'pb-quote' }, renderInline(b.inline, nav));
    if (b.type === 'hr') return el('hr');
    if (b.type === 'code') return el('div', { class: 'pb-code' }, [copyButton(b.text), el('pre', {}, [el('code', { text: b.text })])]);
    if (b.type === 'table') {
      return el('div', { class: 'pb-table-wrap' }, [el('table', { class: 'pb-table' }, [
        el('thead', {}, [el('tr', {}, b.head.map((cell) => el('th', {}, renderInline(cell, nav))))]),
        el('tbody', {}, b.rows.map((row) => el('tr', {}, row.map((cell) => el('td', {}, renderInline(cell, nav)))))),
      ])]);
    }
    return null;
  });
}

function highlighted(text, terms) {
  return highlight(text, terms).map((part) => (part.hit ? el('mark', { text: part.text }) : document.createTextNode(part.text)));
}

// ---------------------------------------------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------------------------------------------

export async function render(container, { user }) {
  container.replaceChildren(el('p', { class: 'card__hint', text: 'Carregando o playbook…' }));

  if (!(await isAdminUser(user))) {
    container.replaceChildren(el('p', { class: 'notice', id: 'playbook-denied', role: 'alert', text: 'O playbook é restrito a administradores.' }));
    return;
  }
  const loaded = await fetchPlaybook(user);
  if (!loaded.ok) {
    container.replaceChildren(el('p', { class: 'form-error', id: 'playbook-error', role: 'alert', text: loaded.error }));
    return;
  }

  const { playbook } = loaded;
  const index = buildIndex(playbook);
  const { categories, tags } = facets(playbook);
  const state = { query: '', category: '', tag: '' };

  const searchInput = el('input', { type: 'search', id: 'playbook-search', placeholder: 'Buscar no playbook ( / )', 'aria-label': 'Buscar no playbook', autocomplete: 'off', spellcheck: 'false' });
  const categorySelect = el('select', { id: 'playbook-category', 'aria-label': 'Filtrar por categoria' }, [
    el('option', { value: '', text: 'Todas as categorias' }),
    ...categories.map((c) => el('option', { value: c, text: c })),
  ]);
  const tagBox = el('div', { class: 'pb-tags', role: 'group', 'aria-label': 'Filtrar por tag' });
  const toc = el('nav', { class: 'pb-toc', 'aria-label': 'Sumário do playbook' });
  const results = el('div', { class: 'pb-results', id: 'playbook-results', hidden: true, role: 'region', 'aria-live': 'polite' });
  const article = el('article', { class: 'pb-article', id: 'playbook-article' });

  const goto = (docId, sectionId, { replace = false } = {}) => {
    const hash = `#doc/${docId}${sectionId ? `/${sectionId}` : ''}`;
    if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
    showDoc(docId, sectionId);
  };

  function showHome() {
    article.replaceChildren(
      el('h2', { text: 'Playbook de manutenção' }),
      el('p', { class: 'card__hint', text: `${playbook.docs.length} documentos · ${index.length} seções. Use a busca (atalho "/") ou escolha um tema abaixo.` }),
      ...categories.map((category) => el('section', { class: 'pb-home-group' }, [
        el('h3', { text: category }),
        el('div', { class: 'pb-cards' }, playbook.docs.filter((d) => d.category === category).map((doc) => {
          const card = el('button', { type: 'button', class: 'pb-card' }, [el('strong', { text: doc.title }), el('span', { text: doc.summary || `${doc.sections.length} seções` })]);
          card.addEventListener('click', () => goto(doc.id));
          return card;
        })),
      ])),
    );
    markActive('');
  }

  function showDoc(docId, sectionId) {
    const doc = playbook.docs.find((d) => d.id === docId);
    if (!doc) { showHome(); return; }
    results.hidden = true;
    article.hidden = false;
    const nav = (id, sec) => goto(id, sec);
    const outline = el('nav', { class: 'pb-outline', 'aria-label': 'Nesta página' }, doc.sections.filter((s) => s.id !== 'resumo').map((s) => {
      const link = el('a', { href: `#doc/${doc.id}/${s.id}`, class: `pb-outline__l${s.level}`, text: s.heading });
      link.addEventListener('click', (event) => { event.preventDefault(); goto(doc.id, s.id); });
      return link;
    }));
    article.replaceChildren(
      el('p', { class: 'pb-crumb', text: doc.category }),
      el('h2', { text: doc.title }),
      doc.tags.length ? el('p', { class: 'pb-doc-tags' }, doc.tags.map((t) => el('span', { class: 'badge', text: t }))) : null,
      doc.files.length ? el('p', { class: 'card__hint' }, [document.createTextNode('Arquivos: '), ...doc.files.flatMap((f, i) => [i ? document.createTextNode(' · ') : null, el('code', { text: f })])]) : null,
      outline,
      ...doc.sections.flatMap((s) => [
        s.id === 'resumo' ? null : el(s.level === 2 ? 'h3' : 'h4', { id: `pb-${s.id}`, class: 'pb-h', text: s.heading }),
        el('div', { class: 'pb-section' }, renderBlocks(parseMarkdown(s.md), nav)),
      ]),
    );
    markActive(doc.id);
    const target = sectionId ? article.querySelector(`#pb-${CSS.escape(sectionId)}`) : null;
    if (target) target.scrollIntoView({ block: 'start' }); else article.scrollIntoView({ block: 'start' });
  }

  function markActive(docId) {
    for (const link of toc.querySelectorAll('a[data-doc]')) link.classList.toggle('is-active', link.dataset.doc === docId);
  }

  function buildToc() {
    toc.replaceChildren(...categories.map((category) => el('div', { class: 'pb-toc__group' }, [
      el('h3', { text: category }),
      ...playbook.docs.filter((d) => d.category === category).map((doc) => {
        const link = el('a', { href: `#doc/${doc.id}`, 'data-doc': doc.id, text: doc.title });
        link.addEventListener('click', (event) => { event.preventDefault(); goto(doc.id); });
        return link;
      }),
    ])));
  }

  function buildTags() {
    tagBox.replaceChildren(...tags.slice(0, 24).map((tag) => {
      const chip = el('button', { type: 'button', class: `pb-chip${state.tag === tag ? ' is-on' : ''}`, 'aria-pressed': state.tag === tag ? 'true' : 'false', text: tag });
      chip.addEventListener('click', () => { state.tag = state.tag === tag ? '' : tag; buildTags(); runSearch(); });
      return chip;
    }));
  }

  function runSearch() {
    const terms = queryTerms(state.query);
    if (!terms.length && !state.tag && !state.category) { results.hidden = true; article.hidden = false; return; }
    // Sem texto mas com filtro: lista os documentos da categoria/tag.
    if (!terms.length) {
      const docs = playbook.docs.filter((d) => (!state.category || d.category === state.category) && (!state.tag || d.tags.map((t) => t.toLowerCase()).includes(state.tag.toLowerCase())));
      results.replaceChildren(
        el('p', { class: 'card__hint', text: `${docs.length} documento(s) no filtro.` }),
        ...docs.map((doc) => {
          const item = el('button', { type: 'button', class: 'pb-result' }, [el('strong', { text: doc.title }), el('span', { class: 'pb-result__meta', text: doc.category }), el('span', { text: doc.summary })]);
          item.addEventListener('click', () => goto(doc.id));
          return item;
        }),
      );
    } else {
      const found = search(index, state.query, { category: state.category, tag: state.tag });
      results.replaceChildren(
        el('p', { class: 'card__hint', id: 'playbook-count', text: found.length ? `${found.length} resultado(s) para "${state.query.trim()}".` : `Nada encontrado para "${state.query.trim()}". Tente menos termos ou remova filtros.` }),
        ...found.map((r) => {
          const item = el('button', { type: 'button', class: 'pb-result' }, [
            el('strong', {}, highlighted(r.heading === 'Resumo' ? r.docTitle : `${r.docTitle} › ${r.heading}`, terms)),
            el('span', { class: 'pb-result__meta', text: r.category }),
            el('span', {}, highlighted(r.snippet, terms)),
          ]);
          item.addEventListener('click', () => goto(r.docId, r.sectionId === 'resumo' ? undefined : r.sectionId));
          return item;
        }),
      );
    }
    results.hidden = false;
    article.hidden = true;
  }

  let timer = null;
  searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.query = searchInput.value; runSearch(); }, 120); });
  searchInput.addEventListener('keydown', (event) => { if (event.key === 'Escape') { searchInput.value = ''; state.query = ''; runSearch(); } });
  categorySelect.addEventListener('change', () => { state.category = categorySelect.value; runSearch(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); searchInput.focus(); }
  });
  window.addEventListener('popstate', () => route());

  function route() {
    const match = /^#doc\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/.exec(location.hash);
    if (match) showDoc(match[1], match[2]); else showHome();
  }

  buildToc();
  buildTags();
  container.replaceChildren(el('div', { class: 'pb' }, [
    el('aside', { class: 'pb-side' }, [el('div', { class: 'pb-search' }, [searchInput, categorySelect]), tagBox, toc]),
    el('div', { class: 'pb-main' }, [results, article]),
  ]));
  route();
  refreshIcons();
}
