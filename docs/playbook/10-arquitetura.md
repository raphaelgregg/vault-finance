---
title: Arquitetura
category: Começar aqui
tags: arquitetura, camadas, fluxo, firebase, vercel, pwa
summary: Camadas, regra de dependência, os dois caminhos de escrita (direto no Firestore × servidor), como uma página é montada e padrões de código.
files: docs/ARCHITECTURE.md, js/app.js, js/services/firestore.js, js/services/financeApi.js, server/finance/core.mjs
---

# Arquitetura

O detalhe completo das camadas está em `docs/ARCHITECTURE.md`. Aqui ficam o que é necessário para **dar manutenção**: os fluxos reais, os padrões e as armadilhas.

## Camadas e dependência

```
pages/*.html ──► js/app.js ──► js/modules/*  ──► js/services/* ──► js/firebase/*
                                   │                 │
                                   ▼                 ▼
                           js/components/*     js/core/* (puro)  ──►  js/utils/* (puro)
```

Uma camada só importa as da direita/abaixo. `core` e `utils` não conhecem DOM, rede nem Firebase. Os testes de `tests/model` e `tests/services` dependem disso para rodar em Node puro.

## Dois caminhos de escrita

Toda gravação segue **um** de dois caminhos. Saber qual é qual evita a maior parte dos bugs.

| | Caminho A — direto no Firestore | Caminho B — servidor (`/api/finance`) |
|---|---|---|
| Para quê | Cadastros e rascunhos: categorias, contas (dados), orçamentos, metas (dados), assinaturas, cartões, devedores (dados), itens **pendentes** | O que **altera saldo**: liquidar, pagar, receber, transferir, estornar, aportar, ajustar abertura, excluir/arquivar conta e devedor, limpar dados |
| Quem valida | Security Rules (`firestore.rules`) + validação do modelo no cliente | O servidor (Admin SDK), dentro de uma **transação** |
| Idempotência | Não | Sim, por `operationId` |
| Serviço | `js/services/<x>.js` → `js/services/firestore.js` | `js/services/<x>.js` → `js/services/financeApi.js` → `api/finance.mjs` → `server/finance/` |
| Auditoria | Cliente grava em `auditLog` (create-only) | Servidor grava em `auditLog` na mesma transação |

As Rules **recusam** no caminho A tudo que o caminho B faz: por exemplo, `status` `received`/`paid`/`confirmed` em receitas, despesas e transferências, e a criação de `debtPayments`, `goalTransactions`, `reversals`, `operations` e `batches`. Isso garante que o navegador nunca vire fonte de verdade do saldo.

## Como uma página é montada

1. `pages/<x>.html` é uma casca: `<body data-page="<x>">`, `#sidebar`, `#topbar`, `#page-content` e os scripts (`importmap.js`, `app.js`). Cada página continua sendo um HTML: carga direta, atualizar (F5) e favoritos funcionam.
2. `js/app.js` aplica o tema, conecta os emuladores (só em `localhost`) e **já começa a baixar o módulo da página em paralelo à autenticação** (VF-PERF-01: só o *download*; `render`, que lê dados, só roda depois da sessão). Em seguida `requireSession()` (`js/core/guard.js`), monta sidebar, topbar e barra inferior, e entrega a página ao **anfitrião** (`js/components/page-host.js`).
3. O módulo exporta `render(container, { user, signal })` e cuida de estado, renderização e eventos.
4. As configurações salvas na conta (tema) chegam depois, **sem bloquear** o menu.

`vercel.json` serve as URLs limpas (`/despesas` → `/pages/despesas`). O teste `tests/services/routes.test.mjs` mantém menu, página, rewrite e módulo em sincronia.

## Navegação sem recarregar (VF-PERF-02)

Depois da primeira página, **clicar num link do app não recarrega o documento**: HTML, SDK do Firebase, autenticação e menu continuam vivos e só o conteúdo muda.

- **Interceptação:** `app.js` ouve cliques em `a[href]`; `internalTarget` (`js/utils/pageRoutes.js`, puro) decide se é uma página do app (mesma origem, clique simples, sem `target`/`download`, sem Ctrl/Cmd/Shift/Alt). Qualquer outro caso segue o comportamento normal do navegador. O endereço muda por `history.pushState` (`/despesas` na Vercel, `/pages/despesas.html` no servidor local).
- **Anfitrião** (`createPageHost`): importa o módulo (em cache depois da primeira vez), **encerra a página anterior** (aborta o `signal`, chama `destroy()` se existir, fecha modal aberto), cria um **contêiner novo** (`div.page-root`, `display: contents` para não mudar o layout), atualiza `document.title`, título da topbar, item ativo do menu e `body[data-page]` (o CSS depende dele), e renderiza. Chamadas simultâneas: **vale a última**; a anterior é descartada sem tocar na tela.
- **Voltar/avançar:** `popstate` troca a página; se só o `hash` mudou dentro da mesma página (ex.: playbook), a própria página trata.
- **Rede de segurança:** se a navegação interna falhar (módulo ou `render` com erro), o app faz uma **carga completa** da URL. Sem anfitrião funcional, os links seguem como carga completa.
- **Aquecimento:** passar o mouse, focar ou tocar num link já começa a baixar o módulo dele.
- **Sessão:** como o documento vive mais tempo, um observador de sessão volta ao login se o usuário sair (inclusive em outra aba). O botão *Sair* e o observador usam `body[data-leaving]` para navegar uma única vez.
- **Acessibilidade:** ao navegar, o foco vai para `#page-content` e a rolagem volta ao topo; uma barra fina de progresso só aparece se a troca demorar mais de 150 ms.

### Contrato de uma página (obrigatório)

1. `export async function render(container, { user, signal })`: desenhe **só em `container`**, o elemento novo desta visita. **Nunca** procure o `<main>` global (`$('.content')`, `getElementById('page-content')`, `$('#page-content')`): uma página antiga que termine de carregar *depois* da navegação escreveria por cima da nova. Guarde o contêiner numa variável do módulo (`pageRoot`/`container`) e use-a nos redesenhos.
2. Listeners em `document`/`window` **sempre com `{ signal }`** (o anfitrião os remove ao sair). Timers e assinaturas: limpe em `export function destroy()`.
3. Estado de módulo (variáveis no topo do arquivo) **sobrevive** entre visitas (o módulo fica em cache): reinicialize o que não deve ser lembrado dentro de `render`. Filtros escolhidos continuam valendo na sessão.
4. Opcional: `export const meta = { title, icon }` (título da topbar e da aba).

Os testes `tests/services/page-routes.test.mjs` (regras acima) e `tests/e2e/navigation.mjs` (navegador real) protegem esse contrato.

### Medir a velocidade

O app grava marcas de tempo (User Timing): `vf:boot`, `vf:session`, `vf:shell`, `vf:content` na carga e `vf:nav` (medida) a cada troca interna. No Chrome: DevTools → *Performance* → gravar → *Timings*; ou, no console, `performance.getEntriesByName('vf:nav')`. Medições locais (rede simulada com 80 ms de latência) mostraram: o menu aparecer sem esperar a leitura de configurações poupa ~35% do tempo até o menu; `modulepreload` isolado rende ~5% (e exigiria um import map estático, porque o atual é injetado por script).

## Padrões que se repetem

- **Service com `io` injetável.** Funções recebem `io`/`deps` opcionais para trocar `create`, `update`, `writeAudit`, `fetch` etc. por falsos nos testes. Mantenha o padrão ao criar services.
- **`createAudited` / `updateAudited` / `removeAudited`** (`js/services/firestore.js`): operação + entrada de auditoria. A auditoria nunca lança: falha de auditoria não desfaz a operação.
- **`commitAtomic`** (`js/services/firestore.js:264`): lote atômico no cliente (operação + auditorias). **Não é transação**: não lê dentro do lote. Por isso o que depende de saldo vai ao servidor.
- **Dinheiro e datas:** `js/utils/money.js` converte "1.234,56" ↔ centavos; datas no modelo são texto ISO `AAAA-MM-DD` e viram `Timestamp` só em `toFirestoreData` (`js/services/firestore.js:36`). O servidor usa o mesmo formato (meio-dia UTC).
- **DOM sem `innerHTML` com dado de usuário.** Use `el()` (`js/components/dom.js`); a opção `html:` é só para ícones literais.
- **Tabelas:** `js/components/table-tools.js` dá ordenação por cabeçalho e filtro a toda `table.table`.
- **Paginação por cursor:** `js/services/pager.js`.

## Estado e dados derivados

Nada é gravado se pode ser calculado: saldo de conta, limite usado do cartão, total de fatura aberta, pendente do devedor, valor guardado de meta, gasto de orçamento, previsão do mês. Veja [Núcleo financeiro](doc:nucleo-financeiro).

## Limites de leitura (cota do Spark)

Os services de leitura têm tetos (`READ_LIMIT` = 1000 por coleção em `js/services/balances.js`; `REPORT_READ_LIMIT` = 2000 em `js/services/reports.js`; `HISTORY_LIMIT` = 5000 por consulta no servidor em `server/finance/core.mjs`). Se uma coleção bate no teto, o resultado vem com `truncated` e a interface avisa que pode estar incompleto. **Acima do teto no servidor a operação recusa** (nunca devolve saldo incompleto).

## PWA

`manifest.webmanifest` + `sw.js` (service worker mínimo, **sem cache**: dados financeiros nunca ficam defasados). Registrado em `js/pwa.js`.

## Armadilhas conhecidas

- **Datas só-dia e fuso do navegador:** nunca formate `"AAAA-MM-DD"` ou `"AAAA-MM"` com `new Date(...)`/`Intl`. O texto vira meia-noite **UTC** e, no Brasil (UTC−3), é exibido como o dia/mês **anterior** (`formatDateBR('2026-12-05')` → `04/12/2026`; `formatMonthBR('2026-12')` → "novembro"). Os testes rodam em UTC e **não pegam isso**. Formate por texto (`formatDate`/`formatMonth` de `js/components/form-kit.js`, `isoDateText`/`monthLabel` de `js/core/debtorReport.js`) e teste com `TZ=America/Sao_Paulo`. `formatDateBR`/`formatMonthBR` (`js/utils/dates.js`) têm esse problema com strings ISO; hoje nenhum módulo as usa.
- Importar algo do `server/` que carregue módulos só-ESM pode quebrar na Vercel (`ERR_REQUIRE_ESM`), mesmo funcionando local. Veja [Runbooks](doc:runbooks#atualizar-o-firebase-admin).
- `exists()` nas Rules **não enxerga** documentos do mesmo lote: parcelas de cartão e faturas novas vão em dois lotes (`js/services/creditCards.js`).
- `cleanUrls: true`: destino de `rewrite` nunca termina em `.html`.
- Não existe script de build: um arquivo novo entra em produção como está.
