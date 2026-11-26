---
title: Manutenção de dados
category: Funcionalidades
tags: manutenção, limpeza, importação, exportação, csv, massa de testes, backup
summary: Limpeza dos próprios dados, massa de testes e importação/exportação CSV com simulação; escopos administrativos aparecem só para administradores.
files: js/modules/manutencao-dados.js, js/services/maintenance.js, js/services/importer.js, js/core/importSchema.js, js/services/seed.js, js/utils/maintenance-config.js, js/utils/zip.js
page: manutencao-dados
---

# Manutenção de dados

Rota `/manutencao-dados`, **fora do menu** (atalho em *Configurações*). **Qualquer usuário autenticado** abre a página; o que cada um pode fazer é decidido por **escopo**, e a barreira real são as Rules e o servidor.

## Limpeza

| Escopo | Quem | Como |
|---|---|---|
| **Meus dados** (`own`) | qualquer usuário | `clearOwnData` chama a operação do servidor `data.clearOwn` (frase `APAGAR MEUS DADOS` enviada ao servidor; na tela é digitada a frase de confirmação). **Exige login recente** (≤ 5 min). Apaga em ordem de dependência (`CLEAR_ORDER`) e **preserva** o `auditLog` e as `operations`. |
| **Usuário específico** (`target_uid`) | **admin** | Lê e apaga documentos de outro uid, sem entrar na conta (`clearUserData`), sem tocar `auditLog` alheio. |
| **Banco inteiro** (`all_users`) | **admin** | Consulta de grupo nas coleções de domínio de todos os usuários. |

Toda ação destrutiva exige **frase digitada** (`CONFIRM_PHRASES` em `js/utils/maintenance-config.js`: `LIMPAR USUARIO ALVO`, `LIMPAR BANCO INTEIRO`, `RESETAR E GERAR`, `PROMOVER ADMIN`, `REVOGAR ADMIN`…), em lotes de até 500 operações. Escopos administrativos são **escondidos** de não-admin na tela, mas a proteção real são as Rules (`isAdmin()`).

## Massa de testes

`seedFullTestSuite` (`js/services/seed.js`) popula **o usuário autenticado** com um pacote completo de cenários usando os **próprios services do app** (Rules, centavos, auditoria). Datas relativas a hoje; nomes começam com "Teste". `volume` (1–20) multiplica receitas e despesas. **Resetar + Gerar** limpa e popula.

> Existe também a **Central de validação** (admin), que é outra coisa: ver [Administração](doc:administracao).

## Importação e exportação CSV

Fluxo em **duas etapas** (`js/services/importer.js`):

1. **`dryRunImport`** lê o CSV (uma entidade **ou** o CSV unificado `todas`), resolve referências **por nome** e valida **tudo sem gravar**, classificando cada linha: nova, a mesclar (`merge`), duplicada ou com erro. Entidades são processadas em **ordem de dependência** (`IMPORT_ORDER`: contas → categorias → cartões → devedores → receitas, despesas, transferências, assinaturas, metas, dívidas, compras de cartão), então o arquivo pode vir fora de ordem. Máximo **500 linhas** por importação (`MAX_IMPORT_ROWS`).
2. **`applyImport`** grava pelos **services** do app (portanto com Rules, centavos inteiros e auditoria), grupo a grupo, relendo a base antes de cada grupo. É **idempotente**: `IMPORT_IDENTITY` define a chave determinística de cada entidade (por exemplo, conta = `instituição|nome`; receita = `descrição|valor|data|conta`) e evita duplicar ao reimportar; o relatório mostra criados, atualizados, ignorados e falhas.

Esquema (colunas em português, campos do modelo, resolução de referências): `js/core/importSchema.js` — **puro**; `mapImportRow` valida como o service. Mudou um campo do modelo? Atualize aqui também.

**Exportação:** modelo CSV vazio, CSV da base atual por entidade, CSV unificado e **ZIP com todas as entidades** (`exportAllCsv`, `js/utils/zip.js`, sem bibliotecas). É o **único backup** disponível no Spark: exporte antes de limpezas.

## Armadilhas

- Importar não cria movimentos **liquidados** por fora das regras: receitas e despesas entram pelos services (e, portanto, pelo servidor).
- `clearOwnData` precisa de sessão recente: sessão antiga recebe 403 `RECENT_LOGIN_REQUIRED`.
- O `auditLog` do próprio usuário sobrevive à limpeza (é create-only).
