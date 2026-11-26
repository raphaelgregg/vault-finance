---
title: Transferências
category: Funcionalidades
tags: transferências, contas, metas, saldo, estorno
summary: Transferência entre contas e entre conta e meta (aporte/resgate), confirmação com checagem de saldo e estorno.
files: js/modules/transferencias.js, js/services/transfers.js, js/services/goals.js, server/finance/ops.mjs
page: transferencias
---

# Transferências

Rota `/transferencias`. Coleção `users/{uid}/transfers`.

## Modelo

`fromAccountId`, `toAccountId` (diferentes), `amountCents`, `date`, `reason`, `notes`, `status` (`pending`, `confirmed`, `cancelled`) e `operationId`.

## Transições

`TRANSFER_TRANSITIONS` (`js/services/transfers.js:90`) e `canTransitionTransfer` definem o que é permitido: só `pending` pode ser confirmada ou cancelada. Confirmada é imutável (estorne).

| Passo | Quem faz | Detalhe |
|---|---|---|
| Criar | **Servidor** (`transfer.create`) | `pending` ou `confirmed`. Confirmada na criação checa saldo da origem e incrementa `ledgerSeq` das **duas** contas. |
| **Confirmar** | **Servidor** (`transfer.confirm`) | Só de `pending`; checa saldo suficiente; **não** confirma transferência já estornada. |
| Cancelar / editar / excluir | Cliente | Só `pending` (as Rules proíbem alterar confirmada). |
| **Estornar** | **Servidor** (`reversal.create`, kind `transfer`) | Compensa nas duas contas. |

## Transferência com meta

A mesma tela aceita **metas** nos selects ("Meta: nome (guardado …)"): conta → meta é um **aporte** e meta → conta é um **resgate**, feitos pelo servidor (`goal.deposit`, `goal.withdraw`). Metas **vinculadas a uma conta** seguem o saldo dessa conta e não aceitam aporte/resgate. Ver [Metas](doc:metas).

## Armadilhas

- Duas transferências simultâneas de R$ 80 com saldo de R$ 100: só **uma** passa (serialização pelo `ledgerSeq`; teste em `tests/integration/server-transfers.test.mjs`).
- Falha entre débito e crédito desfaz tudo (mesma transação).
- Leitura negada de `reversals` (Rules antigas) coloca a tela de metas em **modo limitado**: estornos desconhecidos.
