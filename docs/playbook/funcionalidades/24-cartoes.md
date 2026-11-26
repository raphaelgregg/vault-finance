---
title: Cartões, compras e faturas
category: Funcionalidades
tags: cartões, faturas, compras, parcelas, limite, fechamento, pagamento
summary: Cartões de crédito, compras à vista e parceladas, ciclo da fatura (aberta → fechada → paga), limite derivado e pagamento pelo servidor.
files: js/modules/cartoes.js, js/services/creditCards.js, js/core/model/cards.js, server/finance/ops.mjs
page: cartoes
---

# Cartões, compras e faturas

Rota `/cartoes`. Três coleções: `creditCards` (`name`, `brand`, `limitCents`, `closingDay`, `dueDay`, `accountId`, `color`, `status`: `active`, `blocked`, `cancelled`), `cardPurchases` e `invoices`.

## Compras

- Compra **parcelada** = **N documentos** `cardPurchases` (1 a 48 parcelas): o valor é dividido em centavos inteiros (o **resto vai na 1ª**) e cada parcela é ligada à fatura do **seu mês** (`splitInstallments`, `js/core/model/cards.js`).
- **Ciclo:** compra **após o dia de fechamento** vai para a fatura seguinte; faturas não abertas são puladas.
- As faturas ausentes são criadas **antes**, em um lote próprio, com **id determinístico** `${cardId}_${AAAA-MM}`; só então as parcelas vão em **outro lote**. Motivo: `exists()` das Rules não enxerga documentos do mesmo lote. Consequência: falha no segundo lote deixa faturas abertas vazias, que são reaproveitadas.
- **Limite usado/disponível** e total de fatura **aberta** são derivados (`cardLimitUsage`); o `totalCents` só é gravado no fechamento.
- Compra lançada é **imutável** pelas Rules (valor, devedor e fatura não mudam); `updateCardPurchase`/`deleteCardPurchase` seguem as restrições do service. Compra de **devedor** só é excluída por administrador ou depois que o devedor foi removido; compra de fatura **fechada/paga** também não é apagada.
- **Consolidado:** `registerInvoiceConsolidation` lança uma parcela (1x) que representa os gastos do mês sem cadastrar compra a compra, só em fatura aberta ou inexistente.
- Compras podem ter `categoryId` (opcional) e `debtorId` (vínculo com devedor; ver [Devedores](doc:devedores)).

## Fatura

`open` → `closed` → `paid`; também `cancelled`.

| Ação | Quem faz | Detalhe |
|---|---|---|
| **Fechar** (`closeInvoice`) | Cliente | Só a partir do dia de fechamento; grava `totalCents` (soma das parcelas). |
| **Pagar** (`payInvoice` → `invoice.pay`) | **Servidor** | Pagamento **integral**, de fatura `open` ou `closed`, **com uma conta ativa**: recalcula o total das compras **dentro da transação** (o `totalCents` gravado nunca é confiável), checa saldo, marca `paid` e debita a conta **uma vez**. Fatura zerada não é paga. |
| **Cancelar** (`cancelInvoice`) | Cliente | Só fatura aberta **sem compras**. |
| Excluir | Cliente/admin | Fatura paga não é apagada pelo dono enquanto o cartão existir ou se foi estornada. |
| Estornar pagamento | Servidor (`reversal.create`, kind `invoice`) | Devolve o valor à conta. |

Compras do cartão **não são despesas** e não reduzem o saldo: o saldo da conta só muda quando a fatura é paga (sem dupla contagem).

## Armadilhas

- Os comentários do topo de `js/services/creditCards.js` e de `js/modules/cartoes.js` já descrevem o pagamento pelo servidor (`payInvoice`/`invoice.pay`, VF-2-03p/VF-ARQ-02). Se ler algo que diga que pagar fatura "não movimenta conta", é versão antiga.
- Sem transação no cliente: compras simultâneas podem estourar o limite (limitação conhecida).
- Pagamento parcial de fatura não existe.
- Assinaturas no cartão entram como parcela 1x na fatura aberta ([Assinaturas](doc:assinaturas)).
