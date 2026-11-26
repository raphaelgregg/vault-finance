---
title: Comece aqui
category: Começar aqui
tags: início, mapa, glossário, convenções, índice
summary: Como usar este playbook, mapa rápido "quero mexer em X → vá para Y", glossário e regras de ouro do projeto.
files: CLAUDE.md, PLAN.md, README.md, docs/ARCHITECTURE.md
---

# Comece aqui

O **Vault Finance** é um controle financeiro pessoal: HTML5 + CSS3 + JavaScript ES Modules **puros** (sem framework e sem build), com **Firebase Authentication** (e-mail/senha) e **Cloud Firestore** no navegador. As operações que mexem em saldo passam por funções de servidor na **Vercel** (Firebase Admin SDK). O app é uma PWA hospedada como site estático na Vercel.

## Como usar este playbook

- **Buscar:** use a caixa de busca (atalho `/`). Ela procura em todas as seções, sem diferenciar maiúsculas nem acentos, e todos os termos precisam aparecer. Dá para filtrar por categoria e por tag.
- **Navegar:** o sumário à esquerda agrupa por categoria. Cada seção tem link próprio (`#doc/<documento>/<seção>`), então dá para compartilhar o endereço exato.
- **Confiança:** cada ficha cita arquivos (`arquivo:linha`). Se uma linha mudou, o arquivo continua certo e a linha pode ter se deslocado. A seção [Referência gerada](doc:referencia-gerada) é extraída do código e é a fonte para rotas, coleções, campos das Rules, operações do servidor e variáveis de ambiente.
- **Atualização:** o playbook se mantém sozinho. Veja [Atualização automática](doc:atualizacao-automatica).

## Quero mexer em… → vá para

| Quero… | Leia |
|---|---|
| entender as camadas e o fluxo de uma requisição | [Arquitetura](doc:arquitetura) |
| publicar uma mudança, regras do Firestore, variáveis na Vercel | [Operação e deploy](doc:operacao-deploy) |
| entender o que protege os dados e por quê | [Segurança](doc:seguranca) |
| rodar ou escrever testes | [Testes](doc:testes) |
| resolver um problema (500, cota, acesso admin…) | [Runbooks](doc:runbooks) |
| mexer em receitas, despesas ou transferências | [Receitas](doc:receitas), [Despesas](doc:despesas), [Transferências](doc:transferencias) |
| mexer em contas e saldos | [Bancos e contas](doc:bancos), [Núcleo financeiro](doc:nucleo-financeiro) |
| cartões e faturas | [Cartões](doc:cartoes) |
| devedores e parcelas | [Devedores](doc:devedores) |
| login, senha, e-mail verificado | [Autenticação](doc:autenticacao), [Configurações](doc:configuracoes) |
| administradores, Central de validação, limpeza de dados | [Administração](doc:administracao), [Manutenção de dados](doc:manutencao-dados) |
| adicionar uma página, coleção ou operação nova | [Runbooks](doc:runbooks#adicionar-uma-pagina-nova) |

## Regras de ouro

1. **Dinheiro em centavos inteiros.** Nunca `float`. Conversões só em `js/utils/money.js`.
2. **Saldo nunca é gravado.** É derivado das movimentações (`accountBalances`). Detalhes em [Núcleo financeiro](doc:nucleo-financeiro).
3. **Quem altera saldo é o servidor.** O navegador pede; o servidor valida, trava e grava (`/api/finance`). As Rules do Firestore **negam** a escrita direta de movimentos liquidados.
4. **Rules com schemas fechados.** Todo campo novo precisa entrar em `js/core/model/schemas.js`, em `firestore.rules` e em um teste de `tests/rules/`.
5. **`auditLog` é create-only.** Correção de lançamento liquidado é **estorno** (lançamento compensatório), nunca edição.
6. **Sem dependências novas** (inclusive bibliotecas por CDN) sem aprovação. O projeto não tem build.
7. **Segredos nunca no navegador.** A service account vive só em `FIREBASE_SERVICE_ACCOUNT` na Vercel.
8. **Branch de trabalho: `claude-dev`.** Qualquer ação em outras branches exige autorização explícita (ver `CLAUDE.md` §8).
9. **Valide em preview antes de produção**, principalmente mudanças de dependências do servidor (lição do `ERR_REQUIRE_ESM`, ver [Runbooks](doc:runbooks)).

## Glossário

| Termo | Significado |
|---|---|
| **Movimento liquidado** | Receita `received`, despesa `paid`, transferência `confirmed`, recebimento de devedor, aporte/resgate de meta, fatura `paid`. Só estes mudam saldo. |
| **Operação (op)** | Chamada ao servidor: `POST /api/finance` com `{ op, operationId, params }`. Lista completa em [Referência gerada](doc:referencia-gerada). |
| **`operationId`** | Chave de idempotência: repetir a mesma chave devolve o resultado guardado; reusar com outros parâmetros dá 409. |
| **Estorno** | Lançamento compensatório em `reversals`; o original é preservado. |
| **Claim `admin`** | Atributo do token de autenticação (`customAttributes`), definido só pelo servidor. Libera `/api/docs`, `/api/validation`, `/api/admin-claims` e a limpeza global. |
| **`ledgerSeq`** | Contador da conta incrementado em toda operação que altera saldo; serializa transações concorrentes. |
| **Fase / VF-xxx** | Identificadores das tarefas no `PLAN.md` (ex.: `VF-SEC-01`). |
| **Spark** | Plano gratuito do Firebase: cota diária do Firestore (50 mil leituras, 20 mil escritas, 20 mil exclusões). |
| **Preview** | Deploy automático de uma branch na Vercel, com URL própria. |

## Onde está o resto da documentação

- `README.md`: instalação, configuração do Firebase, modelo de dados, decisões e limitações.
- `docs/ARCHITECTURE.md`: camadas e regras de dependência.
- `PLAN.md`: estado operacional, histórico e tarefas (`VF-*`). É a memória do projeto: consulte antes de decidir algo e registre ali o que mudar.
- `CLAUDE.md`: regras permanentes de trabalho (leitura, arquitetura, Git, validação).
