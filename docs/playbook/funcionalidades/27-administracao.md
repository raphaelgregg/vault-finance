---
title: Administração (administradores e Central de validação)
category: Funcionalidades
tags: administração, admin, claims, central de validação, auditoria, demonstração
summary: Promover/revogar administradores, listar usuários e a Central de validação (dados de demonstração, auditoria funcional e limpeza), todos protegidos pela claim admin.
files: server/admin/claims.mjs, api/admin-claims.mjs, js/services/adminClaims.js, server/validation/center.mjs, api/validation.mjs, js/services/validationCenter.js, js/modules/manutencao-dados.js
---

# Administração

Duas áreas só para **administradores** (claim `admin === true`), exibidas dentro de *Manutenção de dados* ([Manutenção de dados](doc:manutencao-dados)). Os endpoints validam a autorização **no servidor**; a tela apenas esconde.

## Administradores (`/api/admin-claims`)

- **`GET`** lista usuários (paginado, até 5.000), com indicador `admin`, e-mail e se está desativado. **`POST`** promove ou revoga: corpo `{ target (uid ou e-mail), admin: true|false }`. Preserva as demais claims e **impede a auto-revogação**.
- **Autorização** (`authorizeAdmin`, `server/admin/claims.mjs:203`): (1) ID token verificado **localmente** com as chaves públicas do Google (`verifyFirebaseIdToken`, RS256, confere `iss`, `aud`, `exp`, `sub`) — **não** usa a chave de API web (ela é restrita por referenciador e chamadas de servidor não enviam `Referer`; foi a causa de um 401 antigo); (2) credencial do servidor (service account → token OAuth2); (3) estado **atual** do chamador em `accounts:lookup` (`admin === true`, conta ativa).
- **Erros distintos:** token inválido = 401; não-admin = 403; sem `FIREBASE_SERVICE_ACCOUNT` = 501; formato inválido = 500; Google recusou a credencial = 502. Logs `admin_claims_rejected` trazem só códigos e motivos.
- A claim vale para o usuário só após **novo login** (ou renovar o token).
- Cliente: `js/services/adminClaims.js` (`setAdminClaim`, `listAdminUsers`); a ação é registrada no `auditLog` do executor.
- O **primeiro administrador** é definido fora do app (ver [Runbooks](doc:runbooks#promover-ou-revogar-um-administrador)).

## Central de validação (`/api/validation`)

Isolada de `/api/finance` e de `/api/admin-claims`. Quatro recursos (campo `op`):

| `op` | O que faz |
|---|---|
| `status` | Informa se há dados de demonstração e quantos. |
| `seed` | Popula a conta do administrador com **dados de demonstração**: ids `demo_*`, rótulos `[DEMO]`, e um **manifesto** `demoSeeds/current` listando o que foi criado (`buildDemoSeed`). Frase `POPULAR DEMONSTRACAO`. |
| `audit` | Executa a **auditoria funcional automatizada** sobre a base de demonstração (operações reais do servidor contra contas `demo_*`), **prova** que nenhum dado real foi alterado e remove os artefatos (`operationId` `demoaud-*`). |
| `cleanup` | Remove **somente** o que o manifesto lista (e só ids `demo_*`) e os artefatos da auditoria. **Sem manifesto, nada é apagado.** Frase `REMOVER DEMONSTRACAO`. |

Autorização em camadas a cada chamada: ID token (Admin SDK) + `admin` **no token** + `admin` **atual** da conta (`getUser`). Cliente: `js/services/validationCenter.js`. A auditoria usa `js/core/integrity.js` (ver [Núcleo financeiro](doc:nucleo-financeiro)).

## Armadilhas

- A Central **grava** na conta do administrador (dados `demo_*`); `cleanup` é o caminho de volta.
- `demoSeeds` não está nas Rules do cliente: só o servidor grava e lê.
