---
title: Atualização automática
category: Operação
tags: playbook, documentação, automação, gerador, ci, github-actions
summary: Como o playbook se mantém em dia sozinho (gerador, testes que bloqueiam defasagem, GitHub Action), como escrever fichas e como o acesso admin funciona.
files: scripts/gen-playbook.mjs, docs/playbook/index.json, docs/playbook/referencia-gerada.md, .github/workflows/playbook.yml, api/docs.mjs, server/docs/playbook.mjs, js/modules/playbook.js, js/utils/markdown.js, js/utils/playbookSearch.js, tests/services/playbook.test.mjs
---

# Atualização automática

O playbook tem **duas camadas** e **três mecanismos** que impedem que ele envelheça.

## As duas camadas

| Camada | Onde | Quem mantém |
|---|---|---|
| **Fichas escritas** (arquitetura, operação, segurança, funcionalidades, runbooks) | `docs/playbook/*.md` e `docs/playbook/funcionalidades/*.md` | Pessoas. Explicam o **porquê** e o **como**. |
| **Referência gerada** (rotas, coleções e campos das Rules, operações do servidor, variáveis de ambiente, scripts, dependências, testes, CSP, tarefas do PLAN) | `docs/playbook/referencia-gerada.md` | **O código.** Nunca edite à mão. |

Os dois viram um único arquivo, `docs/playbook/index.json`, que a página consome.

## Os três mecanismos

1. **Gerador** (`scripts/gen-playbook.mjs`): lê o código (páginas, `vercel.json`, `firestore.rules`, o **registro real** de operações do servidor, `process.env`, `package.json`, `PLAN.md`…) e produz a referência e o índice de forma **determinística** (sem datas nem hashes de commit). Rode `npm run docs:build`. `npm run docs:check` só confere, sem gravar.
2. **Testes que bloqueiam defasagem** (`tests/services/playbook.test.mjs`, parte de `npm run test:unit`, logo do CI):
   - o `index.json` e a `referencia-gerada.md` no disco precisam ser **idênticos** ao que o código gera agora;
   - **toda página** do app precisa ter uma ficha (`page: <id>` no front matter);
   - toda **coleção** do Firestore, **operação** do servidor, **variável de ambiente**, **função de `api/`** e **workflow** precisa ser mencionada em alguma ficha;
   - todo link interno `doc:<id>#<seção>` precisa resolver.
   Ou seja: criou uma página, coleção, operação ou variável nova sem documentar? **O teste falha.**
3. **GitHub Action** (`.github/workflows/playbook.yml`): em **todo push na `claude-dev`**, roda o gerador e, se algo mudou, **comita o resultado na mesma branch** (`docs(playbook): …`). Assim a referência acompanha o código sem ninguém lembrar. Se você trabalha na `claude-dev`, faça `git pull --ff-only` antes de seu próximo push, para pegar o commit do bot.

> A Action só atualiza a parte **gerada**. O texto das fichas continua dependendo de pessoas; os testes acima garantem que ninguém esqueça de **criar** a ficha, e o fluxo de revisão cuida de mantê-la certa.

## Como o acesso admin funciona

- A página `/playbook` (`js/modules/playbook.js`) só aparece para quem tem a claim `admin`; o link fica em *Configurações* para administradores.
- Os dados vêm de `GET /api/docs` (`api/docs.mjs` → `server/docs/playbook.mjs`), que usa **a mesma autorização** de `/api/admin-claims` (token verificado + claim `admin` **atual** no Auth). Sem ser admin: 403.
- `docs/` **não é servido como arquivo estático** (`vercel.json` redireciona `/docs/*`), mas **sobe** no deploy para a função ler o `docs/playbook/index.json` (`includeFiles`). Por isso o conteúdo não fica público.

## Escrever ou editar uma ficha

Cada `.md` começa com um bloco de **front matter**:

```markdown
---
title: Receitas
category: Funcionalidades
tags: receitas, saldo, estorno
summary: Uma linha que aparece no cartão da home e na busca por filtro.
files: js/modules/receitas.js, js/services/incomes.js
page: receitas
---
```

| Campo | Obrigatório | Significado |
|---|---|---|
| `title` | sim | Título na página e na busca |
| `category` | sim | `Começar aqui`, `Operação`, `Segurança`, `Funcionalidades`, `Testes`, `Runbooks` ou `Referência` (define a ordem do sumário) |
| `tags` | não | Lista separada por vírgula; filtros e busca |
| `summary` | recomendado | Resumo curto |
| `files` | recomendado | Arquivos relacionados; também são pesquisáveis |
| `page` | em fichas de página | Id da página (`pages/<id>.html`); o teste exige uma ficha por página |

Regras de escrita:

- `# Título` (nível 1) uma vez; seções em `##` e `###`. **Cada seção é uma unidade de busca e tem link próprio** (o id é o título sem acentos, em minúsculas e com hífens).
- Link interno: `[texto](doc:<id-do-documento>)` ou `[texto](doc:<id>#<seção>)`. O `<id>` é o nome do arquivo sem o prefixo numérico (`50-runbooks.md` → `runbooks`).
- Suportado: títulos, parágrafos, listas (com aninhamento), tabelas, blocos de código, citações, `código`, **negrito**, *itálico* e links `http(s)`. **HTML cru não é interpretado** (a página nunca usa `innerHTML`).
- Cite arquivos como `arquivo:linha` e marque o que **não foi verificado**.
- Termine com `npm run docs:build` e comite junto da mudança de código.

## Arquivos do mecanismo

| Arquivo | Papel |
|---|---|
| `scripts/gen-playbook.mjs` | Gerador e verificador |
| `js/utils/markdown.js` | Parser de Markdown puro e seguro (tokens, não HTML) |
| `js/utils/playbookSearch.js` | Busca: sem acentos, AND entre termos, pontuação por título/tags/arquivos/corpo, realce |
| `js/services/playbook.js` | Cliente de `/api/docs` |
| `js/modules/playbook.js` | A página: busca, filtros, sumário, navegação por hash, atalho `/` |
| `css/playbook.css` | Estilos (tema claro/escuro) |
| `server/docs/playbook.mjs`, `api/docs.mjs` | Endpoint só de administrador |

## Solução de problemas

- **A página diz "Playbook indisponível":** o deploy não incluiu `docs/playbook/index.json`. Confirme que ele está no commit e que `vercel.json` tem `includeFiles` para `api/docs.mjs`; refaça o deploy.
- **403 ao abrir:** a conta não é administradora, ou a claim ainda não está no token (saia e entre de novo).
- **O CI acusa "Playbook defasado":** `npm run docs:build`, revise o `git diff docs/playbook/` e comite.
- **A busca não acha algo que existe:** a busca exige **todos** os termos; use menos termos ou remova filtros.
