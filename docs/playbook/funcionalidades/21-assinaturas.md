---
title: Assinaturas
category: Funcionalidades
tags: assinaturas, recorrência, cobrança, cartão, devedor, previsão
summary: Cobranças recorrentes (mensal, semanal, anual); lançamento da cobrança no cartão, como dívida de um devedor ou só avançando a data.
files: js/modules/assinaturas.js, js/services/subscriptions.js, js/services/subscriptionDebts.js, js/core/model/subscriptions.js, js/core/forecast.js
page: assinaturas
---

# Assinaturas

Rota `/assinaturas`. Coleção `users/{uid}/subscriptions`: `name`, `amountCents`, `periodicity` (`monthly`, `weekly`, `yearly`), `nextChargeDate`, `chargeDay`, `accountId`, `cardId`, `debtorId`, `categoryId`, `status` (`active`, `paused`, `cancelled`) e `notes`.

- Custo mensal e anual são calculados **só das ativas** (`js/core/model/subscriptions.js`); nada derivado é gravado.
- `chargeDay` **nunca vem do formulário**: é derivado da data escolhida e só existe para os dias 29–31, que o fim do mês pode "apagar" (`chargeAnchorDay`).
- A categoria deve aceitar despesa (`expense`/`both`); cartão cancelado e devedor cancelado são recusados.

## Cobrança (`registerSubscriptionCharge`)

Lança **só a cobrança da data atual** (`nextChargeDate`) e avança a data um período; nunca gera cobranças futuras nem retroativas (a recorrência pode ser pausada ou cancelada). Destino:

| Configuração | O que acontece |
|---|---|
| **Com cartão** (`cardId`) | Uma parcela (1x) na **fatura aberta** do período; fatura fechada/paga nunca é alterada (vai para a próxima aberta). **Não** gera despesa em conta: o débito ocorre ao pagar a fatura. Com `debtorId`, a compra nasce vinculada ao devedor. |
| **Sem cartão, com devedor** | Fecha o ciclo da **dívida do devedor** (ver abaixo) e avança a data. |
| **Sem cartão nem devedor** | Só avança a data; **não** gera despesa nem altera saldo (lance em [Despesas](doc:despesas) se quiser refletir). |

**Anti-duplicação:** o documento de cobrança usa id determinístico (`chargeDocId`); se já existe, a cobrança é recusada, e duas chamadas concorrentes falham na segunda (regravar = update, negado pelas Rules).

## Dívida acompanhando a assinatura (`subscriptionDebts.js`)

Enquanto a assinatura está **ativa** e vinculada a um devedor **sem cartão**, existe **uma** dívida lançada por ela com vencimento = `nextChargeDate`:

- criar, vincular ou reativar → lança a da data atual (se ainda não existe);
- editar data ou valor → **reagenda a mesma dívida** (servidor, `debt.reschedule`);
- pausar, cancelar, excluir ou desvincular → **cancela** a dívida pendente (servidor, `debt.cancel`, devolvendo o emprestado).

Dívida **com recebimentos** nunca é alterada nem cancelada por aqui (estorne antes). Falha no lançamento automático vira **resultado**, não exceção: a assinatura já foi salva.

## Previsão

`js/core/forecast.js` expande as ocorrências (`subscriptionOccurrences`, até 60 passos) e separa **comprometimento** (mês da cobrança) de **saída de caixa** (mês de vencimento da fatura no cartão), descartando duplicidades com despesas ou compras já lançadas. Ver [Núcleo financeiro](doc:nucleo-financeiro).
