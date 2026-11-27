---
title: Testes
category: Testes
tags: testes, rules, integração, e2e, emulador, lint, ci
summary: Pirâmide de testes, comandos, requisitos, o que cada suíte garante, como escrever testes novos e armadilhas.
files: package.json, scripts/lint.mjs, tests/model, tests/services, tests/rules/firestore.rules.test.mjs, tests/integration, tests/e2e/harness.mjs, .github/workflows/ci.yml
---

# Testes

## Pirâmide

| Suíte | Comando | Onde | Precisa de |
|---|---|---|---|
| **Lint** | `npm run lint` | `scripts/lint.mjs` | Node |
| **Unitários** (modelo + services + servidor sem banco + playbook) | `npm run test:unit` | `tests/model/`, `tests/services/` | Node 24+ |
| **Rules** (Security Rules no emulador) | `npm run test:rules` | `tests/rules/firestore.rules.test.mjs` | Node 24+ e **Java 11+** (emulador do Firestore) |
| **Integração** (servidor real + emulador, concorrência) | `npm run test:integration` | `tests/integration/` | Node, Java |
| **E2E** (navegador, Playwright, contra emuladores) | `npm run test:e2e` | `tests/e2e/` | Node, Java e `playwright` instalado no ambiente |

`npm test` roda unitários + Rules. Os números de arquivos por pasta estão em [Referência gerada](doc:referencia-gerada) (não fixe contagens de testes em documentos: mudam toda semana).

## Lint (`scripts/lint.mjs`)

Sem dependências. Verifica: sintaxe de todo `.js`/`.mjs` (`node --check`), sem tabs nem espaço no fim da linha, arquivo termina com uma quebra de linha, **proíbe `console.log`** (use `console.info/warn/error`), `debugger`, `eval(`, marcadores de merge e `.only(`, imports nomeados não usados, e JSON válido (`package.json`, `firebase.json`, `firestore.indexes.json`, `vercel.json`).

## Unitários

- Usam `node:test` e `node:assert/strict`. Rodam em Node puro: por isso `core` e `utils` não podem importar DOM nem Firebase.
- Services recebem `io`/`deps` injetáveis. Há um repositório em memória em `tests/services/helpers/memory-store.mjs`.
- O servidor sem banco é testado injetando `db`, `verifyIdToken`, `now`, `log` em `handleFinance` (`tests/services/server-core.test.mjs`, `security-hardening.test.mjs`).
- **Testes que protegem a consistência do projeto** (falham se você esquecer algo):
  - `routes.test.mjs`: menu ↔ página HTML ↔ rewrite ↔ módulo em `app.js`; sem script inline nas páginas.
  - `security-headers.test.mjs`: hash CSP do import map, SRI do `lucide` e dos módulos Firebase.
  - `model-structure.test.mjs`: lista de exports do barrel `js/core/model.js`.
  - `playbook.test.mjs`: o playbook gerado está em dia e toda página, coleção, operação e variável de ambiente está documentada.
  - `page-routes.test.mjs`: rotas da navegação sem recarregar e o contrato das páginas (nenhum módulo usa o `<main>` global; listeners globais só com `signal`).
  - `security-hardening.test.mjs`: o servidor carrega **sem** `require()` de módulo ESM (regressão do `ERR_REQUIRE_ESM`).

## Rules (`tests/rules/`)

Usam `@firebase/rules-unit-testing` e o emulador do Firestore (`firebase emulators:exec`). Cobrem: negação sem autenticação, isolamento entre usuários, valores monetários, schemas fechados, privilégios do administrador, `auditLog` imutável, perfil/configurações e cada coleção de domínio. **Toda mudança em `firestore.rules` precisa de um caso aqui.** Como o teste roda contra o arquivo do repositório, ele **não** prova o que está publicado no Firebase: após publicar, confirme no console.

## Integração (`tests/integration/`)

Servidor real (`handleFinance`, `handleValidation`) com o Admin SDK contra o **emulador**, clientes **simultâneos**, e um oráculo independente (`oracleBalance`) que recalcula saldos por fora. Cenários: duas transferências com saldo para uma, transferência × despesa, recebimentos parciais em paralelo, retry idempotente, estornos duplicados, falha entre débito e crédito (rollback), isolamento por usuário e autenticação com **token real** do Auth Emulator. Helpers em `tests/integration/helpers/` (`server.mjs`, `real-io.mjs`, `world.mjs`). Rodam com `--test-concurrency=1`: levam vários minutos (≈ 20 min de CPU acumulada). Rode em background e leia o final.

## E2E (`tests/e2e/`)

`harness.mjs` sobe um servidor estático + `/api/finance` (o mesmo handler da Vercel) e controla o Chromium via Playwright. O SDK do Firebase é servido do `node_modules/firebase` local (versão pode diferir da fixada no import map; a chave `integrity` é removida **só no harness**). Cenários: **resumo do mês** (`month-summary.mjs`: totais do mês selecionado em Receitas/Despesas e Dashboard), **navegação sem recarregar** (`navigation.mjs`: o documento não recarrega, voltar/avançar, cliques concorrentes, modal, `#novo`, playbook, sair), login/cadastro e troca de senha (`auth.mjs`), fluxos principais (`flows.mjs`), movimentos, devedores, manutenção, Central de validação, CSV, estornos e visibilidade, todas as páginas, tabelas, responsividade, confirmações, edição de compra no cartão e campos de data. **Não rodam no CI** (exigem navegador). Se `playwright` não existir, os scripts saem com aviso.

## Como escrever um teste novo

1. Lógica pura (`core`, `utils`): arquivo em `tests/model/` ou `tests/services/`, sem emulador.
2. Service: injete `io` com falsos; teste os caminhos de erro e a mensagem ao usuário.
3. Operação de servidor: caso rápido em `tests/services/` (recusas antes do banco) **e** um caso de integração se envolver saldo, transação ou concorrência.
4. Rules: caso em `tests/rules/` (permitido **e** negado).
5. Tela: cenário E2E só para fluxos de ponta a ponta; o restante cabe em unitários.

## Armadilhas

- O Node local pode ser mais novo que o da Vercel e **aceitar** coisas que lá quebram (ex.: `require()` de ESM). O teste `security-hardening.test.mjs` cobre esse caso; **valide mudanças de dependência do servidor em preview**.
- Emuladores e `firebase emulators:exec` falam IPv6 e podem avisar sobre `::1`; é inofensivo.
- A mensagem de erro de um E2E que falha costuma citar o texto esperado: se a copy mudou (ex.: "ao menos 10"), atualize o teste.
- O teste do playbook falha se um arquivo gerado estiver defasado: rode `npm run docs:build` e comite (ver [Atualização automática](doc:atualizacao-automatica)).
