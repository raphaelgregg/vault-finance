/**
 * Entrada das páginas internas.
 * Fluxo: tema -> emuladores -> guarda de sessão -> shell -> módulo da página.
 * Nenhum módulo é importado antes da autenticação.
 */
import { applyStoredTheme, applyThemePreference, setThemePersister } from './components/theme.js';
import { getSettings, saveSettings } from './services/preferences.js';
import { connectEmulatorsOnce, configMissing } from './firebase/client.js';
import { requireSession } from './core/guard.js';
import { mountSidebar } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';
import { navItemById } from './utils/nav.js';
import { $, toast, refreshIcons } from './components/dom.js';
import { startTableTools } from './components/table-tools.js';
import { mountBottomNav } from './components/bottom-nav.js';
import { registerPwa } from './pwa.js';

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
};

async function bootstrap() {
  applyStoredTheme();
  if (configMissing) {
    toast('Configuração do Firebase ausente. Veja o README (js/firebase/config.js).', 6000);
  }
  connectEmulatorsOnce();

  const pageId = document.body.dataset.page || 'dashboard';
  const user = await requireSession();
  if (!user) return;

  // Tema: o cache local já foi aplicado; aqui prevalece o valor salvo na conta (novo dispositivo).
  setThemePersister((theme) => saveSettings(user.uid, { theme }));
  try {
    const settings = await getSettings(user.uid);
    if (settings?.theme) applyThemePreference(settings.theme);
  } catch (error) {
    console.error('[app] falha ao carregar configurações', error);
  }

  const navItem = navItemById(pageId);
  const sidebar = mountSidebar($('#sidebar'), { activeId: pageId });
  mountTopbar($('#topbar'), {
    title: navItem?.label ?? 'Vault Finance',
    user,
    onMenuClick: () => sidebar.toggleMobile(),
  });

  const bottomNav = document.createElement('nav');
  bottomNav.className = 'bottom-nav';
  bottomNav.setAttribute('aria-label', 'Atalhos');
  document.querySelector('.app').append(bottomNav);
  mountBottomNav(bottomNav, { activeId: pageId, onMore: () => sidebar.toggleMobile() });

  const loadModule = MODULES[pageId];
  if (!loadModule) {
    $('#page-content').textContent = 'Página não encontrada.';
    return;
  }

  try {
    const module = await loadModule();
    startTableTools(); // ordenação e filtro em todas as tabelas (páginas e modais)
    await module.render($('#page-content'), { user });
    refreshIcons();
    // "Lançar" na barra inferior abre a página já com o formulário de criação (#novo).
    if (location.hash === '#novo') {
      history.replaceState(null, '', location.pathname + location.search);
      $('#page-content .btn--primary')?.click();
    }
  } catch (error) {
    console.error('[app] falha ao carregar módulo', error);
    $('#page-content').replaceChildren(
      Object.assign(document.createElement('p'), {
        textContent: 'Não foi possível carregar esta página. Recarregue ou verifique o console.',
      })
    );
  }
}

bootstrap();
