---
title: Devedores, dívidas e recebimentos
category: Funcionalidades
tags: devedores, dívidas, parcelas, recebimento, quitação, lote, estorno
summary: Quem deve ao usuário — dívidas à vista e parceladas, recebimentos parciais, quitação em lote, cancelamento, reagendamento e extrato do mês.
files: js/modules/devedores.js, js/modules/devedores-parcelas.js, js/services/debtors.js, js/services/debtPayments.js, js/core/model/debtors.js, server/finance/ops.mjs
page: devedores
---

# Devedores, dívidas e recebimentos

Rota `/devedores`. Quatro coleções trabalham juntas:

| Coleção | Papel | Escrita pelo cliente |
|---|---|---|
| `debtors` | Devedor: `name`, `loanDate`, `lentCents` (emprestado), `receivedCents`, `status` (`open`, `paid`, `cancelled`), `archived` | Cria/edita; **`receivedCents`, `status: paid` e `archived` só pelo servidor** |
| `debts` | **Parcelas** da dívida (`principalCents`, `dueDate`, `installmentNumber`/`installmentsTotal`, `debtGroupId`, `status`: `pending`, `paid`, `late`, `cancelled`) | Cria (sempre `pending`); **não atualiza** (pagar/cancelar é do servidor) |
| `debtPayments` | **Recebimentos** (imutáveis) | Negado; só o servidor |
| `cardPurchases` (com `debtorId`) | Compras no cartão vinculadas ao devedor, que também são "a receber" | Ver [Cartões](doc:cartoes) |

**Pendente = emprestado − recebido**, derivado e nunca gravado (`js/core/model/debtors.js`). "Atrasada" é **exibição derivada** (pendente com vencimento passado): o status gravado só muda por recebimento ou cancelamento.

## Criar dívida (`createDebtPlan`)

À vista (`installments` = 1) ou parcelada (N) em **um lote atômico** (`commitAtomic`): parcelas mensais no mesmo dia (com ajuste ao fim do mês), valores em centavos (a 1ª leva o resto da divisão), todas com o mesmo `debtGroupId`. O total soma ao `lentCents` do devedor e um devedor **quitado é reaberto** no mesmo lote. Não movimenta conta.

## Operações do servidor

| Operação | O que faz |
|---|---|
| `debt.receive` | Recebe **parte ou o total** de uma parcela (de `debts` ou de uma compra de cartão) em uma conta. Recusa excesso (`EXCEEDS_REMAINING`), devedor cancelado/arquivado e parcela já quitada. Aumenta o saldo da conta e o `receivedCents`. |
| `debt.settleBatch` | **Quitação em lote** retomável (por mês, por dívida ou todas), até 500 itens: uma transação **por parcela**, com documento de lote em `batches` e estado explícito; interrompido, retoma. |
| `debt.cancel`, `debt.cancelMany` | Cancela parcela(s) pendente(s) **sem recebimentos** e devolve o valor ao emprestado; `cancelMany` é **tudo ou nada** em uma transação. |
| `debt.reschedule` | Reagenda e/ou reajusta o valor de **uma** parcela sem recebimentos, ajustando `lentCents`. Usada pelas [Assinaturas](doc:assinaturas). |
| `debtor.archive`, `debtor.unarchive` | Arquivamento lógico (preserva histórico). |
| `debtor.delete` | Só **sem histórico** de dívidas/recebimentos. |
| `reversal.create` (kind `debtPayment`) | Estorna um recebimento. |

Idempotência por `operationId` em todas; o lote usa uma chave por item.

## Tela

`devedores.js` lista e edita devedores (com **fechamento do mês**: por devedor, as compras, parcelas e recebimentos do mês via `loadDebtorStatements`, em lotes de 30 devedores). `devedores-parcelas.js` é o modal de parcelas e recebimentos: registrar recebimento (parcial), quitar mês, cancelar várias, estornar.

## Armadilhas

- Cancelar para menos precisa devolver ao `lentCents`; o emprestado **nunca** pode ficar abaixo do já recebido.
- Recebimento em parcela de compra no cartão é independente do pagamento da fatura (fluxos separados).
- Conta de destino precisa estar ativa.
