---
title: Metas
category: Funcionalidades
tags: metas, aporte, resgate, progresso, conta vinculada
summary: Metas de poupança com prazo; valor guardado derivado de aportes e resgates feitos pelo servidor; metas vinculadas a uma conta.
files: js/modules/metas.js, js/services/goals.js, js/core/model/goals.js, server/finance/ops.mjs
page: metas
---

# Metas

Rota `/metas`. Coleções `goals` (`name`, `description`, `targetCents`, `deadline`, `accountId`, `status`: `active`, `completed`, `cancelled`) e `goalTransactions` (aportes e resgates, **só pelo servidor**).

- **Valor guardado é derivado:** aportes − resgates, excluindo os estornados (`goalSavedCents`, `js/core/model/goals.js`). Progresso e restante também.
- **Aportar/resgatar:** `goal.deposit` / `goal.withdraw` (servidor). O aporte **debita** a conta (checa saldo); o resgate **credita**. A meta vira `completed` ao atingir o alvo e é reativada ao resgatar abaixo dele; `completed` só nasce de aportes. Mesma transação do movimento.
- **Meta vinculada a uma conta** (`accountId`): o progresso **segue o saldo dessa conta** (`allocateLinkedGoalBalances`); aporte/resgate manual é recusado ("transfira para a conta").
- **Editar:** só meta **ativa**; o novo alvo precisa ser **maior** que o já guardado.
- **Excluir:** bloqueado se houver movimentações (fail-closed); **cancele** para manter o histórico.
- Movimentos de meta são **imutáveis**; correção = estorno (`reversal.create`, kind `goalTransaction`).
- A tela de [Transferências](doc:transferencias) também faz aporte e resgate pela opção "Meta: …".
