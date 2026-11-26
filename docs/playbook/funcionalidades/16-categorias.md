---
title: Categorias
category: Funcionalidades
tags: categorias, tipos, vínculos, exclusão
summary: Categorias de receita, despesa ou ambas; compatibilidade com o tipo de lançamento e exclusão bloqueada quando em uso.
files: js/modules/categorias.js, js/services/categories.js, js/core/model/validation.js
page: categorias
---

# Categorias

Rota `/categorias`. Coleção `users/{uid}/categories`: `name` (1–60), `kind` (`income`, `expense`, `both`) e `color`.

## Regras

- **Compatibilidade:** receita só aceita categoria `income`/`both`; despesa só `expense`/`both` (`checkCategoryForMovement`, `js/core/model/validation.js`). O cliente dá feedback imediato e o **servidor revalida**.
- **Exclusão segura (fail-closed):** `deleteCategory` conta vínculos em `CATEGORY_LINK_COLLECTIONS` (receitas, despesas, orçamentos, assinaturas e compras no cartão). Se houver qualquer vínculo **ou** a verificação falhar, **não exclui** e explica o motivo. As Rules, sozinhas, permitiriam apagar: a proteção é do service.
- Edição e criação vão direto ao Firestore (caminho A); toda mudança é auditada.
