---
title: Runbooks
category: Runbooks
tags: runbook, procedimento, deploy, rules, admin, erro, cota, firebase-admin, sdk
summary: Passo a passo de tarefas recorrentes e de diagnóstico — publicar Rules, promover admin, atualizar SDK e firebase-admin, erro 500, cota, adicionar página, coleção e operação.
files: scripts/dev-server.mjs, js/importmap.js, vercel.json, server/finance/core.mjs, server/finance/ops.mjs, js/core/model/schemas.js, firestore.rules
---

# Runbooks

Cada seção é um procedimento independente. Antes de agir em produção, leia [Operação e deploy](doc:operacao-deploy).

## Publicar as Security Rules

1. Edite `firestore.rules` **e** adicione o caso em `tests/rules/firestore.rules.test.mjs`.
2. `npm run test:rules` (precisa de Java). Tudo verde.
3. Com autorização: `npx firebase deploy --only firestore:rules --project vault-finance-d1603` (ou colar no console).
4. Entre no app e faça uma receita, uma despesa e uma transferência. Se algo falhar, volte a versão anterior no console (*Firestore → Regras → histórico*).

O deploy publica o arquivo **inteiro**: se houver mudanças antigas não publicadas, elas vão junto.

## Promover ou revogar um administrador

**Pelo app** (quem já é admin): *Manutenção de dados* → seção de administradores → informar e-mail ou uid → digitar a frase (`PROMOVER ADMIN` / `REVOGAR ADMIN`). Chama `POST /api/admin-claims`. Não é possível revogar a **própria** claim. A pessoa precisa **sair e entrar de novo** (ou renovar o token) para a claim valer; o token atual pode levar até 1 h para expirar.

**O primeiro administrador** não pode ser criado pelo app. Defina pela service account, fora do repositório:

```javascript
// Rode localmente, com a service account em FIREBASE_SERVICE_ACCOUNT (JSON). Nunca comite este script.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
await getAuth().setCustomUserClaims('<uid>', { admin: true });
```

## Verificar o e-mail e ligar `REQUIRE_VERIFIED_EMAIL`

1. Entre como o usuário em *Configurações → Segurança — e-mail* → **Enviar e-mail de verificação**.
2. Abra o link do e-mail e volte ao app → **Já verifiquei** (renova o token).
3. Só depois de **todas** as contas ativas estarem verificadas, crie `REQUIRE_VERIFIED_EMAIL=true` na Vercel e refaça o deploy. Antes disso, as operações financeiras das contas não verificadas dão 403.

## Atualizar o SDK do Firebase (CDN)

O SDK vem do `gstatic.com` pelo import map de `js/importmap.js` (`FIREBASE_VERSION`).

1. Altere `FIREBASE_VERSION` em `js/importmap.js` e a versão `firebase` em `package.json` (devDependency).
2. Recalcule os hashes SHA-384 dos arquivos do pacote npm `firebase@<versão>`: `firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js` e `firebase-app-check.js`:
```bash
openssl dgst -sha384 -binary <arquivo> | openssl base64 -A
```
3. Atualize o `integrity` de cada módulo em `js/importmap.js` e o **hash `sha256` do import map** no `script-src` de `vercel.json` (o teste `tests/services/security-headers.test.mjs` imprime o valor esperado).
4. `npm run lint && npm run test:unit`, abra um **preview** e confira o console do navegador (sem erro de CSP/SRI).

## Atualizar o `firebase-admin`

O `firebase-admin` 14 **quebrou** `/api/finance` na Vercel com `ERR_REQUIRE_ESM` (`jwks-rsa` → `jose`, módulo só-ESM); local passava porque o Node recente aceita `require()` de ESM. O projeto está na **13.10**.

1. Atualize em um commit isolado na `claude-dev`.
2. `npm ls jwks-rsa jose` e `npm audit --omit=dev`.
3. `npm run test:unit` (o teste de `security-hardening` importa o servidor com `--no-experimental-require-module`) e `npm run test:integration`.
4. **Valide no preview da Vercel** (criar receita, despesa, transferência) **antes** de levar para `main`.

## Diagnosticar erro em `/api/*`

1. Reproduza e **na hora** abra os logs de runtime do projeto na Vercel (Hobby guarda 1 h). Filtre por `/api/finance`.
2. Interprete o código de resposta:

| Status / `error` | Causa provável | Ação |
|---|---|---|
| 401 `UNAUTHENTICATED` / `INVALID_TOKEN` | Token ausente, expirado ou **revogado** | Entrar de novo |
| 403 `RECENT_LOGIN_REQUIRED` | `data.clearOwn` com login antigo (> 5 min) | Sair e entrar |
| 403 `EMAIL_NOT_VERIFIED` | `REQUIRE_VERIFIED_EMAIL` ligada | Verificar e-mail em Configurações |
| 400 `FORBIDDEN_PARAM`, `INVALID_*` | Parâmetro inválido ou proibido | Corrigir o cliente |
| 409 `INSUFFICIENT_BALANCE`, `INVALID_STATE`, `OPERATION_ID_REUSED` | Regra de negócio / chave reutilizada | Mensagem ao usuário |
| 429 | Limite de 30 req/min por IP do Firewall | Aguardar; revisar a regra se atrapalhar |
| 501 `SERVER_NOT_CONFIGURED` / `not_configured` | Falta `FIREBASE_SERVICE_ACCOUNT` no ambiente | Criar a variável e refazer o deploy |
| 500 `bad_service_account` | Valor inválido da service account | Recolar o JSON |
| 500 `EMULATOR_IN_PRODUCTION` | Variável de emulador no ambiente | Removê-la na Vercel |
| 500 `HISTORY_TOO_LARGE` | Histórico acima do limite verificável (5000) | Arquivar período antigo |
| 500 (sem código) com `ERR_REQUIRE_ESM` nos logs | Dependência só-ESM carregada por `require()` | Reverter a dependência (ver acima) |
| 502 `server_credential_failed` | O Google recusou a credencial | Conferir chave/projeto |
| 503 `TEMPORARILY_UNAVAILABLE` | Contenção transitória | O cliente repete com o **mesmo** `operationId` |

## Cota do Firestore estourou

Sintoma: leituras/escritas falham até o dia seguinte. Veja *Firestore → Uso*. Se o consumo não é seu: revise o Firewall (rate limit), as restrições da chave web e a lista de usuários em *Authentication*; considere reabrir o App Check (ver [Segurança](doc:seguranca)). Se é legítimo, reduza leituras (tetos `READ_LIMIT`, paginação) ou avalie o plano.

## Domínio ou preview novo não autentica

Sintoma: no preview de uma branch (ou em um domínio novo) o login falha com erro do Firebase (`auth/permission-denied-on-the-service` ou "requests from referer … are blocked"). Causa: a **chave de API web** só aceita os referenciadores listados.

1. Google Cloud → *APIs e serviços → Credenciais* → chave "Browser key (auto created by Firebase)".
2. Em *Restrições de sites*, adicione `https://<domínio>/*` (ex.: `https://my-vault-git-claude-dev-raphaelgreggs-projects.vercel.app/*`). Use o endereço da **branch**, não o de cada deploy (que muda a cada push).
3. Salve e aguarde de 1 a 5 minutos; recarregue com `Ctrl+F5`.
4. Opcional: *Authentication → Settings → Domínios autorizados* com o mesmo domínio.
5. Se a Vercel pedir login antes de abrir o preview, é a proteção de deploys da Vercel (outro assunto).

Aconteceu quando a branch de trabalho mudou de `claude` para `claude-dev`: toda **branch nova** precisa do domínio na lista.

## Usuário não consegue entrar

1. **Senha curta:** com a política "Exigir", senhas < 10 só entram após **redefinir por e-mail** ("Esqueci a senha").
2. **Conta desativada:** *Authentication → Usuários*.
3. **Token revogado:** sair e entrar de novo.
4. **E-mail não verificado:** o login funciona; só as operações do servidor ficam bloqueadas (se `REQUIRE_VERIFIED_EMAIL`).

## Girar a service account

1. Google Cloud → IAM → Contas de serviço → crie uma chave nova (JSON) da conta `firebase-adminsdk-…`.
2. Atualize `FIREBASE_SERVICE_ACCOUNT` na Vercel e refaça o deploy; teste uma operação.
3. **Apague a chave antiga.** Nunca cole a chave em chat, issue ou commit.

## Reverter um deploy

- **Rápido (produção):** Vercel → *Deployments* → deploy anterior "Ready" → *Promote to Production*.
- **No código:** `git revert` na `claude-dev` e fast-forward para `main` (com autorização). Rules não voltam sozinhas: use o histórico no console.

## Backup e recuperação de dados

Não há backup automático no plano Spark. A exportação existente é por **CSV/ZIP** em *Manutenção de dados* (ver [Manutenção de dados](doc:manutencao-dados)). Exporte antes de qualquer limpeza em massa.

## Adicionar uma página nova

1. `pages/<id>.html`: copie uma página existente e ajuste `<title>` e `data-page="<id>"`. **Sem script inline** (CSP).
2. `js/modules/<id>.js` exportando `render(container, { user })`.
3. Registre em `MODULES` (`js/app.js`).
4. `vercel.json`: rewrite `/<id>` → `/pages/<id>` (sem `.html`).
5. Se for item de menu: `js/utils/nav.js` (`NAV_ITEMS`); senão adicione a página aos testes de rotas como as páginas internas.
6. **Documente:** crie `docs/playbook/funcionalidades/<nn>-<id>.md` com `page: <id>` no front matter. O teste do playbook **falha** sem a ficha.
7. `npm run docs:build` e comite o resultado.

## Adicionar uma coleção ou campo

1. `js/core/model/schemas.js` (`SCHEMAS`) e validação em `js/core/model/validation.js`.
2. `firestore.rules`: `keysOk`, `requiredOk`, validações e permissões; **teste em `tests/rules/`**.
3. Service em `js/services/` usando `createAudited`/`updateAudited`.
4. Se entrar no CSV: `js/core/importSchema.js`. Se for movimento que altera saldo: não escreva direto, crie uma operação de servidor.
5. Índice composto em `firestore.indexes.json` se houver filtro + ordenação.
6. Ficha da funcionalidade e `npm run docs:build`.

## Adicionar uma operação de servidor

1. Em `server/finance/ops.mjs`: `defineOp('<dominio>.<acao>', { validate, prepare(ctx, p, operationId) })`. `validate` usa `v.*` (`core.mjs`). `prepare` **lê tudo antes** de escrever e devolve `{ result, apply }`; em todo movimento que altera saldo chame `ctx.touchAccount(contaId)`.
2. Nunca confie em saldo/status vindo do cliente; use `ctx.balanceOf(conta)` dentro da transação.
3. Cliente: função no service chamando `financeResult('<op>', params, { operationId })` (`js/services/financeApi.js`); gere o `operationId` ao abrir o formulário.
4. Rules: o caminho direto equivalente deve estar **negado**.
5. Testes: recusas em `tests/services/`, saldo/concorrência em `tests/integration/`.
6. Documente a operação em uma ficha (o teste do playbook exige o nome da operação em algum documento).

## Playbook defasado no CI

Se o teste acusar "Playbook defasado": `npm run docs:build`, confira o `git diff docs/playbook/` e comite. Em push na `claude-dev` a automação faz isso sozinha (ver [Atualização automática](doc:atualizacao-automatica)).
