---
title: Autenticação (login, cadastro, senha)
category: Funcionalidades
tags: autenticação, login, cadastro, senha, e-mail, sessão, firebase-auth
summary: Login, criação de conta, redefinição de senha, política de senha, verificação de e-mail e guarda de sessão das páginas internas.
files: index.html, js/auth-page.js, js/services/auth.js, js/utils/password.js, js/core/guard.js, js/firebase/client.js, js/firebase/config.js
---

# Autenticação (login, cadastro, senha)

## O que o usuário vê

`index.html` tem três abas: **Entrar**, **Criar conta** e **Esqueci a senha**, controladas por `js/auth-page.js`. Quem já está autenticado é redirecionado para `pages/dashboard.html` (`redirectIfAuthenticated`, `js/core/guard.js:30`).

## Como funciona

- **Provedor:** e-mail/senha do Firebase Authentication. Persistência `browserLocalPersistence` (a sessão sobrevive ao fechar a aba).
- **Serviço:** `js/services/auth.js` é a **única** porta para o SDK de autenticação (`signIn`, `register`, `resetPassword`, `signOut`, `currentUser`, `onSessionChange`, `changePassword`, `sendResetToCurrentUser`, `sendVerificationToCurrentUser`, `refreshEmailVerified`). Telas nunca chamam o SDK direto.
- **Mensagens:** `AUTH_ERRORS` traduz códigos do Firebase para pt-BR (`auth/invalid-credential`, `auth/too-many-requests`, `auth/weak-password`, `auth/password-does-not-meet-requirements`…). Código desconhecido cai na mensagem do SDK.
- **Guarda de sessão:** toda página interna chama `requireSession()` (`js/core/guard.js:10`); sem usuário, vai para o login com `?reason=auth&next=<página>`. Depois do login, o app volta para `pages/<next>` (o destino é sempre prefixado por `pages/`, então não há redirecionamento para outros sites).
- **Configuração ausente:** se `js/firebase/config.js` ainda tem placeholders, a tela mostra um aviso (`configMissing`).

## Política de senha

- App: **mínimo 10, máximo 128** caracteres (`MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH`, `js/utils/password.js`); `validateNewPassword` também recusa só espaços e caractere repetido. Vale no **cadastro** (`auth-page.js`) e na **troca de senha** (`validatePasswordChange`).
- Firebase (console): mínimo 10, modo **"Exigir a aplicação"**. Quem tinha senha curta só entra após redefinir por e-mail.
- O erro `auth/password-does-not-meet-requirements` (política do console) é traduzido.

## Verificação de e-mail

- O cadastro **envia o link** de verificação (`sendEmailVerification`, melhor esforço: falha de envio não impede o cadastro).
- O usuário pode **reenviar** e confirmar em *Configurações → Segurança — e-mail* (ver [Configurações](doc:configuracoes)).
- A verificação só é **exigida** se `REQUIRE_VERIFIED_EMAIL=true` na Vercel (desligado por padrão; ver [Segurança](doc:seguranca)).

## Emuladores e modo demo

`js/firebase/client.js` usa os **emuladores** (Auth 9099, Firestore 8080) quando a página roda em `localhost`/`127.0.0.1`, e uma config DEMO se a config real ainda for placeholder. `?mode=demo` e `?mode=firebase` forçam o modo (só fazem sentido em `localhost`; a escolha fica em `sessionStorage`). `?emulator=0` desliga os emuladores.

## Armadilhas

- `getIdToken(true)` é necessário para novas claims (`admin`, `email_verified`) entrarem no token.
- Troca de senha exige **reautenticação** com a senha atual (`reauthenticateWithCredential`) antes de `updatePassword`; contas só com provedor externo veem aviso de que a senha é gerenciada pelo provedor.
- `data.clearOwn` exige login recente (≤ 5 min); sessão antiga recebe 403 `RECENT_LOGIN_REQUIRED`.
