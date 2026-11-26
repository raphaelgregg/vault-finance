---
title: Playbook (esta página)
category: Funcionalidades
tags: playbook, documentação, busca, admin
summary: A página de documentação interna: acesso só de administrador, busca, filtros, sumário e links por seção.
files: pages/playbook.html, js/modules/playbook.js, js/services/playbook.js, js/utils/markdown.js, js/utils/playbookSearch.js, css/playbook.css, api/docs.mjs, server/docs/playbook.mjs
page: playbook
---

# Playbook (esta página)

Rota `/playbook`, **fora do menu**; o link aparece em *Configurações* para administradores.

## Uso

- **Busca:** caixa no topo do sumário (atalho `/`, `Esc` limpa). Todos os termos precisam aparecer; ignora acentos e maiúsculas; o título e as tags pesam mais que o corpo; arquivos citados também são pesquisáveis. Resultados mostram trecho com termos **realçados**.
- **Filtros:** categoria (lista suspensa) e tags (chips). Sem texto, o filtro lista os documentos.
- **Navegação:** sumário por categoria, "nesta página" dentro de cada documento, e links `doc:` entre fichas. O endereço guarda a posição (`#doc/<id>/<seção>`), então o botão voltar funciona e dá para compartilhar.
- **Copiar:** cada bloco de código tem um botão **Copiar**.
- No celular o sumário some: use a busca e a página inicial (cartões por categoria).

## Como funciona

Detalhes de acesso, atualização automática e como escrever fichas: [Atualização automática](doc:atualizacao-automatica). Em resumo: `js/modules/playbook.js` confere a claim `admin`, pede `GET /api/docs` (que revalida o administrador no servidor), indexa o JSON no navegador (`js/utils/playbookSearch.js`) e renderiza o Markdown como tokens com `textContent` (`js/utils/markdown.js`), **sem `innerHTML`**.
