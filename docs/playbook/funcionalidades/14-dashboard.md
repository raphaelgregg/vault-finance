---
title: Dashboard
category: Funcionalidades
tags: dashboard, saldo, previsão, vencimentos, orçamentos, leitura
summary: Visão geral somente leitura: saldo total, resultado do período, pontos de atenção, previsão do mês, vencimentos, orçamentos e devedores.
files: js/modules/dashboard.js, js/services/dashboard.js, js/services/forecast.js, js/core/aggregates.js, js/core/forecast.js, js/services/balances.js
page: dashboard
---

# Dashboard

Rota `/dashboard` (primeira do menu). **Somente leitura**: nada é gravado, tudo é derivado.

## O que mostra

- **Visão geral:** saldo total das contas e resultado do período (**realizado**: recebido − pago). Períodos: mês (padrão), semestre, ano e todo o período.
- **Entradas e saídas do período** (`#dashboard-overview`, VF-UX-01): tabela com três linhas — **Realizado** (recebido/pago, por `receivedDate`/`paidDate`), **Pendente** (a receber/a pagar, por `expectedDate`/`dueDate`) e **Total do período** (previsto = realizado + pendente) — e o resultado de cada uma. Um mês futuro, sem nada liquidado, mostra o pendente em vez de "zero" confuso. Cálculo: `periodOverview` (`js/core/aggregates.js`). Não inclui pagamentos de fatura de cartão nem recebimentos de devedores (aparecem em suas áreas).
- **A receber de devedores:** no período **mês**, o card do resumo mostra o que vence **naquele mês** (fechamento de `loadDebtorStatements`, o mesmo de "A receber em <mês>") e informa o total em aberto na legenda; em semestre/ano/todo o período mostra o total em aberto. A **Posição líquida** continua usando o total em aberto.
- **Pontos de atenção:** vencidos, orçamentos estourados, avisos de leitura truncada.
- **Previsão do mês** e o bloco **"Como o saldo projetado foi calculado"** (transparência da conta), mais **compromissos dos próximos meses**.
- **Próximos vencimentos**, **orçamentos** do mês, **devedores** (a receber) e cartões/faturas.

## Como carrega os dados

`loadDashboard(uid)` (`js/services/dashboard.js:58`):

- Lê contas e movimentos **realizados** (receitas `received`, despesas `paid`, transferências `confirmed`, recebimentos de devedores, aportes de metas e estornos), cada coleção com teto `READ_LIMIT` = 1000. Se alguma atinge o teto, `truncated` lista as coleções e a tela avisa que o **saldo pode estar incompleto**.
- Cada fonte é **isolada** (`DASHBOARD_SOURCES`): se uma falha, as demais continuam e `failed` informa quais (a tela degrada, não quebra).
- Vencimentos usam os índices (status, data) declarados em `firestore.indexes.json`.
- O custo por carga é de algumas dezenas de consultas e até ~5×1000 documentos: **cuidado com a cota diária do Spark** ao adicionar fontes.

A previsão vem de `js/services/forecast.js` → `monthlyForecast` em `js/core/forecast.js` (ver [Núcleo financeiro](doc:nucleo-financeiro)). Agregações do período em `js/core/aggregates.js` (convenção: "realizado" = receita `received` por `receivedDate`; despesa `paid` por `paidDate`).

## Armadilhas

- Sem dados, mostra zeros e estados vazios: **nada é demonstração**.
- Mudou uma fonte? Atualize `DASHBOARD_SOURCES` e o tratamento de `failed`.
- O saldo mostrado aqui precisa bater com **Bancos** e com o servidor (`tests/integration/modules-consistency.test.mjs` confere com um oráculo independente).
