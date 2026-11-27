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

## Resumo do mês (VF-UX-01)

Painel `#month-summary` acima dos filtros, para o **mês selecionado** (sem filtro, o mês atual): **Previsto no mês** (= pago + a pagar), **Pago** e **A pagar** (com o valor em atraso). Cancelados ficam fora dos totais. Os totais vêm de `listExpensesOfMonth` (`js/services/expenses.js`), que lê **todo o mês** por intervalo de data (teto 1000; avisa se truncar) e **não depende da página carregada**. Ao escolher um mês no filtro, a tabela também passa a usar esses itens completos. O seletor de mês oferece os meses carregados, o atual e os 6 seguintes. Respeita o filtro de categoria; o de status não (o resumo já separa por status). Componente: `js/components/month-summary.js`.

## Tela

Mesmo padrão de Receitas: filtros, ordenação, paginação por cursor. `listExpenses` ordena por `dueDate` crescente (vencimentos mais próximos primeiro). O orçamento mensal por categoria (ver [Orçamentos](doc:orcamentos)) soma despesas **não canceladas** pelo mês de **vencimento**.

## Armadilhas

- Pagar com conta sem saldo falha de propósito; a mensagem traz valores reais (`details` em centavos).
- Despesa estornada volta a um estado que permite novo ciclo; o servidor controla pelos estornos em `reversals`.
