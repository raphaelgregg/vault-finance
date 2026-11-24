# Arquitetura do Vault Finance

HTML/CSS/JS ES Modules puros (sem build) + Firebase Auth/Firestore no cliente; operações financeiras confiáveis
passam por funções de servidor (Vercel + Admin SDK). Este documento descreve **onde cada responsabilidade mora** e
**quais dependências são permitidas**. Regras permanentes do projeto: `CLAUDE.md`; estado operacional: `PLAN.md`.

## Camadas e regra de dependência

```
pages/*.html ──► js/app.js ──► js/modules/*  ──► js/services/* ──► js/firebase/*
                                   │                 │
                                   ▼                 ▼
                           js/components/*     js/core/* (puro)  ──►  js/utils/* (puro)
```

Uma camada só importa as da direita/abaixo. Nunca o contrário.

| Camada | Pasta | Responsabilidade | Pode importar |
|---|---|---|---|
| Páginas | `pages/`, `index.html` | Casca HTML; carrega `app.js`/`auth-page.js` | — |
| Módulos | `js/modules/` | Uma tela por arquivo: estado da tela, renderização, eventos | components, services, core, utils |
| Componentes | `js/components/` | Elementos visuais reutilizáveis (`dom.js`, `form-kit.js`, modal, tabela…). `table-tools.js` dá **ordenação por cabeçalho e filtro de texto a TODA `table.table`** (páginas e modais), automaticamente | core, utils |
| Services | `js/services/` | Casos de uso: CRUD, regras com dados, auditoria, chamadas `/api/*` | core, utils, firebase |
| Core | `js/core/` | Domínio **puro** (sem DOM/rede/Firebase): modelo, agregados, previsão, esquemas de importação | utils |
| Utils | `js/utils/` | Funções genéricas puras: `money`, `dates`, `csv`, `zip`, `constants`… | — |
| Firebase | `js/firebase/` | Config e inicialização do SDK (emuladores em dev) | — |
| Servidor | `api/` → `server/` | `api/*.mjs` só adaptam req/res; a lógica está em `server/finance`, `server/validation`, `server/admin` | core, utils e `firebase/config.js` (compartilhados com o cliente) |
| Testes | `tests/` | `model/`, `services/` (unit) · `rules/` · `integration/` (emulador) · `e2e/` (Playwright) | tudo |

Não há camada "repositories" separada: `js/services/firestore.js` já é o acesso genérico à persistência (CRUD,
lote atômico, auditoria) e cada service o usa. Criar outra camada só adicionaria indireção.

## Modelo financeiro (`js/core/model.js` → `js/core/model/`)

`model.js` é apenas um **barrel**: reexporta os submódulos e é o contrato público (`import … from '…/core/model.js'`).
`tests/model/model-structure.test.mjs` fixa a lista de nomes exportados.

| Arquivo | Conteúdo |
|---|---|
| `model/schemas.js` | `SCHEMAS`, `REF_FIELDS` — espelham `firestore.rules` (schemas fechados) |
| `model/validation.js` | `validateEntity`, `buildEntity`, compatibilidade categoria × movimentação |
| `model/ledger.js` | `accountLabel`, `filterMovements`, `accountBalances` (saldo **derivado**), `orphanMovements`, `sumAmounts` |
| `model/subscriptions.js` | valores anual/mensal, resumo, próxima cobrança |
| `model/debtors.js` | pendente, obrigações, extrato do mês, estado de parcelas, recebimentos |
| `model/goals.js` | progresso, aportes/resgates, metas vinculadas a conta |
| `model/cards.js` | datas de fatura, limite usado, `splitInstallments` |
| `utils/money.js` | `parseMoneyToCents`, `centsToMoneyString`, `formatCents` — **única** implementação de dinheiro |

Dependências internas (sem ciclos): `debtors → cards → validation → {schemas, money}`.

## Invariantes (não quebrar)

- Dinheiro em **centavos inteiros**; datas ISO `YYYY-MM-DD` no modelo (Timestamp só em `services/firestore.js`).
- **Saldo nunca é gravado**: sempre derivado das movimentações (`accountBalances`).
- Operações financeiras (receber/pagar, transferir, estornar, quitar parcela) são confirmadas no servidor
  (`/api/finance`): transação, concorrência e idempotência por `operationId`. O frontend nunca é fonte de verdade.
- `auditLog` é create-only; estornos (`reversals`) são lançamentos compensatórios, nunca edição do original.
- Qualquer mudança em `SCHEMAS` exige conferir `firestore.rules` e `tests/rules/`.

## Decisões e duplicações mantidas de propósito

- `services/incomes.js` × `services/expenses.js` e `modules/{receitas,despesas,transferencias}.js` são **paralelos, não
  idênticos** (status, campos de data e mensagens diferem; `incomes` ordena por `expectedDate desc`, `expenses` por
  `dueDate asc`). Unificá-los exigiria parametrizar regra de negócio sem ganho real; permanecem separados.
- `statCard`/`iconButton`/`showErrors` locais de `assinaturas.js` e `devedores.js` diferem de `components/form-kit.js`
  em marcação (`card__content`, sem `title`) e em comportamento (`_form` vira toast). Unificar mudaria aparência/UX;
  registrado em `PLAN.md` (VF-3-05) como decisão pendente.
- `js/core/*` e `js/services/*` com o mesmo nome (`forecast`, `integrity`) são pares intencionais: o de `core` é puro;
  o de `services` lê os dados e o chama.

## Onde achar uma funcionalidade

Tela → `pages/<x>.html` + `js/modules/<x>.js` · regra/cálculo → `js/core/model/*` ou `core/aggregates.js` ·
persistência → `js/services/<x>.js` · operação confiável → `server/finance/ops.mjs` · Rules → `firestore.rules`.
