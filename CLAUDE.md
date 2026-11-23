# CLAUDE.md — Regras permanentes do projeto

Projeto: **Vault Finance** — controle financeiro pessoal.
Este arquivo contém regras permanentes. O estado operacional vive em `PLAN.md`.

## Stack (conforme README.md e package.json)

- HTML5 + CSS3 + JavaScript ES Modules puro. Sem framework e sem build.
- Backend: Firebase Authentication (e-mail/senha) + Cloud Firestore. SDK v10 via CDN.
- Hospedagem estática: Vercel (`vercel.json`). Regras/índices: `firestore.rules`, `firestore.indexes.json`, `firebase.json`.
- Gerenciador de pacotes: **npm** (`package.json`, `package-lock.json`). `package.json` tem só devDependencies (emulador e testes).
- Dinheiro em centavos inteiros; datas em timestamp; saldo nunca é gravado (derivado).

### Estrutura (primeiro nível)

`index.html` (login) · `pages/` · `css/` · `js/` (`core` puro com `model/`, `firebase`, `services`, `components`, `modules`, `utils`) · `api/` + `server/` (funções Vercel/Admin SDK) · `docs/ARCHITECTURE.md` (camadas e regras de dependência) · `scripts/` · `tests/` (`model`, `services`, `rules`, `integration`, `e2e`) · `assets/` · `firestore.rules` · `firestore.indexes.json` · `firebase.json` · `vercel.json`

### Comandos declarados (package.json)

| Objetivo | Comando |
|---|---|
| Emuladores (Auth 9099, Firestore 8080, UI 4000) | `npm run emulators` |
| Testes das Security Rules (exige Java 11+ e Node 22+ — LTS) | `npm run test:rules` |
| Servir estático em :5500 | `npm run serve` |
| Deploy de regras/índices | `npx firebase deploy --only firestore:rules,firestore:indexes` (somente com autorização) |

Também declarados: `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run serve:api`. Não há script de build. Não invente comandos.

### Ignorar na leitura

`node_modules/`, `.git/`, `.firebase/`, `emulator-data/`, `coverage/`, `*.log`, `firebase-export-*.json`, `package-lock.json` (nunca ler inteiro), `assets/` (binários/imagens), `.env*` e credenciais.

## 1. Governança de leitura e economia de tokens

- Evite leitura em massa; explore somente arquivos relacionados à tarefa.
- Ignore os diretórios listados acima.
- Não leia lockfiles integralmente.
- Use `rg`/`grep` para localizar símbolos antes de abrir arquivos; prefira leitura por trechos (offset/limit).
- Não repita leituras sem necessidade. Não produza saídas extensas no terminal (use `head`, `-c`, `--stat`).
- Amplie a leitura quando necessário para entender dependências e impactos.
- Nunca sacrifique qualidade técnica para economizar tokens.

## 2. Preservação arquitetural

- Compreenda a implementação existente antes de modificar código.
- Reutilize componentes, serviços, funções e bibliotecas existentes (ex.: CRUD genérico em `js/services/firestore.js`, utilitários de dinheiro em `js/utils/money`).
- Preserve a separação: páginas montam o shell; módulos renderizam; services falam com o Firebase; utils não conhecem DOM nem rede.
- Preserve convenções de nomenclatura e padrões existentes.
- Não introduza dependências (incluindo libs via CDN) sem aprovação.
- Sem refatorações oportunistas; sem trocar funcionalidades por versões simplificadas.
- Não altere estruturas importantes sem justificativa técnica.
- Preserve compatibilidade: Rules com schemas fechados, centavos inteiros, saldo derivado, `auditLog` create-only.
- Alterações em `firestore.rules` exigem teste correspondente em `tests/rules/`.
- Nunca colocar service account, Admin SDK ou segredos no frontend.

## 3. Estilo de resposta

- Comunicação objetiva e técnica, sem introduções desnecessárias.
- Não reproduza arquivos inteiros no chat.
- Informe arquivos e linhas relevantes (`arquivo:linha`).
- Snippets pequenos somente quando indispensáveis.
- Prefira edição direta dos arquivos.

## 4. Planejamento persistente — PLAN.md

Ao receber pedido de análise, auditoria, diagnóstico ou planejamento:

1. Consulte `PLAN.md`, se existir.
2. Preserve histórico e IDs existentes.
3. Identifique o estado atual do projeto.
4. Registre novas descobertas.
5. Não duplique tarefas.
6. Não remova tarefas concluídas.
7. Mantenha rastreabilidade entre problemas, arquivos, tarefas e validações.

Estrutura do `PLAN.md`:

- **Diagnóstico** (máx. 5 linhas): propósito, stack, maturidade.
- **Gap Analysis**: funcionalidades ausentes, fluxos incompletos, segurança, falhas funcionais, falta de testes, problemas arquiteturais.
- **Débitos técnicos**: `[Impacto: Crítico/Alto/Médio/Baixo] arquivo:linha — Problema → Solução`.
- **Roadmap**: Fase 1 segurança/integridade/falhas críticas · Fase 2 funcionalidades incompletas e correções · Fase 3 arquitetura/qualidade/refatoração · Fase 4 testes/performance/otimização.

Cada tarefa: ID único, descrição, problema, solução proposta, arquivos, dependências, critério objetivo de conclusão.

## 5. Execução baseada em IDs

Ao executar uma tarefa:

1. Consulte o ID no `PLAN.md`.
2. Leia os arquivos relacionados.
3. Analise dependências.
4. Implemente somente o escopo solicitado.
5. Execute testes pertinentes.
6. Revise o diff.
7. Atualize o `PLAN.md`.
8. Marque como concluída somente após validação.

Não antecipe tarefas de outras fases.

## 6. Auditoria técnica e melhores práticas

Em review/auditoria completa, avalie (somente o aplicável à stack): arquitetura, separação de responsabilidades, acoplamento/coesão, legibilidade, duplicação, complexidade, segurança e controle de acesso, validação e tratamento de erros, integridade de dados, performance, testes, dependências, UI/acessibilidade/responsividade, build/deploy/configuração, documentação.

- Use documentação oficial (MDN, Firebase) e padrões reconhecidos como referência.
- Não proponha complexidade arquitetural nem reescrita sem benefício concreto.
- Para cada problema registre: severidade, evidência (arquivo:linha), problema, impacto, melhor prática, solução proposta.
- Diferencie: **comprovado**, **risco potencial**, **melhoria recomendada**, **não verificado**.

## 7. Validação e qualidade

- Use os comandos existentes do projeto (ver tabela acima); priorize testes direcionados.
- Não declare testes aprovados sem executá-los. Não esconda falhas. Não remova testes para contornar erros.
- Informe verificações não executadas.

## 8. Governança Git

- Execute `git status` antes de alterar e de commitar; preserve alterações preexistentes.
- Revise diffs; não inclua arquivos fora do escopo.
- Sem comandos destrutivos sem autorização.
- Branch de trabalho: usar **sempre e apenas** `claude`. Não criar, trocar nem enviar para outras branches (inclusive `bigboss`).
- Push para `origin claude` e abertura de Pull Requests (a partir de `claude`) estão autorizados sem pedir confirmação a cada vez.
- Sem reescrever histórico (rebase/force push/reset) sem autorização.

## 9. Continuidade e contexto

- `CLAUDE.md` = regras permanentes; `PLAN.md` = estado operacional.
- Não dependa só do histórico da conversa.
- Registre decisões arquiteturais importantes na documentação apropriada (README.md / PLAN.md).
- Use `/compact` quando necessário.
- Antes de recomendar `/clear`, garanta que o estado importante esteja persistido em arquivos.

**Regra fundamental:** leia pouco, mas leia o necessário para compreender corretamente o problema. Economia de tokens nunca compromete a qualidade.
