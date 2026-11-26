---
title: Orçamentos
category: Funcionalidades
tags: orçamentos, limite, categoria, mês, gasto
summary: Limite mensal por categoria; gasto, restante e percentual são derivados das despesas do mês.
files: js/modules/orcamentos.js, js/services/budgets.js, js/core/aggregates.js
page: orcamentos
---

# Orçamentos

Rota `/orcamentos`. Coleção `users/{uid}/budgets`: `categoryId`, `month` (`AAAA-MM`) e `limitCents` (> 0).

- **Só o limite é gravado.** Gasto, restante e percentual são **derivados** de `js/core/aggregates.js`.
- **Escopo do gasto:** despesas **não canceladas** pelo **mês de vencimento**. Compras no cartão **não entram**.
- **Um orçamento por categoria/mês:** checado na leitura (há janela de concorrência, como nos demais cadastros do caminho A).
- A edição muda só o limite (`updateBudgetLimit`). O dashboard mostra orçamentos estourados nos pontos de atenção.
- A categoria precisa existir (Rules: `ref`); excluir uma categoria com orçamento é bloqueado pelo service de categorias.
