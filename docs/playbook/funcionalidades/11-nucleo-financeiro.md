---
title: Núcleo financeiro
category: Funcionalidades
tags: núcleo, saldo, centavos, idempotência, transação, estorno, modelo, servidor
summary: Como o dinheiro é modelado e processado — saldo derivado, centavos, operações do servidor com transação e idempotência, estornos, retries e auditoria.
files: js/core/model/ledger.js, js/core/model/schemas.js, js/utils/money.js, server/finance/core.mjs, server/finance/ops.mjs, js/services/financeApi.js, js/services/reversals.js, js/core/integrity.js
---

# Núcleo financeiro

Tudo que mexe em dinheiro obedece às mesmas regras. Entender esta ficha explica as demais.

## Modelo e invariantes

- **Centavos inteiros.** `js/utils/money.js` (`parseMoneyToCents`, `centsToMoneyString`, `formatCents`) é a **única** implementação. No servidor, `v.cents` exige inteiro > 0 e ≤ `MAX_CENTS` (R$ 1 bilhão).
- **Datas** como texto ISO `AAAA-MM-DD` no modelo; `Timestamp` só na borda do Firestore (`toFirestoreData`, `js/services/firestore.js:36`). `todayInAppZone` (`js/utils/dates.js:74`) define "hoje" no fuso do app.
- **Schemas** em `js/core/model/schemas.js` (`SCHEMAS`) espelham `firestore.rules`; `validation.js` valida e normaliza (`validateEntity`, `buildEntity`). `js/core/model.js` é só um barrel.
- **Nada derivado é gravado.** Saldo, limite usado, total de fatura aberta, pendente do devedor, valor guardado de meta, gasto de orçamento e previsão são sempre calculados.

## Saldo derivado

`accountBalances` (`js/core/model/ledger.js:62`) calcula, por conta:

```
saldo = saldo de abertura (initialBalanceCents)
      + receitas recebidas (received)       − despesas pagas (paid)
      + transferências confirmadas recebidas − enviadas
      + recebimentos de devedores (debtPayments)
      − aportes em metas + resgates (goalTransactions)
      − faturas de cartão pagas com a conta
```

- Transferência pendente ou cancelada não move dinheiro.
- Se a conta tem `openingDate`, só movimentos **a partir** dela entram (o saldo de abertura já inclui o anterior).
- Recebimento de devedor e movimento de meta não têm status: quando estornados (documento em `reversals`) deixam de contar.
- `orphanMovements` aponta movimentos cuja conta não existe mais (o dinheiro "some" do saldo; a interface avisa).

O mesmo cálculo roda no cliente (dashboard, bancos) e no servidor (`ctx.balanceOf`, `server/finance/core.mjs:198`), que lê dentro da transação as 8 fontes de movimento.

## Operações do servidor

Contrato: `POST /api/finance` com `{ op, operationId, params }` e `Authorization: Bearer <ID token>`. A lista de operações está em [Referência gerada](doc:referencia-gerada).

1. `handleFinance` (`server/finance/core.mjs:303`) valida o token, recusa campos proibidos (`balanceCents`, `receivedCents`, `status`, `uid`, `userId`) e normaliza com `def.validate`.
2. `executeOnce` (`core.mjs:236`) abre uma **transação**: lê o registro de idempotência `users/{uid}/operations/{operationId}`; se existir, devolve o resultado guardado (`idempotent: true`) ou 409 se os parâmetros diferem.
3. `def.prepare(ctx, params)` **só lê** e devolve `{ result, apply }`. Regra do Admin SDK: todas as leituras vêm antes das escritas.
4. `apply` grava o movimento, `ctx.touchAccount()` (incrementa `ledgerSeq` da conta), o registro em `operations` e uma entrada em `auditLog` — tudo na **mesma transação**.
5. **Serialização:** como toda operação que altera saldo lê e escreve o documento da conta, duas transações na mesma conta conflitam e o SDK repete uma delas. Assim a checagem "saldo suficiente" nunca enxerga estado velho.
6. **Retries:** `withRetries` repete até 4 vezes falhas transitórias (`ABORTED`, `UNAVAILABLE`…), com backoff e jitter. Erros de negócio (`FinanceError`) não são repetidos.

Erros de negócio têm código estável (`INSUFFICIENT_BALANCE`, `INVALID_STATE`, `ACCOUNT_NOT_ACTIVE`, `ALREADY_REVERSED`, `NOT_FOUND`, `EXCEEDS_REMAINING`…) e a tela mostra a mensagem real do servidor.

## Cliente das operações

`js/services/financeApi.js`: `callFinance(op, params, { operationId })` (linha 43) e `financeResult` (adaptador para `{ ok, errors }`).

- Gere o `operationId` **ao abrir o formulário** (`newOperationId`): reenviar o mesmo formulário repete a mesma chave e não duplica.
- Chamadas simultâneas com a mesma chave compartilham uma promessa (`inflight`).
- 401 renova o token e repete uma vez; 502/503/504 e `retryable` repetem com backoff e **a mesma chave**; timeout de 15 s.

## Estornos (`reversal.create`)

Correção de lançamento liquidado por **lançamento compensatório**. O original é preservado; o estorno vai para `reversals/{coleção}_{id}`, com motivo, e ajusta saldo/status na mesma transação. Tipos: receita, despesa, transferência, fatura, recebimento de devedor e movimento de meta (`REVERSIBLE` em `ops.mjs`). Estorno duplicado dá `ALREADY_REVERSED`; um lançamento que voltou a ser estornável recebe um novo estorno com sufixo (`_2`, `_3`…). Original estornado não é apagado pelo dono (Rules). Cliente: `js/services/reversals.js`.

## Lote e idempotência por item

Quitação em lote de devedores (`debt.settleBatch`) usa um documento em `batches` e **uma transação por parcela**, com estado explícito do lote e retomada; limite de 500 itens. Ver [Devedores](doc:devedores).

## Auditoria de integridade

`js/core/integrity.js` (puro) recalcula do zero o que os documentos implicam e **compara** com o gravado (agregados do devedor, status de parcelas e faturas) devolvendo `findings` com gravidade; `js/services/integrity.js` lê as coleções (com teto) e chama o núcleo. **Não corrige nada.** Usada pela Central de validação (ver [Administração](doc:administracao)).

## Previsão do mês

`js/core/forecast.js` (puro) e `js/services/forecast.js`: "quanto vou gastar e quanto sobra". Fórmula em `monthlyForecast` (`forecast.js:104`): saldo projetado = saldo atual das contas ativas + receitas previstas − despesas pendentes − faturas que vencem no mês etc. Assinatura no cartão separa **comprometimento** (mês da cobrança) de **saída de caixa** (mês de vencimento da fatura) e descarta duplicidades. Mostrada no [Dashboard](doc:dashboard).

## Armadilhas

- O lote do cliente (`commitAtomic`) **não é transação**: nunca use para decidir com base em saldo.
- `exists()` das Rules não vê documentos do mesmo lote: compras de cartão e faturas novas vão em dois lotes.
- Mudou `SCHEMAS`? Confira `firestore.rules`, `tests/rules/`, `js/core/importSchema.js` (CSV) e as telas.
- Acima do `HISTORY_LIMIT` (5000) por consulta, a operação **recusa** com `HISTORY_TOO_LARGE`, em vez de calcular saldo incompleto.
