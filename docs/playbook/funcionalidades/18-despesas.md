---
title: Despesas
category: Funcionalidades
tags: despesas, pagamento, estorno, saldo, parcelas, vencimento
summary: Cadastro de despesas pendentes e pagas, pagamento com checagem de saldo e estorno pelo servidor.
files: js/modules/despesas.js, js/services/expenses.js, server/finance/ops.mjs, js/components/reversal-modal.js
page: despesas
---

# Despesas

Rota `/despesas`. Coleção `users/{uid}/expenses`.

## Modelo

`description`, `categoryId`, `amountCents`, `accountId`, `purchaseDate`, `dueDate`, `paidDate`, `status` (`pending`, `paid`, `cancelled`), `recurrence`, `notes`, `installmentGroupId` (texto opcional para identificar parcelamentos manuais) e `operationId`. `recurrence` é informativo, como em [Receitas](doc:receitas).

## Ciclo de vida

Igual ao de receitas, com o sinal invertido:

| Passo | Quem faz | Detalhe |
|---|---|---|
| Criar | **Servidor** (`expense.create`) | Categoria `expense`/`both`; conta ativa. Se já nasce `paid`, **checa saldo suficiente** e debita atomicamente. |
| Editar / cancelar / excluir | Cliente | **Só despesa não paga.** Paga é imutável. |
| **Pagar** | **Servidor** (`expense.pay`) | Só de `pending`; recusa com `INSUFFICIENT_BALANCE` se o saldo da conta não cobre. |
| **Estornar** | **Servidor** (`reversal.create`, kind `expense`) | Lançamento compensatório com motivo. |

As compras no cartão **não são despesas**: a conta só é debitada quando a **fatura** é paga (`invoice.pay`), sem dupla contagem. Ver [Cartões](doc:cartoes).

## Tela

Mesmo padrão de Receitas: filtros, ordenação, paginação por cursor. `listExpenses` ordena por `dueDate` crescente (vencimentos mais próximos primeiro). O orçamento mensal por categoria (ver [Orçamentos](doc:orcamentos)) soma despesas **não canceladas** pelo mês de **vencimento**.

## Armadilhas

- Pagar com conta sem saldo falha de propósito; a mensagem traz valores reais (`details` em centavos).
- Despesa estornada volta a um estado que permite novo ciclo; o servidor controla pelos estornos em `reversals`.
