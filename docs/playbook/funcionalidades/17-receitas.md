---
title: Receitas
category: Funcionalidades
tags: receitas, recebimento, estorno, saldo, recorrência, paginação
summary: Cadastro de receitas previstas e recebidas, recebimento e estorno pelo servidor, filtros e paginação.
files: js/modules/receitas.js, js/services/incomes.js, js/components/reversal-modal.js, server/finance/ops.mjs, js/core/model/schemas.js
page: receitas
---

# Receitas

Rota `/receitas`. Coleção `users/{uid}/incomes`.

## Modelo

`description`, `categoryId`, `amountCents` (> 0), `expectedDate`, `receivedDate`, `accountId`, `status` (`pending`, `received`, `cancelled`), `recurrence` (`none`, `monthly`, `weekly`, `yearly`), `notes` e `operationId`. **`recurrence` é informativo**: não gera lançamentos automáticos; a previsão só soma os recorrentes.

## Ciclo de vida

```
criar (pending) ──► marcar como recebida (servidor) ──► estornar (servidor)
      │                                                       
      └──► cancelar / editar / excluir (cliente, só enquanto não recebida)
```

| Passo | Quem faz | Detalhe |
|---|---|---|
| Criar | **Servidor** (`income.create`) | Valida categoria (tipo) e conta (ativa) dentro da transação. Pedir `received` já liquida e entra no saldo atomicamente. O cliente valida o modelo antes (`createIncome`, `js/services/incomes.js:76`). |
| Editar | Cliente (Firestore) | **Só receita não recebida.** Se o formulário pede `received`, grava como prevista e chama o servidor para receber. |
| **Receber** | **Servidor** (`income.receive`) | Só de `pending`; atualiza status e `receivedDate` e incrementa `ledgerSeq`. |
| Cancelar | Cliente | Só `pending`. |
| Excluir | Cliente | Só não recebida e **não estornada** (Rules). |
| **Estornar** | **Servidor** (`reversal.create`, kind `income`) | Recebida é **imutável**; correção = estorno com motivo (3–300 caracteres). Modal em `js/components/reversal-modal.js`. |

As Rules **proíbem** o cliente de gravar `status: received` ou de editar uma receita já recebida. Idempotência: o formulário gera `operationId` ao abrir.

## Tela

Tabela com ordenação por coluna e filtro de texto (`table-tools`), barra de filtros (status, mês, categoria), badge com a contagem e **paginação por cursor** (`createPager`, `createPagerFooter`: "carregar mais"). `listIncomes` ordena por `expectedDate` decrescente.

## Armadilhas

- Receita recebida em conta **arquivada/inativa** é recusada.
- Mudou o formato de `received`/datas? Revise `settleDates` (`incomes.js:36`) e o servidor.
- O paralelo com [Despesas](doc:despesas) é proposital: não unifique sem ganho (decisão em `docs/ARCHITECTURE.md`).
