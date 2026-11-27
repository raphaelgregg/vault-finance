# Vault

Repositório de integração e trabalho. O projeto principal desta branch é o **Vault Finance** — sistema de controle financeiro pessoal. A documentação completa segue abaixo.

---

# Vault Finance

Sistema de controle financeiro pessoal em **HTML5 + CSS3 + JavaScript (ES Modules) puro**, com
**Firebase Authentication** e **Cloud Firestore** como backend. Sem framework, sem build
obrigatório. Operações que movem dinheiro (transferências, liquidação de receitas/despesas, pagamento de fatura, aportes
em metas, recebimentos de devedores, estornos) são processadas por uma **função de servidor** na Vercel
(`POST /api/finance`, Firebase Admin SDK + transações + idempotência — ver seção 6); o restante é estático (Vercel Hobby).

> **Estado atual: módulos financeiros entregues (etapa 2 do `PLAN.md`).** Bancos, receitas,
> despesas, transferências, categorias, assinaturas, devedores (parcelas e recebimentos), metas,
> cartões (compras parceladas e faturas), orçamentos, dashboard e relatórios têm service, regras
> de negócio testadas e interface. Pendências e limitações conhecidas estão em `PLAN.md` e na seção 8.

---

## 1. O que já funciona

| Item | Estado |
|---|---|
| Login, cadastro, logout, recuperação de senha | ✅ Firebase Auth e-mail/senha |
| Guarda de sessão, layout responsivo, tema claro/escuro persistido na conta | ✅ |
| Contas, categorias, receitas, despesas, transferências | ✅ CRUD + auditoria + exclusão segura (vínculos) |
| Assinaturas (pausar/retomar/cancelar, avanço de cobrança) | ✅ service + UI (o avanço de cobrança ainda não tem botão na UI) |
| Devedores, parcelas e recebimentos | ✅ recebimento atômico (lote): recebimento + parcela + devedor + auditoria; **exportação em PDF** das dívidas do mês ou do total em aberto (VF-FEAT-01) |
| Metas e movimentações (aporte/resgate) | ✅ valor guardado derivado; conclusão/reativação atômicas |
| Cartões, compras parceladas e faturas | ✅ limite derivado; fechar/pagar fatura (ver limitações) |
| Orçamentos por categoria/mês | ✅ gasto derivado das despesas do mês |
| Dashboard e relatórios (período, categorias, CSV) | ✅ somente leitura, leituras limitadas |
| Security Rules + testes no emulador | ✅ 112 testes |
| Testes unitários (modelo + services) | ✅ 645 testes |
| Testes de integração (camada confiável, Emulator) | ✅ 122 testes |
| Lint sem dependências, CI (GitHub Actions), E2E Playwright | ✅ ver seção 3 (CI e E2E não executados no GitHub) |

**Nada é inventado na tela:** com o banco vazio, indicadores mostram zeros/`—` e as listas exibem
estado vazio. Não há dados DEMO. Saldo, limites, gasto de orçamento, valor guardado e totais de
fatura aberta são **derivados**, nunca gravados.

---

## 2. Pré-requisitos

- Node.js 24+ (LTS; só para o emulador e testes; a aplicação não precisa de build). O CI roda 24 e 26 (as duas LTS mais
  novas). Node 22 e 18 não são suportados: o 18 está fora de vida (e sem `crypto` global em ESM) e o 22 saiu da matriz.
- Java 11+ (emulador do Firestore, usado por `npm run test:rules`).
- Java 11+ (exigido pelo emulador do Firestore).
- Conta Google para criar o projeto no Firebase (plano **Spark**, gratuito).

---

## 3. Configurar o Firebase

**Configuração já preenchida** (projeto `vault-finance-d1603`, plano Spark, região `nam5`,
Authentication por e-mail/senha habilitado): os valores estão em
[`js/firebase/config.js`](js/firebase/config.js). Para trocar de projeto, edite esse arquivo.

> A `apiKey` do Firebase **não é uma credencial administrativa**: ela é pública por design.
> A segurança vem das Security Rules e do Authentication. Nunca coloque service account,
> Admin SDK ou chave privada no frontend — este projeto não usa nenhum.

### Modo DEMO vs Firebase real (alternância explícita)

- `?mode=demo` na primeira página — força o modo DEMO contra os emuladores locais
  (dados fictícios, nada alcança a nuvem). A escolha fica ativa em toda a navegação da aba.
- `?mode=firebase` — força a config real mesmo em localhost.
- Sem parâmetro (automático) — em localhost usa DEMO apenas enquanto a config for
  placeholder; com a config real preenchida, usa o Firebase de verdade.
- `?emulator=0` continua desligando os emuladores em localhost.

### Publicar as Security Rules e índices (produção)

```bash
npm install
npx firebase login               # ou: firebase login:ci para gerar um token
npx firebase use --add           # selecione o projeto vault-finance-d1603
npx firebase deploy --only firestore:rules,firestore:indexes
```

Alternativa sem login interativo:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes \
  --token "SEU_TOKEN_DO_FIREBASE_LOGIN_CI" --project vault-finance-d1603
```

> O projeto novo nasce com as regras padrão do Firebase, que **negam toda escrita**
> (`Missing or insufficient permissions`). A aplicação só persiste dados depois de
> publicar `firestore.rules`.

#### Sintoma: "leitura negada pelas regras publicadas" (Dashboard, Bancos, Transferências, Devedores, Metas)

Significa que as Rules **publicadas** no Firebase são anteriores à VF-ARQ-02 e não têm `match /users/{userId}/reversals/{reversalId}`
(leitura do dono). Sem ela, o navegador não consegue ler estornos e, **de propósito**, não exibe saldo, fechamento nem guardado de metas
(estorno pode existir sem que o app consiga vê-lo). O `firestore.rules` do repositório já contém a regra; falta publicar.

1. Publicar (autorização do dono do projeto): os comandos acima (`firestore:rules,firestore:indexes`). Ordem segura: **Rules primeiro**, depois
   a função de servidor (`/api/finance`) — o inverso cria estornos que o navegador ainda não lê.
2. Alternativa pelo Console: Firebase Console → Firestore Database → **Regras** → colar o conteúdo de `firestore.rules` → **Publicar**.
3. Conferir: Console → Firestore → Regras mostra a data/hora da publicação e o texto contendo `reversals`. Depois, recarregue as telas
   (Ctrl+F5) e confira que os avisos sumiram.
4. Reproduzir o sintoma localmente sem tocar em produção: `node tests/e2e/all-pages.mjs` (roda todas as telas com as Rules do repositório e
   com as Rules antigas de `tests/fixtures/firestore.rules.legacy`).

### Rodar localmente

```bash
npm install
npm run emulators     # Auth 9099 + Firestore 8080 + UI 4000
npm run serve         # estático em http://localhost:5500 (ou use a extensão Live Server)
```

Abrindo em `localhost` com `?mode=demo`, o app conecta aos emuladores
(`js/firebase/client.js`). Sem o parâmetro e com a config real preenchida, ele usa o
Firebase real.

### Testes e qualidade

| Comando | O que faz |
|---|---|
| `npm run test:unit` | modelo, agregações e services com `io` injetado (sem rede) — 645 testes |
| `npm run test:rules` | sobe Auth+Firestore no emulador e roda `tests/rules/` — 112 testes |
| `npm run lint` | sintaxe, espaços, `console.log`, imports não usados, JSON (sem dependências) |
| `npm run test:integration` | integração com o Firestore Emulator, sem mocks de transação: camada confiável (`server-*.test.mjs`: transferências, recebimentos, lote retomável, despesas/receitas/faturas/metas, estornos, contas/devedores arquivados, segurança com ID tokens reais), services → servidor (`service-bridge`), consistência de saldos/dashboard/previsão contra oráculo independente, leitura de estornos (`reversals-visibility`) — `tests/integration/` — 122 testes |
| `npm run serve:api` | servidor local: estático + `POST /api/finance` (mesmo handler da Vercel) contra os emuladores — `scripts/dev-server.mjs` |
| `npm run test:e2e` | Playwright em Chromium contra os emuladores: `flows.mjs` (cadastro, orçamentos, metas, cartões, devedores, dashboard, relatórios, configurações) e `movements.mjs` (bancos, receitas, despesas, transferências: CRUD, filtros, paginação, ordenação, saldo derivado), além de `debtors`, `maintenance`, `maintenance-inventory` (inventário de controles de Manutenção: 41 comuns / 64 admin), `validation-center`, `auth`, `csv`, `reversals-visibility` (transferências/devedores/metas com leitura de estornos negada ou offline) e `balances-reversals` (Bancos e Dashboard: saldo nunca exibido sem a leitura dos estornos) |

O E2E **não** adiciona dependência ao projeto: usa o `playwright` já instalado no ambiente e, sem
ele, sai com aviso. O harness serve o SDK do Firebase a partir de `node_modules` (a CDN pode estar
bloqueada) e remove o SRI do import map só durante o teste. `E2E_SCREENSHOTS=<pasta>` salva capturas.
O workflow `.github/workflows/ci.yml` roda lint, unit e Rules (Node 24 e 26, LTS); E2E fica fora do CI.

---

## 4. Estrutura

```text
./
├── index.html                  # login / cadastro / recuperação de senha
├── pages/                      # uma página por módulo (casca + módulo JS)
├── css/
│   ├── main.css                # importa os demais
│   ├── variables.css           # tokens: cor, espaço, tipografia, tema escuro
│   ├── layout.css              # shell, sidebar, topbar, responsivo
│   └── components.css          # botões, cards, tabela, modal, formulários, vazio
├── js/
│   ├── app.js                  # entrada das páginas internas
│   ├── auth-page.js            # entrada da tela de login
│   ├── core/                   # domínio PURO (sem DOM/rede): model.js (barrel) + model/ (schemas, validation, ledger, subscriptions, debtors, goals, cards), aggregates.js, forecast.js, integrity.js, importSchema.js; guard.js (sessão)
│   ├── firebase/               # config.js (placeholders), client.js (SDK + emuladores)
│   ├── services/               # firestore.js (CRUD, lote atômico, auditoria) + um service por módulo
│   ├── components/             # dom.js (el/$/toast), sidebar, topbar, tema, modal, form-kit (formulários/dataTable), table-tools (ordenação e filtro de tabelas)
│   ├── modules/                # um módulo por página (+ devedores-parcelas.js); contrato: render(container, { user, signal })
│   └── utils/                  # constants, money (centavos: parse/format), dates, csv, zip, pdf, nav… (puros)
├── api/                        # funções Vercel (finance, validation, admin-claims): só adaptam req/res
├── server/                     # lógica de servidor (Admin SDK): finance/, validation/, admin/
├── tests/                      # model/, services/ (unit), rules/, integration/ (emulador), e2e/ (Playwright)
├── docs/ARCHITECTURE.md        # camadas, regras de dependência e contratos
├── scripts/lint.mjs            # lint sem dependências
├── .github/workflows/ci.yml    # CI (lint, unit, Rules)
├── firestore.rules
├── firestore.indexes.json
├── firebase.json               # emuladores Auth + Firestore
├── vercel.json                 # rotas limpas + cabeçalhos de segurança
└── README.md
```

Separação de responsabilidades: **páginas** só montam o shell; **módulos** renderizam;
**services** falam com o Firebase; **utils** e **core** não conhecem DOM nem rede.
Detalhes, regras de dependência e contratos: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 5. Modelo de dados (Firestore)

Tudo sob `users/{userId}/`. O `userId` é o `uid` do Firebase Auth — é isso que garante o
isolamento nas Rules.

| Coleção | Papel | Campos obrigatórios (resumo) |
|---|---|---|
| `profile/main` | perfil | `name`, `email`, `currency`, `locale` |
| `settings/main` | preferências | `theme` (light/dark/system) |
| `accounts` | contas | `institution`, `name`, `type`, `initialBalanceCents`, `color`, `status` |
| `categories` | categorias | `name`, `kind` (income/expense/both), `color` |
| `incomes` | receitas | `description`, `categoryId`, `amountCents`, `expectedDate`, `accountId`, `status`, `recurrence` |
| `expenses` | despesas | `description`, `categoryId`, `amountCents`, `accountId`, `purchaseDate`, `dueDate`, `status`, `recurrence` |
| `transfers` | transferências | `fromAccountId`, `toAccountId`, `amountCents`, `date`, `reason`, `status` |
| `subscriptions` | assinaturas | `name`, `amountCents`, `periodicity`, `nextChargeDate`, `categoryId`, `status` (opcionais: `accountId`, `cardId`, `debtorId`, `chargeDay` = dia 29–31 original da cobrança) |
| `debtors` | devedores | `name`, `loanDate`, `lentCents`, `receivedCents`, `status` |
| `debts` | parcelas de dívida | `debtorId`, `description`, `principalCents`, `dueDate`, `installmentNumber`, `status` |
| `debtPayments` | recebimentos | `debtId`, `debtorId`, `amountCents`, `date`, `accountId` |
| `goals` | metas | `name`, `targetCents`, `status` (`deadline` e `accountId` opcionais) |
| `goalTransactions` | aportes/resgates | `goalId`, `type` (deposit/withdraw), `amountCents`, `date`, `accountId` |
| `creditCards` | cartões | `name`, `brand`, `limitCents`, `closingDay`, `dueDay`, `status` |
| `cardPurchases` | compras | `cardId`, `description`, `amountCents`, `purchaseDate`, `installmentsTotal`, `installmentNumber` |
| `invoices` | faturas | `cardId`, `referenceMonth` (`YYYY-MM`), `dueDate`, `status` |
| `budgets` | orçamentos | `categoryId`, `month` (`YYYY-MM`), `limitCents` |
| `auditLog` | auditoria | `action`, `entity`, `entityId`, `actorUid` — **create-only** |

**Regras de representação**

- Dinheiro em **centavos inteiros** (`is int` nas Rules). Movimentações exigem `> 0`; saldos
  iniciais e limites aceitam `0`.
- Datas em **timestamp** do Firestore.
- **Saldo nunca é gravado.** É sempre derivado de `initialBalanceCents` + movimentações
  confirmadas (decisão rev. 3). Cache, se houver, só no cliente e sempre revalidado.
- Campos fechados: qualquer campo fora da lista da coleção é **negado** pelas Rules —
  inclusive tentativas de gravar `saldo`/`balance` em `accounts`.
- Referências são **IDs de documentos** da própria árvore do usuário; as Rules validam
  existência real com `exists()` (custo: 1 leitura por referência validada na escrita).

---

## 6. Segurança

### Camada financeira confiável (VF-ARQ-02)

- **Por quê:** Security Rules + JavaScript no navegador não garantem saldo não negativo sob concorrência, idempotência,
  soma por parcela nem atomicidade de lotes. Toda operação que **move dinheiro** passou para `POST /api/finance`
  (`api/finance.mjs` → `server/finance/`), que usa o Firebase Admin SDK (a credencial `FIREBASE_SERVICE_ACCOUNT` vive só
  na Vercel) e **transações do Firestore**. O navegador nunca recebe credencial administrativa.
- **Cada chamada:** `Authorization: Bearer <Firebase ID token>`; `{ op, operationId, params }`. O servidor valida o token,
  usa o `uid` do token (nunca do corpo), valida parâmetros (centavos inteiros), confere propriedade de contas/parcelas/devedores
  e **lê o estado atual dentro da transação** (saldo, restante da parcela, status) — jamais confia em saldo/total/status
  enviado pelo cliente. Erros reais voltam à tela (`INSUFFICIENT_BALANCE`, `EXCEEDS_REMAINING`, `ALREADY_REVERSED`…).
- **Idempotência:** o cliente gera um `operationId` ao abrir o formulário e o reaproveita em retry/duplo clique/timeout;
  mesma chave + mesmos parâmetros devolve o resultado original sem repetir; chave reutilizada com outros parâmetros → `409`.
- **Correções = estorno:** lançamento liquidado (receita recebida, despesa paga, transferência confirmada, fatura paga,
  recebimento de devedor, movimento de meta) é imutável; o botão "Estornar" cria um lançamento compensatório com motivo,
  preserva o original, não pode ser repetido e ajusta saldos atomicamente.
- **Lote:** quitar um mês/dívida com muitas parcelas é um lote retomável (estado em `batches/{id}`; cada parcela é uma
  transação). Não há atomicidade global: consistência por parcela + estado explícito (`completed`/`partial_failed`).
- **Rules:** o navegador só lê os próprios dados e grava o que não move saldo; escritas protegidas são negadas (testes em
  `tests/rules`). Contas e devedores com histórico são **arquivados** (nunca apagados fisicamente).
- **Leitura de estornos nunca presumida (VF-COR-01/02):** o servidor pode criar estornos que o navegador ainda não consegue ler
  (Rules publicadas sem a coleção `reversals`). `permission-denied` ou falha de conexão significam **desconhecido**, nunca
  "sem estornos" (`js/utils/reversalsAccess.js`: modo estrito por padrão; modo limitado só onde sinalizado na tela).
  **Bancos** e **Dashboard** não exibem saldo, resultado nem previsão sem a leitura completa: mostram "—", um aviso explícito
  (leitura negada × erro de conexão) e "Tentar novamente"; um saldo anterior não permanece na tela após falha de recálculo.
  O "Saldo total" de Bancos é só o derivado das movimentações (nunca a soma dos saldos de abertura).
  **Publique as Rules (`firestore.rules`) antes/junto da função de servidor**, senão essas telas ficam indisponíveis.
- **Desenvolvimento local:** `npm run emulators` + `npm run serve:api` (estático + `/api/finance` contra os emuladores,
  sem credencial). `npm run serve` (somente estático) não tem a API.

- Negação padrão (`match /{document=**} { allow read, write: if false; }`).
- Isolamento por usuário em todos os `match`.
- `auditLog` sem `update` e sem `delete`.
- `createdAt`/`updatedAt` só podem vir do servidor (`request.time`), e `createdAt` é imutável.
- Nenhuma credencial administrativa no cliente; a config web é pública por design.
- Cabeçalhos em `vercel.json`: `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`,
  `Permissions-Policy`.
- **Limitação conhecida:** o Firebase Auth usa a chave pública do projeto; abuso de cadastro
  deve ser contido por cotas e, se necessário, App Check (Fase 6).

### Administradores (claim `admin`) e a função de servidor

- Administrador = custom claim de token `admin == true`. **O cliente nunca grava claims**: só a função da Vercel
  `POST /api/admin-claims` (`api/admin-claims.mjs` → `server/admin/claims.mjs`) altera, e só a pedido de quem já é
  administrador (validado no servidor pelo estado atual da conta, não só pelo token). Sem dependências: usa a API
  administrativa do Identity Toolkit com uma service account.
- Configuração (uma vez, fora do repositório): na Vercel → Settings → Environment Variables, crie
  `FIREBASE_SERVICE_ACCOUNT` com o JSON da service account do projeto (**secreta**, apenas Production/Preview; nunca
  `NEXT_PUBLIC_*`, nunca no frontend). Aceita JSON puro, JSON entre aspas ou base64; `private_key` com `\n` literal é
  normalizada. A conta precisa do papel **Firebase Authentication Admin** (ou equivalente). Erros de configuração NÃO
  são 401: sem a variável → `501 not_configured`; formato inválido → `500 bad_service_account`; Google recusou a
  credencial → `502 server_credential_failed` (o motivo técnico, sem segredos, vai para os logs da função na Vercel).
- **Por que o token é validado localmente:** a chave de API web é restrita por referenciador HTTP no Google Cloud; chamadas
  de servidor (sem `Referer`) seriam recusadas e davam `401` mesmo com sessão válida. O servidor verifica o ID token
  (RS256, chaves públicas do Google) e lê a claim ATUAL pela API administrativa — sem usar a chave de API.
- `GET /api/admin-claims` lista usuários (uid, e-mail, nome, desativado, `admin`) para administradores; a tela
  `/manutencao-dados` mostra a lista com ação rápida de promover/revogar.
- **Primeiro administrador (bootstrap):** ninguém pode se auto-promover; defina a claim do primeiro uma única vez
  pelo Admin SDK (`setCustomUserClaims(uid, { admin: true })`). Depois, administradores promovem/revogam outros em
  `/manutencao-dados` (por uid ou e-mail). O usuário promovido precisa sair e entrar de novo (o token atual vale até 1 h);
  uma revogação também só vale por completo quando o token antigo expira.
- Cada promoção/revogação é registrada no `auditLog` do administrador que executou.

### Cotas do plano gratuito (Spark) — valores de referência

| Serviço | Cota gratuita diária (referência) |
|---|---|
| Firestore — leituras | 50.000/dia |
| Firestore — escritas | 20.000/dia |
| Firestore — exclusões | 20.000/dia |
| Firestore — armazenamento | 1 GiB |
| Authentication | 50.000 MAU (e-mail/senha) |
| Hosting (não usado aqui) | 10 GB/mês |

Os números podem mudar; **confira a página oficial de preços antes de confiar neles**.
O projeto não habilita nada fora do Spark e não faz chamadas pagas.

---

## 7. Decisões técnicas

1. **ES Modules nativos + SDK do Firebase v10 via CDN** — zero build, deploy estático.
2. **Auditoria e CRUD por helpers** (`createAudited`/`updateAudited`/`removeAudited`) com `io`
   injetável; operações multi-documento usam `commitAtomic` (lote Firestore com auditoria no
   mesmo lote).
3. **Rules com schemas fechados por coleção** — impedem campos inventados (ex.: snapshot de saldo).
   Saldos, limites, gasto de orçamento, valor guardado de metas e totais de fatura aberta são derivados.
4. **`exists()` nas referências (decisão mantida).** Dá integridade referencial real, custa 1 leitura
   por referência, mas **não enxerga documentos criados no mesmo lote**. Efeito: parcela de cartão não
   pode referenciar fatura criada no mesmo lote — a compra grava **dois lotes** (1º faturas novas,
   2º parcelas), cada um atômico; se o 2º falhar sobram faturas abertas vazias, reaproveitadas na
   próxima compra (ID determinístico `cardId_AAAA-MM`). Alternativa avaliada: `existsAfter()` nas
   Rules (um só lote). **Não adotada** porque exige republicar as Rules em produção e revisar todas as
   referências (`ref()`/`optionalRef()`) — decisão de segurança que depende de aprovação. O contrato
   atual está documentado por teste em `tests/rules/`. Se adotada no futuro, o service volta a um lote.
5. **Datas** em campos `date`/`*Date` são Timestamp em **meio-dia UTC** (o dia de calendário não
   desloca em nenhum fuso); filtros por data em `where` convertem a string ISO do mesmo modo.
6. **Sem dependências novas sem aprovação** (nem libs via CDN): gráficos são barras CSS, CSV, ZIP e **PDF**
   são gerados no cliente por código próprio (`js/utils/csv.js`, `zip.js`, `pdf.js`), lint é um script próprio,
   E2E reaproveita o Playwright do ambiente.
7. **Navegação sem recarregar (VF-PERF-02):** depois da primeira página, os links internos trocam só o conteúdo (`js/app.js` + `js/components/page-host.js`); cada página segue sendo um HTML (carga direta, F5). Contrato das páginas: `render(container, { user, signal })`. Ver o playbook (Arquitetura).
8. **Sem botão sem implementação** — a busca global ainda não existe e avisa isso. A exportação em PDF existe só para as dívidas de um devedor.

---

## 7.5 Playbook de manutenção

Guia para quem mantém o sistema, em `docs/playbook/` (Markdown): arquitetura, operação e deploy, segurança, testes, runbooks e uma ficha por funcionalidade, mais uma **referência gerada do código**. Administradores o leem na página `/playbook` (busca, filtros e sumário; link em *Configurações*), servida por `GET /api/docs`. É atualizado automaticamente: `npm run docs:build` regenera, os testes bloqueiam defasagem e a Action `playbook.yml` comita a parte gerada na `claude-dev`. Detalhes dentro do próprio playbook, em "Atualização automática".

## 8. Limitações e pendências

- **Config real do Firebase** precisa estar em `js/firebase/config.js`; as Rules/índices do repositório
  precisam ser publicadas manualmente (`firebase deploy --only firestore:rules,firestore:indexes`,
  somente com autorização). Não verificado: Rules em produção, deploy/preview na Vercel.
- **Leituras (cota Spark):** receitas, despesas e transferências carregam **100 por página** (cursor por
  documento, mais recentes primeiro; 101 leituras na 1ª página e +1 de cursor nas seguintes) e mostram
  "Carregar mais antigas" com aviso de que filtros, meses e totais valem só para o carregado. Bancos lista
  até 200 contas e calcula o saldo atual **sob demanda** (botão; lê até 1000 movimentos realizados por tipo
  e avisa se atingir o teto). Dashboard, relatórios e orçamentos têm teto próprio e avisam. Recarregar
  após criar/editar volta à primeira página. Não medido em produção; índices compostos já declarados
  (`firestore.indexes.json`) só valem após publicar.
- **Cartões:** pagar fatura não movimenta conta (o schema `invoices` não tem `accountId`) e é sempre
  integral; não há cancelamento de fatura; parcelas de uma compra não têm `installmentGroupId` (o
  schema `cardPurchases` não o aceita) e são identificadas por cartão + descrição + data + total.
- **Concorrência:** saldos, recebimentos, pagamentos e aportes são decididos por transação no servidor (seção 6). Ainda
  valem a leitura prévia + escrita em lote do cliente para limite de cartão e unicidade de orçamento por categoria/mês
  (abas simultâneas podem violá-los). O saldo é recalculado por varredura dentro da transação (teto de 5.000 movimentos
  por coleção; acima disso a operação falha fechada).
- Lançamentos liquidados são imutáveis: correção por estorno (um por lançamento); orçamentos consideram só
  despesas (compras no cartão não entram).
- Backup do Firestore **não é automático no plano gratuito**; exportação completa por usuário ainda
  não existe. Não presuma backup gerenciado.
- Exportação PDF existe **só** para as dívidas de um devedor (*Devedores → parcelas*: do mês ou total em aberto); relatórios gerais exportam apenas CSV. Importação/exportação CSV de dados existe em `/manutencao-dados` (qualquer usuário
  autenticado, SEMPRE só o próprio `uid`, mesmo sendo administrador): por entidade (11) ou **CSV unificado** com a
  coluna `entidade` (modelo, base populada e importação em 1 arquivo). A importação processa na ordem de dependência
  (contas → categorias → cartões → devedores → demais), é **idempotente** (chave determinística por entidade; reimportar
  não duplica; campos diferentes de contas/categorias/cartões/devedores/metas são mesclados) e reporta criados,
  atualizados, ignorados por duplicidade e falhas. Exportação CSV também existe nos relatórios.
- O tema é aplicado por JS após o carregamento; pode haver um flash breve de tema claro.

---

## 9. Roadmap

O estado operacional e os IDs (`VF-<fase>-<nn>`) vivem em `PLAN.md`. Próximos: importação
CSV/exportação completa/backup, publicação (GitHub + Vercel), App Check e documentação operacional.
