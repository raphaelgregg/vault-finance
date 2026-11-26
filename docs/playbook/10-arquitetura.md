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

1. `pages/<x>.html` é uma casca: `<body data-page="<x>">`, `#sidebar`, `#topbar`, `#page-content` e os scripts (`importmap.js`, `app.js`).
2. `js/app.js` aplica o tema, conecta os emuladores (só em `localhost`), chama `requireSession()` (`js/core/guard.js`), monta sidebar, topbar e navegação móvel, e então importa **dinamicamente** o módulo da página pelo mapa `MODULES` (`js/app.js`).
3. O módulo exporta `render(container, { user })` e cuida de estado, renderização e eventos.
4. Nenhum módulo é importado antes da autenticação.

`vercel.json` serve as URLs limpas (`/despesas` → `/pages/despesas`). O teste `tests/services/routes.test.mjs` mantém menu, página, rewrite e módulo em sincronia.

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

- Importar algo do `server/` que carregue módulos só-ESM pode quebrar na Vercel (`ERR_REQUIRE_ESM`), mesmo funcionando local. Veja [Runbooks](doc:runbooks#atualizar-o-firebase-admin).
- `exists()` nas Rules **não enxerga** documentos do mesmo lote: parcelas de cartão e faturas novas vão em dois lotes (`js/services/creditCards.js`).
- `cleanUrls: true`: destino de `rewrite` nunca termina em `.html`.
- Não existe script de build: um arquivo novo entra em produção como está.
