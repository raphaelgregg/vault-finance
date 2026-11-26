---
title: Bancos e contas
category: Funcionalidades
tags: contas, bancos, saldo, abertura, arquivar, excluir
summary: Cadastro de contas, saldo derivado sob demanda, ajuste do saldo de abertura, arquivamento e exclusão só sem histórico.
files: js/modules/bancos.js, js/services/accounts.js, js/services/balances.js, js/core/model/ledger.js, server/finance/ops.mjs
page: bancos
---

# Bancos e contas

Rota `/bancos`. Coleção `users/{uid}/accounts`.

## Campos e tipos

`institution`, `name` (opcional), `type` (`checking`, `salary`, `savings`, `digital`, `investment`, `benefit`, `other`), `initialBalanceCents`, `openingDate` (opcional), `color`, `status` (`active`, `inactive`, `archived`) e `ledgerSeq`. A lista exata aceita pelas Rules está em [Referência gerada](doc:referencia-gerada).

## Saldo

- **Saldo inicial** (de abertura) é sempre visível. O **saldo atual** é derivado (`accountBalances`) e calculado **sob demanda** por botão, para poupar a cota de leituras (`loadBalances`, `js/services/balances.js`).
- Se a leitura dos movimentos foi negada ou truncada, a tela mostra **"saldo indisponível"** em vez de um número errado (fail-closed).

## Ações

| Ação | Onde acontece | Observação |
|---|---|---|
| Criar / editar | Firestore direto (`createAccount`, `updateAccount`) | As Rules **impedem** o cliente de mudar `initialBalanceCents`, `openingDate` e `ledgerSeq` depois de criada. |
| **Ajustar saldo** | Servidor: `account.adjustOpening` | Informa o saldo real hoje; o servidor recalcula o **saldo de abertura** (`computeOpeningAdjustment`) sem alterar nenhuma receita, despesa ou transferência. Recusa se a leitura foi truncada e se a abertura ficaria negativa. Pode definir `openingDate`. |
| **Arquivar / reativar** | Servidor: `account.archive`, `account.unarchive` | Conta inativa/arquivada não recebe lançamentos (`ACCOUNT_NOT_ACTIVE`). |
| **Excluir** | Servidor: `account.delete` | **Só sem histórico**: qualquer referência em receitas, despesas, transferências, cartões, metas, recebimentos etc. bloqueia. O cliente também não pode apagar (Rules: só admin). |

`countAccountUsage` e `ACCOUNT_LINK_QUERIES` (`js/services/accounts.js`) montam a mensagem "conta em uso" com as contagens por tipo.

## Armadilhas

- Conta com `openingDate`: só movimentos **a partir** da data entram no saldo.
- Movimentos que apontam para conta inexistente ("órfãos") somem do saldo; `orphanMovements` avisa.
- Toda operação que altera saldo incrementa `ledgerSeq` da conta; não escreva esse campo pelo cliente.
