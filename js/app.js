/**
 * Entrada das páginas internas.
 * Fluxo: tema -> emuladores -> guarda de sessão -> shell -> módulo da página.
 * VF-PERF-01: o DOWNLOAD do módulo da página começa já, em paralelo à autenticação (só importa; `render` — que lê
 * dados — continua só depois da sessão); o tema salvo na conta NÃO bloqueia o menu; marcas de tempo `vf:*` na
 * linha do tempo do DevTools (Performance → Timings) permitem medir a abertura de cada página.
 * VF-PERF-02: depois da primeira página, os cliques nos links internos NÃO recarregam o documento: o anfitrião
 * (`components/page-host.js`) troca só o conteúdo; menu, autenticação e SDK continuam vivos. Carga direta, atualizar e
 * favoritos seguem funcionando (cada página continua sendo um HTML).
 */
import { applyStoredTheme, applyThemePreference, setThemePersister } from './components/theme.js';
import { getSettings, saveSettings } from './services/preferences.js';
import { connectEmulatorsOnce, configMissing } from './firebase/client.js';
import { requireSession } from './core/guard.js';
import { mountSidebar } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';
import { navItemById } from './utils/nav.js';
import { $, toast } from './components/dom.js';
import { startTableTools } from './components/table-tools.js';
import { mountBottomNav } from './components/bottom-nav.js';
import { startDateInputs } from './components/date-input.js';
import { registerPwa } from './pwa.js';
import { createPageHost } from './components/page-host.js';
import { closeModal } from './components/modal.js';
import { pageIdFromPath, pageUrl, internalTarget } from './utils/pageRoutes.js';
import { onSessionChange } from './services/auth.js';

registerPwa();

const MODULES = {
  dashboard: () => import('./modules/dashboard.js'),
  bancos: () => import('./modules/bancos.js'),
  receitas: () => import('./modules/receitas.js'),
  despesas: () => import('./modules/despesas.js'),
  transferencias: () => import('./modules/transferencias.js'),
  categorias: () => import('./modules/categorias.js'),
  orcamentos: () => import('./modules/orcamentos.js'),
  assinaturas: () => import('./modules/assinaturas.js'),
  devedores: () => import('./modules/devedores.js'),
  metas: () => import('./modules/metas.js'),
  cartoes: () => import('./modules/cartoes.js'),
  relatorios: () => import('./modules/relatorios.js'),
  configuracoes: () => import('./modules/configuracoes.js'),
  'manutencao-dados': () => import('./modules/manutencao-dados.js'),
  playbook: () => import('./modules/playbook.js'),
};

/** Marca de tempo (User Timing) — sem custo perceptível e sem rede; falha silenciosa em navegadores antigos. */
const mark = (name) => { try { performance.mark(name); } catch { /* sem User Timing */ } };

const PAGE_IDS = Object.keys(MODULES);

async function bootstrap() {
  mark('vf:boot');
  applyStoredTheme();
  if (configMissing) {
    toast('Configuração do Firebase ausente. Veja o README (js/firebase/config.js).', 6000);
  }
  connectEmulatorsOnce();

  const pageId = document.body.dataset.page || 'dashboard';
  // Download do módulo (e das dependências) em paralelo à autenticação; o erro real é tratado adiante.
  MODULES[pageId]?.().catch(() => {});
  const user = await requireSession();
  if (!user) return;
  mark('vf:session');

  // Tema: o cache local já foi aplicado; o valor salvo na conta (novo dispositivo) prevalece quando chegar — sem
  // bloquear o menu (medido: −35% até o menu aparecer).
  setThemePersister((theme) => saveSettings(user.uid, { theme }));
  getSettings(user.uid)
    .then((settings) => { if (settings?.theme) applyThemePreference(settings.theme); })
    .catch((error) => console.error('[app] falha ao carregar configurações', error));

  const navItem = navItemById(pageId);
  const sidebar = mountSidebar($('#sidebar'), { activeId: pageId });
  const topbar = mountTopbar($('#topbar'), {
    title: navItem?.label ?? 'Vault Finance',
    user,
    onMenuClick: () => sidebar.toggleMobile(),
  });

  const bottomNavRoot = document.createElement('nav');
  bottomNavRoot.className = 'bottom-nav';
  bottomNavRoot.setAttribute('aria-label', 'Atalhos');
  document.querySelector('.app').append(bottomNavRoot);
  const bottomNav = mountBottomNav(bottomNavRoot, { activeId: pageId, onMore: () => sidebar.toggleMobile() });

  mark('vf:shell');
  if (!MODULES[pageId]) {
    $('#page-content').textContent = 'Página não encontrada.';
    return;
  }

  const host = createPageHost({
    modules: MODULES,
    container: $('#page-content'),
    user,
    chrome: {
      setTitle: (title) => topbar.setTitle(title),
      setActive: (id) => { sidebar.setActive(id); bottomNav.setActive(id); },
      closeMobile: () => sidebar.closeMobile(),
    },
    titleOf: (id, module) => module.meta?.title ?? navItemById(id)?.label ?? 'Vault Finance',
    closeModal,
  });

  try {
    startDateInputs(); // campos de data em DD/MM/AAAA (máscara, calendário e ISO no envio)
    startTableTools(); // ordenação e filtro em todas as tabelas (páginas e modais)
    await host.show(pageId, { hash: location.hash });
    mark('vf:content');
  } catch (error) {
    console.error('[app] falha ao carregar módulo', error);
    $('#page-content').replaceChildren(
      Object.assign(document.createElement('p'), {
        textContent: 'Não foi possível carregar esta página. Recarregue ou verifique o console.',
      })
    );
    return; // sem anfitrião funcional, os links seguem como carga completa
  }

  // ---- navegação sem recarregar (VF-PERF-02) --------------------------------------------------------------------
  const go = async (target) => {
    const url = pageUrl(target.id, location.pathname) + (target.search ?? '');
    history.pushState({ vf: target.id }, '', url);
    try {
      await host.show(target.id, { hash: target.hash, focus: true });
    } catch (error) {
      console.error('[app] navegação interna falhou; recarregando a página', error);
      location.assign(url + (target.hash ?? '')); // rede de segurança: carga completa
    }
  };
  const linkOf = (event) => (event.target instanceof Element ? event.target.closest('a[href]') : null);
  const targetOf = (event, link) => internalTarget({
    click: event, link: { href: link.href, target: link.target, download: link.hasAttribute('download') }, origin: location.origin, ids: PAGE_IDS,
  });
  document.addEventListener('click', (event) => {
    const link = linkOf(event);
    const target = link && targetOf(event, link);
    if (!target) return;
    event.preventDefault();
    go(target);
  });
  // Aquecimento: ao passar o mouse, focar ou tocar num link de página, o módulo dela já começa a baixar.
  const warm = (event) => {
    const link = linkOf(event);
    if (!link) return;
    try {
      const url = new URL(link.href);
      if (url.origin === location.origin) { const id = pageIdFromPath(url.pathname, PAGE_IDS); if (id) host.prefetch(id); }
    } catch { /* href inválido */ }
  };
  for (const type of ['pointerover', 'focusin', 'touchstart']) document.addEventListener(type, warm, { passive: true });

  window.addEventListener('popstate', () => {
    const id = pageIdFromPath(location.pathname, PAGE_IDS);
    if (!id) { location.reload(); return; }
    if (id === host.currentId) return; // só o hash mudou dentro da página (ex.: playbook): a própria página trata
    host.show(id, { focus: true }).catch((error) => {
      console.error('[app] voltar/avançar falhou; recarregando a página', error);
      location.reload();
    });
  });

  // O documento agora vive por muito mais tempo: se a sessão terminar (ex.: sair em outra aba), volta ao login.
  onSessionChange((current) => { if (!current) window.location.replace('../index.html'); });
}

bootstrap();
