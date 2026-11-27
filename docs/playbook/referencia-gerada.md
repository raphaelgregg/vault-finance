---
title: Referência gerada do código
category: Referência
tags: referência, gerado, rotas, rules, operações, variáveis, scripts, csp
summary: Fatos extraídos automaticamente do código (rotas, coleções, operações do servidor, ambiente, scripts, testes, CSP, tarefas).
files: scripts/gen-playbook.mjs
---

# Referência gerada do código

> **Este arquivo é GERADO por `npm run docs:build` (`scripts/gen-playbook.mjs`). Não edite à mão:** a próxima geração sobrescreve. Ele reflete o estado atual do código e é atualizado automaticamente a cada push na `claude-dev` (ver [Atualização automática](doc:atualizacao-automatica)).

## Páginas e rotas

Cada página HTML, a rota limpa na Vercel (`vercel.json`), o módulo que a renderiza e os services que ele importa.

| Página | Menu | Rota | Módulo | Services |
| --- | --- | --- | --- | --- |
| `pages/assinaturas.html` | Assinaturas | `/assinaturas` | `js/modules/assinaturas.js` | `accounts`, `categories`, `creditCards`, `debtors`, `subscriptions` |
| `pages/bancos.html` | Bancos | `/bancos` | `js/modules/bancos.js` | `accounts`, `balances`, `financeApi` |
| `pages/cartoes.html` | Cartões | `/cartoes` | `js/modules/cartoes.js` | `accounts`, `categories`, `creditCards`, `debtors`, `financeApi` |
| `pages/categorias.html` | Categorias | `/categorias` | `js/modules/categorias.js` | `categories` |
| `pages/configuracoes.html` | Configurações | `/configuracoes` | `js/modules/configuracoes.js` | `auth`, `maintenance`, `preferences` |
| `pages/dashboard.html` | Dashboard | `/dashboard` | `js/modules/dashboard.js` | `dashboard` |
| `pages/despesas.html` | Despesas | `/despesas` | `js/modules/despesas.js` | `accounts`, `categories`, `expenses`, `financeApi`, `pager` |
| `pages/devedores.html` | Devedores | `/devedores` | `js/modules/devedores.js` | `debtors` |
| `pages/manutencao-dados.html` | (fora do menu) | `/manutencao-dados` | `js/modules/manutencao-dados.js` | `adminClaims`, `importer`, `maintenance`, `seed` |
| `pages/metas.html` | Metas | `/metas` | `js/modules/metas.js` | `accounts`, `balances`, `financeApi`, `goals` |
| `pages/orcamentos.html` | Orçamentos | `/orcamentos` | `js/modules/orcamentos.js` | `budgets`, `categories` |
| `pages/playbook.html` | (fora do menu) | `/playbook` | `js/modules/playbook.js` | `maintenance`, `playbook` |
| `pages/receitas.html` | Receitas | `/receitas` | `js/modules/receitas.js` | `accounts`, `categories`, `financeApi`, `incomes`, `pager` |
| `pages/relatorios.html` | Relatórios | `/relatorios` | `js/modules/relatorios.js` | `reports` |
| `pages/transferencias.html` | Transferências | `/transferencias` | `js/modules/transferencias.js` | `accounts`, `financeApi`, `goals`, `pager`, `reversals`, `transfers` |

## Funções de servidor (Vercel)

| Arquivo | maxDuration | includeFiles |
| --- | --- | --- |
| `api/admin-claims.mjs` | padrão | `—` |
| `api/docs.mjs` | 10 | `docs/playbook/index.json` |
| `api/finance.mjs` | 30 | `—` |
| `api/validation.mjs` | 60 | `—` |

## Coleções do Firestore e Rules

Extraído de `firestore.rules`. "negado" = o cliente não escreve (só o servidor, via Admin SDK). Campos = lista fechada aceita pelas Rules (sem `createdAt`/`updatedAt`).

| Coleção (`users/{uid}/…`) | Leitura | Criar/editar | Excluir | Campos |
| --- | --- | --- | --- | --- |
| `profile` | dono | dono | negado | `name` `email` `currency` `locale` |
| `settings` | dono | dono | negado | `theme` `hideValues` `firstWeekday` |
| `accounts` | dono+admin | dono | admin | `institution` `name` `type` `initialBalanceCents` `openingDate` `color` `status` `ledgerSeq` |
| `categories` | dono+admin | dono | dono+admin | `name` `kind` `color` |
| `incomes` | dono+admin | dono | dono+admin | `description` `categoryId` `amountCents` `expectedDate` `receivedDate` `accountId` `status` `recurrence` `notes` `operationId` |
| `expenses` | dono+admin | dono | dono+admin | `description` `categoryId` `amountCents` `accountId` `purchaseDate` `dueDate` `paidDate` `status` `recurrence` `notes` `installmentGroupId` `operationId` |
| `transfers` | dono+admin | dono | dono+admin | `fromAccountId` `toAccountId` `amountCents` `date` `reason` `notes` `status` `operationId` |
| `subscriptions` | dono+admin | dono | dono+admin | `name` `amountCents` `periodicity` `nextChargeDate` `chargeDay` `accountId` `cardId` `debtorId` `categoryId` `status` `notes` |
| `debtors` | dono+admin | dono | admin | `name` `loanDate` `lentCents` `receivedCents` `status` `notes` `archived` |
| `debts` | dono+admin | dono | admin | `debtorId` `description` `principalCents` `dueDate` `installmentNumber` `installmentsTotal` `debtGroupId` `status` |
| `debtPayments` | dono+admin | negado | admin | — |
| `goals` | dono+admin | dono | dono+admin | `name` `description` `targetCents` `deadline` `accountId` `status` |
| `goalTransactions` | dono+admin | negado | admin | — |
| `creditCards` | dono+admin | dono | dono+admin | `name` `brand` `limitCents` `closingDay` `dueDay` `accountId` `color` `status` |
| `cardPurchases` | dono+admin | dono | dono+admin | `cardId` `description` `amountCents` `purchaseDate` `installmentsTotal` `installmentNumber` `categoryId` `invoiceId` `debtorId` `notes` |
| `invoices` | dono+admin | dono | dono+admin | `cardId` `referenceMonth` `closingDate` `dueDate` `totalCents` `paidCents` `accountId` `paidAt` `status` |
| `budgets` | dono+admin | dono | dono+admin | `categoryId` `month` `limitCents` |
| `reversals` | dono+admin | negado | admin | — |
| `operations` | dono+admin | negado | admin | — |
| `batches` | dono+admin | negado | admin | — |
| `auditLog` | dono | dono | negado | `action` `entity` `entityId` `before` `after` `actorUid` |

## Operações do servidor (`POST /api/finance`)

Registradas com `defineOp` em `server/finance/ops.mjs`. "Login recente" = exige `auth_time` ≤ 5 min (VF-SEC-01).

| Operação | Login recente |
| --- | --- |
| `account.adjustOpening` | — |
| `account.archive` | — |
| `account.delete` | — |
| `account.unarchive` | — |
| `data.clearOwn` | sim |
| `debt.cancel` | — |
| `debt.cancelMany` | — |
| `debt.receive` | — |
| `debt.reschedule` | — |
| `debt.settleBatch` | — |
| `debtor.archive` | — |
| `debtor.delete` | — |
| `debtor.unarchive` | — |
| `expense.create` | — |
| `expense.pay` | — |
| `goal.deposit` | — |
| `goal.withdraw` | — |
| `income.create` | — |
| `income.receive` | — |
| `invoice.pay` | — |
| `reversal.create` | — |
| `transfer.confirm` | — |
| `transfer.create` | — |

## Variáveis de ambiente (servidor)

Lidas por `process.env`/`env` em `api/`, `server/` e `scripts/`. Valores NUNCA aparecem aqui.

| Variável | Usada em |
| --- | --- |
| `APPCHECK_ENFORCE` | `server/finance/core.mjs` |
| `FIREBASE_AUTH_EMULATOR_HOST` | `server/admin/claims.mjs` |
| `FIREBASE_PROJECT_ID` | `server/admin/claims.mjs`, `server/finance/core.mjs` |
| `FIREBASE_SERVICE_ACCOUNT` | `server/admin/claims.mjs`, `server/finance/core.mjs` |
| `FIRESTORE_EMULATOR_HOST` | `server/finance/core.mjs` |
| `GCLOUD_PROJECT` | `server/finance/core.mjs` |
| `PORT` | `scripts/dev-server.mjs` |
| `REQUIRE_VERIFIED_EMAIL` | `server/finance/core.mjs` |
| `VERCEL_ENV` | `server/env-guard.mjs` |

## Scripts npm

| Script | Comando |
| --- | --- |
| `npm run emulators` | `firebase emulators:start --only auth,firestore` |
| `npm run test` | `npm run test:unit && npm run test:rules` |
| `npm run test:unit` | `node --test tests/model/*.test.mjs tests/services/*.test.mjs` |
| `npm run test:rules` | `firebase emulators:exec --only firestore,auth --project demo-vault-finance "node --test tests/rules/*.test.…` |
| `npm run serve` | `npx http-server -p 5500 -c-1 .` |
| `npm run test:e2e` | `firebase emulators:exec --only firestore,auth --project demo-vault-finance "node tests/e2e/flows.mjs && nod…` |
| `npm run lint` | `node scripts/lint.mjs` |
| `npm run test:integration` | `firebase emulators:exec --only firestore,auth --project demo-vault-finance "node --test --test-concurrency=…` |
| `npm run serve:api` | `node scripts/dev-server.mjs` |
| `npm run docs:build` | `node scripts/gen-playbook.mjs` |
| `npm run manual:build` | `node scripts/gen-manual.mjs` |
| `npm run docs:check` | `node scripts/gen-playbook.mjs --check` |

## Dependências

| Pacote | Versão | Tipo |
| --- | --- | --- |
| `firebase-admin` | `^13.10.0` | produção |
| `@firebase/rules-unit-testing` | `^3.0.4` | desenvolvimento |
| `firebase` | `^10.12.2` | desenvolvimento |
| `firebase-tools` | `^13.23.1` | desenvolvimento |

Motor exigido: `node >=24`.

## Testes

| Pasta | Arquivos |
| --- | --- |
| `tests/model/` | 7 |
| `tests/services/` | 40 |
| `tests/rules/` | 1 |
| `tests/integration/` | 12 |
| `tests/e2e/` | 20 |

## Workflows do GitHub

| Arquivo | Nome | Gatilhos |
| --- | --- | --- |
| `ci.yml` | CI | push: branches: [claude-dev, main] pull_request: |
| `playbook.yml` | Playbook | push: branches: [claude-dev] |

## Content-Security-Policy (`vercel.json`)

| Diretiva | Valores |
| --- | --- |
| `default-src` | 'self' |
| `script-src` | 'self' 'sha256-…' https://www.gstatic.com https://apis.google.com https://www.google.com/recaptcha/ |
| `style-src` | 'self' 'unsafe-inline' |
| `img-src` | 'self' data: |
| `font-src` | 'self' |
| `connect-src` | 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseappcheck.googleapis.com |
| `frame-src` | https://vault-finance-d1603.firebaseapp.com https://www.google.com/recaptcha/ |
| `object-src` | 'none' |
| `base-uri` | 'self' |
| `form-action` | 'self' |
| `frame-ancestors` | 'none' |
| `upgrade-insecure-requests` |  |

## Tarefas do PLAN.md

83 concluídas, 0 abertas.

| ID | Estado | Título |
| --- | --- | --- |
| `VF-1-01` | concluída | Auditoria nunca persiste |
| `VF-1-02` | concluída | Exclusão de conta com vínculos |
| `VF-1-03` | concluída | Cabeçalhos de segurança (CSP/SRI) |
| `VF-SEC-01` | concluída | Revogação/desativação valem no servidor |
| `VF-SEC-02` | concluída | Recusar variáveis de emulador em produção |
| `VF-SEC-03` | concluída | Limitar abuso e custo |
| `VF-SEC-04` | concluída | Não servir arquivos internos |
| `VF-SEC-05` | concluída | Endurecer a CSP |
| `VF-SEC-06` | concluída | Política de senha e contas |
| `VF-SEC-07` | concluída | Auditoria não forjável |
| `VF-SEC-08` | concluída | CSV: neutralizar `-` inicial |
| `VF-SEC-09` | concluída | Dependências e CI |
| `VF-2-01` | concluída | Transições de status de transferência |
| `VF-2-02` | concluída | Persistir perfil/settings/tema |
| `VF-2-03a` | concluída | Assinaturas |
| `VF-2-03b` | concluída | Devedores |
| `VF-2-03b2` | concluída | Parcelas e recebimentos de devedores |
| `VF-2-03c` | concluída | Metas |
| `VF-2-03d` | concluída | Cartões/faturas |
| `VF-2-03e` | concluída | Orçamentos |
| `VF-2-03f` | concluída | Dashboard |
| `VF-2-03g` | concluída | Relatórios |
| `VF-2-03h` | concluída | Follow-ups de assinaturas |
| `VF-2-04` | concluída | Rota limpa `/categorias` |
| `VF-2-03i` | concluída | Erro de permissão em compra de cartão, dashboard resiliente e débitos de devedor por origem |
| `VF-2-03j` | concluída | Fechamento do mês por devedor e detalhamento das parcelas de cartão |
| `VF-2-03l` | concluída | Devedor sem empréstimo inicial e seletor de devedor na compra de cartão |
| `VF-2-03m` | concluída | Seletor de devedores na compra de cartão e dívidas (à vista/parceladas/cartão) por devedor |
| `VF-2-03n` | concluída | Antecipar/dar baixa em parcela e quitar dívida |
| `VF-2-03o` | concluída | Metas (permission-denied e conta vinculada), exclusão atômica de despesas/receitas e vínculo despesa×conta×cartão |
| `VF-2-03q` | concluída | Causa do `permission-denied` em Metas, `null` na tela, fatura paga com conta (VF-2-03p) e Dashboard consolidado |
| `VF-2-03r` | concluída | Assinaturas × Cartões/Faturas × Contas: sem dupla contagem, e fatura consolidada |
| `VF-2-03t` | concluída | Exclusão de cartão com faturas canceladas/zeradas e exclusão/ocultação de faturas |
| `VF-2-03u` | concluída | Painel de manutenção: limpeza, massa de testes e importação/exportação CSV |
| `VF-2-03v` | concluída | Usabilidade do CSV (modelo vazio × exportação) e exportação de todas as entidades |
| `VF-2-03w` | concluída | Separação de privilégios (usuário × administrador) e limpeza administrativa |
| `VF-2-03x` | concluída | Troca de senha do usuário autenticado (Configurações) |
| `VF-2-03y` | concluída | `404` em rotas limpas da Vercel (`/manutencao-dados`, `/metas`, …) e violações de CSP |
| `VF-2-03z` | concluída | Manutenção de dados aberta a qualquer usuário autenticado; escopos administrativos só com a claim `admin` |
| `VF-2-03aa` | concluída | Administrador promove/revoga outros administradores |
| `VF-2-03ab` | concluída | `401` em `/api/admin-claims` em produção e listagem de usuários/administradores |
| `VF-2-03ac` | concluída | CSV unificado (todas as entidades), escopo estrito ao uid e importação idempotente |
| `VF-2-03ad` | concluída | Receitas × Contas: `conta` e `instituicao` independentes no CSV |
| `VF-2-03ae` | concluída | Contas: `name` opcional (rótulo "Conta") e rótulo único de conta nos selects |
| `VF-2-03af` | concluída | Transferência exige saldo suficiente na origem |
| `VF-2-03ag` | concluída | Excluir transferência em qualquer status |
| `VF-2-03ah` | concluída | Transferências para/de metas (guardar e sacar) |
| `VF-2-03ai` | concluída | Saldo de abertura (+ data de abertura) e previsão financeira mensal |
| `VF-2-03aj` | concluída | Fuso America/Sao_Paulo como referência de "hoje" e assinaturas no cartão: comprometimento × caixa |
| `VF-2-03ak` | concluída | Quitar parcela individual e todas as parcelas de um mês (Devedores) |
| `VF-2-03al` | concluída | Recebimentos parciais × idempotência: ID exclusivo por recebimento, histórico imutável e total do devedor por increment |
| `VF-2-03am` | concluída | Devedor quitado: ações disponíveis e novas dívidas/compras (reabre) |
| `VF-2-03an` | concluída | Auditoria de variáveis e lógica: correções |
| `VF-2-03ao` | concluída | Auditoria de integridade financeira (recebimentos, concorrência, Rules, reconciliação) |
| `VF-ARQ-01` | concluída | Avaliação objetiva: operações financeiras críticas em backend confiável (Admin SDK) |
| `VF-COR-04` | concluída | Cancelar a dívida inteira de um devedor |
| `VF-COR-05` | concluída | Cancelar várias parcelas selecionadas em 1 requisição |
| `VF-COR-06` | concluída | Layout do modal de Dívidas do devedor |
| `VF-COR-07` | concluída | Assinatura: conta opcional e cobrança em cartão, conta ou devedor |
| `VF-COR-08` | concluída | Vínculo com devedor gera a cobrança da próxima fatura, sem duplicar |
| `VF-COR-09` | concluída | Recorrência mensal/anual perdia o dia 29–31 |
| `VF-COR-10` | concluída | A dívida do devedor acompanha a assinatura; cancelar devolve o emprestado |
| `VF-UX-01` | concluída | Ordenação e filtro em todas as tabelas |
| `VF-UX-02` | concluída | Layout, modais e responsividade (auditoria + correções) |
| `VF-QA-01` | concluída | Auditoria de qualidade e validação funcional geral |
| `VF-3-01` | concluída | Reduzir duplicação nos services |
| `VF-3-02` | concluída | Dividir módulos extensos |
| `VF-3-03` | concluída | Tratamento de datas |
| `VF-3-04` | concluída | Atualizar README e mensagens defasadas |
| `VF-3-05` | concluída | Reestruturação estrutural (zero regressão) |
| `VF-4-01` | concluída | Scripts de teste confiáveis |
| `VF-4-02` | concluída | CI |
| `VF-4-03` | concluída | Paginação e limites de leitura |
| `VF-4-04` | concluída | Testes de UI (Playwright) |
| `VF-4-05` | concluída | Lint/formatação |
| `VF-4-06` | concluída | Node LTS mais novo: CI em 24 e 26 |
| `VF-UX-03` | concluída | Dashboard claro e com período |
| `VF-PWA-01` | concluída | App instalável no smartphone (Chrome) |
| `VF-UX-04` | concluída | Revisão de design (frontend-design) |
| `VF-UX-06` | concluída | Auditoria de datas no formato brasileiro |
| `VF-UX-07` | concluída | Fatura do mês e seletor de mês em Cartões; "fatura a pagar" correta no Dashboard |
| `VF-COR-11` | concluída | Transferência estornada "presa" (confirmada com estorno já registrado) |
| `VF-UX-08` | concluída | Campos de data em DD/MM/AAAA independentes do navegador |
