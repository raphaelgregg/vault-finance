---
title: Segurança
category: Segurança
tags: segurança, rules, autenticação, admin, csp, tokens, firewall, auditoria
summary: Modelo de ameaças, as camadas de proteção, como cada endpoint autentica, decisões VF-SEC-01…09, riscos aceitos e o que monitorar.
files: firestore.rules, server/finance/core.mjs, server/admin/claims.mjs, server/validation/center.mjs, server/docs/playbook.mjs, server/env-guard.mjs, vercel.json, js/services/auth.js, js/utils/password.js
---

# Segurança

## Modelo de ameaças (resumo)

| Ameaça | Barreira principal |
|---|---|
| Usuário lê ou altera dados de **outro** usuário | Rules: todo caminho exige `request.auth.uid == userId`; negação padrão |
| Navegador forja saldo, status ou valores | Rules negam movimentos liquidados; o servidor recalcula tudo e ignora saldo/status do cliente |
| Credencial administrativa vaza | Service account só em `FIREBASE_SERVICE_ACCOUNT` (Vercel); nunca no navegador; `.gitignore` bloqueia `serviceAccount*`, `*-adminsdk*`, `.env*` |
| Token roubado ou conta desativada continua valendo | `verifyIdToken(token, true)` (checa revogação) em `/api/finance`; claim admin relida no Auth a cada chamada administrativa |
| Operação destrutiva com sessão antiga | `data.clearOwn` exige login feito há ≤ 5 min (`RECENT_LOGIN_SECONDS`) |
| Injeção de script (XSS) | Sem `innerHTML` com dado de usuário; CSP sem `unsafe-inline` em scripts; markdown do playbook vira tokens + `textContent` |
| Esgotar a cota do Firestore / abuso da API | Rate limit no Firewall da Vercel (30 req/min/IP); chave web restrita; App Check **desligado** (ver abaixo) |
| Fórmulas em CSV exportado | `csvField` neutraliza `= + - @`, tab e CR em texto (`js/utils/csv.js`) |
| Configuração insegura em produção | `server/env-guard.mjs` recusa variáveis de emulador em `production`/`preview` |

## Camada 1 — Firestore Security Rules

Arquivo `firestore.rules` (a referência extraída dos campos e permissões está em [Referência gerada](doc:referencia-gerada)).

- **Negação padrão** (`match /{document=**}`). `users/{userId}` em si é sempre negado; só as subcoleções têm regra.
- **Isolamento:** `isOwner(userId)` em tudo. `isAdmin()` = claim `admin == true` **no token**.
- **Schemas fechados:** `keysOk([...])` lista os campos aceitos e `requiredOk` os obrigatórios; `text`, `cents`, `positiveCents`, `oneOf`, `stamp` validam tipos e limites. Datas `createdAt`/`updatedAt` só pelo servidor (`request.time`).
- **Referências:** `ref()` exige que `accountId`, `categoryId` etc. existam na árvore do próprio usuário (`exists()`); **não enxerga documentos do mesmo lote**.
- **Movimentos liquidados só pelo servidor:** receita `received`, despesa `paid`, transferência `confirmed`, fatura `paid`, e as coleções `debtPayments`, `goalTransactions`, `reversals`, `operations` e `batches` têm `create/update: if false`. `debtors.receivedCents` e `status: paid` também.
- **Exclusão protegida:** conta, devedor e `debts` só o administrador apaga; lançamento já estornado não é apagado pelo dono.
- **Admin com poderes mínimos:** lê e apaga documentos das coleções de domínio de qualquer usuário (consultas de grupo `{path=**}/<coleção>`); **não** cria, não edita, não toca `profile`, `settings` nem `auditLog`.
- **`auditLog` create-only:** o dono cria com `action` **sem ponto** (`create`, `update`, `delete`…; formato `dominio.operacao` é exclusivo do servidor), `before`/`after` com até 60 chaves e `actorUid == auth.uid`. Ninguém atualiza nem apaga.

Toda alteração em `firestore.rules` exige teste em `tests/rules/` e publicação manual (ver [Operação e deploy](doc:operacao-deploy)).

## Camada 2 — Autenticação e endpoints do servidor

Todos os endpoints esperam `Authorization: Bearer <ID token do Firebase>` (sem cookies, logo sem CSRF) e devolvem `Cache-Control: no-store`.

| Endpoint | Quem pode | Como valida |
|---|---|---|
| `POST /api/finance` | usuário autenticado | `verifyIdToken(token, true)` (Admin SDK, com checagem de revogação). Caminhos de documento nascem do `uid` do token. |
| `POST /api/validation` | **admin** | Token válido + `admin === true` **no token** + claim atual consultada com `getUser` (revogação vale na hora). |
| `GET/POST /api/admin-claims` | **admin** | Token verificado **localmente** (RS256 com as chaves públicas do Google; confere `iss`, `aud`, `exp`, `sub`) + `accounts:lookup` administrativo (`admin === true` e conta ativa). Impede auto-revogação. |
| `GET /api/docs` | **admin** | Mesma autorização do `admin-claims` (`authorizeAdmin`). |

Validação de parâmetros em `server/finance/core.mjs` (`v.id`, `v.cents`, `v.date`, `v.text`, `v.enum`): ids só `[A-Za-z0-9_-]{1,128}`; valores positivos e ≤ R$ 1 bilhão; campos proibidos (`balanceCents`, `receivedCents`, `status`, `uid`, `userId`) são **recusados**, não ignorados (exceto onde a operação declara `allowParams`).

### Políticas opcionais por variável de ambiente

- `REQUIRE_VERIFIED_EMAIL=true` → 403 `EMAIL_NOT_VERIFIED` sem e-mail verificado. O usuário reenvia o link em *Configurações → Segurança — e-mail*.
- `APPCHECK_ENFORCE=true` → exige `X-Firebase-AppCheck` válido. **Dormente:** o cliente só envia o token se `APP_CHECK_SITE_KEY` (em `js/firebase/config.js`) estiver preenchida.

### Login recente

`data.clearOwn` marca `recentLogin: true`: `handleFinance` exige `auth_time` do token ≤ 300 s (403 `RECENT_LOGIN_REQUIRED`). Usa 403 de propósito, para o cliente **não** tentar renovar o token e repetir (o fluxo trata 401 assim).

## Camada 3 — Navegador

- **CSP** (`vercel.json`): `default-src 'self'`; `script-src` com `'self'`, o hash do import map, `gstatic.com` (SDK do Firebase), `apis.google.com` (carregado pelo Firebase Auth em Safari/mobile) e `google.com/recaptcha/` (App Check dormente); `style-src` com `'unsafe-inline'` (há atributos `style=`); `frame-src` só o domínio de autenticação do projeto e reCAPTCHA; `connect-src` só Firebase; `object-src 'none'`, `frame-ancestors 'none'`.
- **SRI:** módulos do Firebase no import map têm `integrity` (SHA-384); o `lucide` é **local** (`assets/vendor/lucide-0.462.0.min.js`) com SRI. Ao trocar a versão do SDK, recalcule os hashes e o hash CSP (o teste acusa).
- **Senha:** mínimo 10 no app (`validateNewPassword`) **e** no Firebase (política no console). Máximo 128 no app.
- **Sessão:** persistência local do Firebase Auth; o service worker não cacheia nada.

## Decisões de segurança (VF-SEC) e estado

| Tarefa | O que ficou |
|---|---|
| **SEC-01** | `checkRevoked` no servidor; login recente em `data.clearOwn`. |
| **SEC-02** | `server/env-guard.mjs`: variáveis de emulador recusadas em produção/preview. |
| **SEC-03** | Rate limit no Firewall da Vercel. **App Check não ativado** (custo/faturamento do reCAPTCHA Enterprise não confirmados; plano Spark). Código dormente e pronto. |
| **SEC-04** | `.vercelignore` + redirects para `/server`, `/tests`, `/docs`, `/scripts`. |
| **SEC-05** | `lucide` local; `unpkg.com` removido da CSP; `frame-src` restrito. |
| **SEC-06** | Senha ≥ 10 (app + console, modo "Exigir"); e-mail de verificação no cadastro; painel de verificação em Configurações; proteção contra enumeração de e-mails. MFA ficou opcional. |
| **SEC-07** | `auditLog`: sem `action` com ponto e mapas ≤ 60 chaves. |
| **SEC-08** | CSV neutraliza `-` inicial em texto. |
| **SEC-09** | `firebase-admin` 13.10; `npm audit` de produção no CI. |

## Riscos aceitos e limites conhecidos

- **Administrador** lê e apaga dados de todos os usuários e lista e-mails (por desenho). A claim no token vale até 1 h após revogação **nas Rules**; os endpoints do servidor consultam a claim atual.
- **App Check desligado:** criação de contas e chamadas diretas ao Firestore com a chave web pública não têm esse freio. Mitigação: restrições da chave, Rules e rate limit em `/api/*`.
- **`apis.google.com` na CSP:** necessário ao Firebase Auth em alguns navegadores; endpoints JSONP desse domínio são um bypass teórico de CSP caso exista injeção de HTML. Não há `innerHTML` com dado de usuário.
- **Política de senha:** o app aceita 10+; o Firebase também (modo "Exigir"). Quem tinha senha curta precisa redefinir por e-mail.
- **Frase de confirmação** de ações destrutivas é estática (barreira contra clique, não contra atacante).
- **Admin sem MFA:** MFA por SMS não existe no Spark; TOTP depende de Identity Platform (não verificado se é gratuito aqui).

## O que monitorar

- Leituras do Firestore no console (cota diária) e erros 429 na API (limite do Firewall).
- Logs de função na Vercel: `admin_claims_rejected`, `finance_rejected`, `finance_error`, `docs_unavailable` (só códigos/motivos; nunca tokens, chaves ou e-mails).
- Novas contas inesperadas em *Authentication → Usuários*.
- `npm audit --omit=dev` (roda no CI).

## Nunca fazer

- Colocar service account, Admin SDK ou segredos no navegador ou no repositório.
- Definir `FIREBASE_AUTH_EMULATOR_HOST`/`FIRESTORE_EMULATOR_HOST` na Vercel.
- Trocar `firebase-admin` por major novo sem validar em **preview** (o 14 quebrou `/api/finance` com `ERR_REQUIRE_ESM`).
- Usar `innerHTML` com dado vindo do usuário ou do Firestore.
- Relaxar uma Rule "para testar" em produção sem teste correspondente em `tests/rules/`.
