---
title: Configurações
category: Funcionalidades
tags: configurações, perfil, tema, senha, e-mail, preferências
summary: Perfil, tema, ocultar valores, primeiro dia da semana, troca de senha, verificação de e-mail e atalhos para manutenção e playbook.
files: js/modules/configuracoes.js, js/services/preferences.js, js/services/auth.js, js/components/theme.js
page: configuracoes
---

# Configurações

Rota `/configuracoes` (item de menu). Módulo `js/modules/configuracoes.js`.

## Painéis

1. **Perfil e preferências:** nome, **tema** (`light`/`dark`/`system`), **ocultar valores** e **primeiro dia da semana** (0–6). Gravados em `users/{uid}/profile/main` e `users/{uid}/settings/main` por `js/services/preferences.js` (`getProfile`, `saveProfile`, `getSettings`, `saveSettings`). O tema também fica em `localStorage` (chave da UI) para evitar o flash ao recarregar; o valor da conta prevalece em um dispositivo novo.
2. **Segurança — senha** (`buildPasswordPanel`): senha atual + nova + confirmação, com **reautenticação** antes de `updatePassword`; alternativa por e-mail de redefinição. Só para contas com provedor `password`.
3. **Segurança — e-mail** (`buildEmailVerificationPanel`): mostra se o e-mail está verificado, **Enviar e-mail de verificação** e **Já verifiquei** (recarrega o usuário e renova o ID token).
4. **Atalhos:** *Abrir manutenção de dados* (qualquer usuário) e *Abrir playbook (administradores)* (só quem tem a claim `admin`; a barreira real é o servidor).

## Regras (espelhadas das Rules)

- `profile`: `name` 1–80, `email` 1–160, `currency` = `BRL`, `locale` = `pt-BR`; `createdAt` imutável.
- `settings`: `theme` ∈ `light|dark|system`, `hideValues` booleano, `firstWeekday` inteiro 0–6.
- Ambos são **documentos únicos** (`docId == 'main'`) e **nunca são apagados** pelo cliente.

## Armadilhas

- O tema é aplicado antes de carregar a conta (`applyStoredTheme` em `js/app.js`); `setThemePersister` grava na conta depois.
- Painéis de senha e e-mail só aparecem para quem tem o provedor `password` (`hasPasswordProvider`).
