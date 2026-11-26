---
title: Operação e deploy
category: Operação
tags: deploy, vercel, firebase, ambiente, variáveis, branches, ci, firewall
summary: Ambientes, branches, o que cada arquivo de configuração faz, variáveis de ambiente, ajustes no console do Firebase/Google Cloud e checklist pós-deploy.
files: vercel.json, .vercelignore, firebase.json, .firebaserc, firestore.rules, firestore.indexes.json, .github/workflows/ci.yml, .github/workflows/playbook.yml, api/finance.mjs, api/validation.mjs, api/admin-claims.mjs, api/docs.mjs
---

# Operação e deploy

## Ambientes e branches

| Ambiente | Origem | Observações |
|---|---|---|
| **Produção** | branch `main` | Domínios do projeto Vercel `my-vault`: `vault.rgregg.com.br` e `my-vault-one.vercel.app`. Todo push na `main` dispara deploy. |
| **Preview** | qualquer outra branch | URL `my-vault-git-<branch>-raphaelgreggs-projects.vercel.app`. Use para validar antes de produção. |
| **Local** | `npm run serve` ou `npm run serve:api` | `localhost` conecta nos **emuladores** (Auth 9099, Firestore 8080) quando a página roda em `localhost`/`127.0.0.1`. |

**Fluxo de trabalho:** só se trabalha na `claude-dev`. `main` e `development` recebem a `claude-dev` por **fast-forward** (sem force push), e **só com autorização explícita** (`CLAUDE.md` §8). Depois de qualquer push na `main`, teste em produção: login, uma receita, uma despesa e uma transferência.

Projeto Firebase: `vault-finance-d1603` (plano **Spark**, região `nam5`), definido em `.firebaserc` e `js/firebase/config.js`. A chave web (`apiKey`) é pública por design; a proteção real são as Rules e o Authentication.

## O que cada arquivo de configuração faz

| Arquivo | Função |
|---|---|
| `vercel.json` | Headers de segurança e CSP, rewrites das URLs limpas, `redirects` que bloqueiam `/server`, `/tests`, `/docs` e `/scripts` como estáticos, e configuração das funções (`maxDuration`, `includeFiles`). |
| `.vercelignore` | Arquivos que **nem sobem** para a Vercel (PLAN, CLAUDE, README, tests, scripts, `.github`, Rules, `firebase.json`…). **Não ignore** `server/`, `api/`, `js/` nem `package*.json`: as funções importam deles. `docs/` sobe de propósito, só para `/api/docs` ler `docs/playbook/index.json`. |
| `firebase.json` | Só emuladores e referência a Rules/índices. Não há bloco `hosting`: a hospedagem é da Vercel. |
| `firestore.rules` | Security Rules. **Alterar exige teste em `tests/rules/` e publicação manual** (ver abaixo). |
| `firestore.indexes.json` | Índices compostos. Consulta nova com filtro + ordenação costuma exigir índice. |
| `package.json` | Scripts, dependências e `engines.node >= 24`. A única dependência de produção é `firebase-admin` (usada em `server/`). |

### `vercel.json` em detalhe

- **Funções** (`api/*.mjs`): `finance` 30 s; `validation` 60 s; `docs` 10 s com `includeFiles: docs/playbook/index.json`.
- **Rewrites** `/<página>` → `/pages/<página>` (sem `.html`), incluindo `/manutencao-dados` e `/playbook`.
- **Redirects** (302): `/(server|tests|docs|scripts)/:path*` → `/`. Redirects vêm antes do sistema de arquivos, então esses diretórios nunca saem como estáticos.
- **Headers** em tudo: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY` e **Content-Security-Policy**. O hash `sha256` do `script-src` é do import map injetado por `js/importmap.js`; **muda sempre que o import map muda**. O teste `tests/services/security-headers.test.mjs` falha se estiver fora de sincronia.

## Variáveis de ambiente (Vercel)

A lista completa e atual, com os arquivos que leem cada uma, está em [Referência gerada](doc:referencia-gerada). Resumo do significado:

| Variável | Para quê | Obrigatória |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON (ou base64) da service account do Admin SDK. Dá acesso ao Firestore **e** ao Authentication. | **Sim** |
| `FIREBASE_PROJECT_ID` | Sobrescreve o projeto (padrão `vault-finance-d1603`). | Não |
| `GCLOUD_PROJECT` | Fallback do projeto no Admin SDK. | Não |
| `REQUIRE_VERIFIED_EMAIL` | `true` exige e-mail verificado nas operações de `/api/finance` e `/api/validation` (403 `EMAIL_NOT_VERIFIED`). Desligado por padrão. | Não |
| `APPCHECK_ENFORCE` | `true` exige o cabeçalho `X-Firebase-AppCheck`. **App Check está desligado por decisão** (ver [Segurança](doc:seguranca)). | Não |
| `VERCEL_ENV` | Definida pela Vercel (`production`, `preview`, `development`). Usada pelo guarda de emulador. | Automática |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` | **Só em desenvolvimento/testes.** Com elas, o Admin SDK aceita tokens **sem assinatura**; por isso o servidor **recusa** qualquer uma delas em `production`/`preview` (`server/env-guard.mjs`). **Nunca crie na Vercel.** | Não |
| `PORT` | Porta do servidor local `scripts/dev-server.mjs`. | Não |

Para mudar uma variável: Vercel → projeto → *Settings → Environment Variables*, e **refaça o deploy** (variáveis só valem em deploys novos).

## Publicar as Security Rules

Quando `firestore.rules` mudar:

```bash
npm run test:rules
```
```bash
npx firebase deploy --only firestore:rules --project vault-finance-d1603
```

Requer `firebase login` na máquina. Alternativa: console do Firebase → *Firestore → Regras* → colar o arquivo → *Publicar*. O console guarda histórico e permite voltar a versão anterior. O deploy publica o **arquivo inteiro**. Índices: `--only firestore:indexes`. Só publique com autorização (`CLAUDE.md`).

## Configurações feitas no console (fora do código)

Estas **não estão no repositório**; se o projeto for recriado, refaça:

- **Authentication → Settings → Ações do usuário:** *Email enumeration protection* ativa.
- **Authentication → Settings → Política de senha:** mínimo 10, sem exigir classes de caractere, modo **"Exigir a aplicação"** (quem tem senha curta só entra após redefinir por e-mail).
- **Google Cloud → APIs e serviços → Credenciais → chave de navegador:** restrição por **referenciadores HTTP** (domínios de produção, previews usados, `localhost:5500` e `vault-finance-d1603.firebaseapp.com`) e por **API** (Cloud Firestore, Identity Toolkit, Token Service). **Todo preview de branch nova precisa ter o domínio adicionado aqui**, senão o login falha (ver [Runbooks](doc:runbooks#dominio-ou-preview-novo-nao-autentica)).
- **Vercel → Firewall:** regra "Limite da API": caminho começa com `/api/`, janela fixa de 60 s, **30 requisições por IP**, resposta 429.
- **Contas administradoras:** a claim `admin` é concedida pelo próprio app (ver [Administração](doc:administracao)); o primeiro administrador precisa ser definido fora do app (console ou Admin SDK).

## CI e automações (GitHub Actions)

- `ci.yml` — **CI:** em push nas branches `claude-dev` e `main` e em pull requests: `npm audit --omit=dev --audit-level=high`, lint e testes unitários em Node 24 e 26; Rules e integração no emulador (Java 17). Não roda E2E (precisa de navegador).
- `playbook.yml` — **Playbook:** regenera `docs/playbook/` e comita na `claude-dev` quando o código muda (ver [Atualização automática](doc:atualizacao-automatica)).

## Checklist pós-deploy (produção)

1. O deploy ficou "Ready" na Vercel (build e funções sem erro).
2. Entre em `vault.rgregg.com.br` e crie **uma receita, uma despesa e uma transferência**.
3. Console do navegador sem erros de CSP; ícones carregam (o `lucide` é local em `assets/vendor/`).
4. `/PLAN.md`, `/firestore.rules` e `/server/admin/claims.mjs` **não** devolvem conteúdo.
5. `/playbook` abre para o administrador e a busca responde.
6. Se mexeu em Rules ou índices: conferir no console que foram publicados.

## Cotas do Spark e monitoramento

- Firestore: **50 mil leituras/dia, 20 mil escritas/dia, 20 mil exclusões/dia**. Uma operação financeira lê muitos documentos; o rate limit reduz o risco, mas não elimina.
- Acompanhe *Firebase → Firestore → Uso*. Leituras altas sem você estar usando é sinal de abuso: reavalie App Check e o limite do Firewall.
- Logs de função na Vercel: o plano **Hobby retém 1 hora**. Colete o erro logo depois de reproduzir.
