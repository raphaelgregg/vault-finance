---
title: Devedores, dívidas e recebimentos
category: Funcionalidades
tags: devedores, dívidas, parcelas, recebimento, quitação, lote, estorno
summary: Quem deve ao usuário — dívidas à vista e parceladas, recebimentos parciais, quitação em lote, cancelamento, reagendamento e extrato do mês.
files: js/modules/devedores.js, js/modules/devedores-parcelas.js, js/services/debtors.js, js/services/debtPayments.js, js/core/model/debtors.js, js/core/debtorReport.js, js/utils/pdf.js, server/finance/ops.mjs
page: devedores
---

# Devedores, dívidas e recebimentos

Rota `/devedores`. Quatro coleções trabalham juntas:

| Coleção | Papel | Escrita pelo cliente |
|---|---|---|
| `debtors` | Devedor: `name`, `loanDate`, `lentCents` (emprestado), `receivedCents`, `status` (`open`, `paid`, `cancelled`), `archived` | Cria/edita; **`receivedCents`, `status: paid` e `archived` só pelo servidor** |
| `debts` | **Parcelas** da dívida (`principalCents`, `dueDate`, `installmentNumber`/`installmentsTotal`, `debtGroupId`, `status`: `pending`, `paid`, `late`, `cancelled`) | Cria (sempre `pending`); **não atualiza** (pagar/cancelar é do servidor) |
| `debtPayments` | **Recebimentos** (imutáveis) | Negado; só o servidor |
| `cardPurchases` (com `debtorId`) | Compras no cartão vinculadas ao devedor, que também são "a receber" | Ver [Cartões](doc:cartoes) |

**Pendente = emprestado − recebido**, derivado e nunca gravado (`js/core/model/debtors.js`). "Atrasada" é **exibição derivada** (pendente com vencimento passado): o status gravado só muda por recebimento ou cancelamento.

## Criar dívida (`createDebtPlan`)

À vista (`installments` = 1) ou parcelada (N) em **um lote atômico** (`commitAtomic`): parcelas mensais no mesmo dia (com ajuste ao fim do mês), valores em centavos (a 1ª leva o resto da divisão), todas com o mesmo `debtGroupId`. O total soma ao `lentCents` do devedor e um devedor **quitado é reaberto** no mesmo lote. Não movimenta conta.

## Operações do servidor

| Operação | O que faz |
|---|---|
| `debt.receive` | Recebe **parte ou o total** de uma parcela (de `debts` ou de uma compra de cartão) em uma conta. Recusa excesso (`EXCEEDS_REMAINING`), devedor cancelado/arquivado e parcela já quitada. Aumenta o saldo da conta e o `receivedCents`. |
| `debt.settleBatch` | **Quitação em lote** retomável (por mês, por dívida ou todas), até 500 itens: uma transação **por parcela**, com documento de lote em `batches` e estado explícito; interrompido, retoma. |
| `debt.cancel`, `debt.cancelMany` | Cancela parcela(s) pendente(s) **sem recebimentos** e devolve o valor ao emprestado; `cancelMany` é **tudo ou nada** em uma transação. |
| `debt.reschedule` | Reagenda e/ou reajusta o valor de **uma** parcela sem recebimentos, ajustando `lentCents`. Usada pelas [Assinaturas](doc:assinaturas). |
| `debtor.archive`, `debtor.unarchive` | Arquivamento lógico (preserva histórico). |
| `debtor.delete` | Só **sem histórico** de dívidas/recebimentos. |
| `reversal.create` (kind `debtPayment`) | Estorna um recebimento. |

Idempotência por `operationId` em todas; o lote usa uma chave por item.

## Tela

`devedores.js` lista e edita devedores (com **fechamento do mês**: por devedor, as compras, parcelas e recebimentos do mês via `loadDebtorStatements`, em lotes de 30 devedores). `devedores-parcelas.js` é o modal de parcelas e recebimentos: registrar recebimento (parcial), quitar mês, cancelar várias, estornar.

## Exportar PDF das dívidas (VF-FEAT-01)

No modal de parcelas (`devedores-parcelas.js`) há dois botões na barra de ferramentas:

| Botão | O que gera |
|---|---|
| **PDF — \<mês\>** | As parcelas do mês de referência escolhido no filtro (sem filtro, o mês de fechamento): pagas, parciais e pendentes, com o **a receber no mês**. Dívidas contam pelo mês do vencimento; compras no cartão, pelo mês da fatura. |
| **PDF — total em aberto** | Tudo que ainda não foi recebido, de **todos os meses**, agrupado por mês com subtotal, mais emprestado, recebido e total em aberto do devedor. |

- **Mesmos números da tela:** o relatório usa as obrigações de `debtorObligations` (as da tabela), sem nova leitura e sem gravar nada. Parcelas **canceladas** não entram. "Atrasada" é derivada (pendente com vencimento anterior à emissão).
- **Modelo × desenho:** `buildDebtorReport` (`js/core/debtorReport.js`, puro) monta os dados e os textos formatados; `renderDebtorReportPdf` desenha o PDF (A4 retrato, várias páginas, cabeçalho da tabela repetido, rodapé "Página i de N"). Arquivo: `dividas-<nome>-<AAAA-MM>.pdf` ou `dividas-<nome>-em-aberto-<data>.pdf`.
- **Sem dependências:** `js/utils/pdf.js` é um gerador de PDF mínimo (como `js/utils/zip.js`): fontes padrão Helvetica e Helvetica-Bold, codificação WinAnsi (português completo, símbolos comuns; outros caracteres viram `?`), larguras das fontes embutidas no código. Todo o arquivo é ASCII, então os deslocamentos da tabela `xref` são exatos. O download usa um `Blob` e um link temporário, como nos CSV.
- **Desabilitado** quando os estornos não puderam ser lidos (modo limitado): os valores recebidos não seriam confiáveis.
- **Testes:** `tests/services/pdf.test.mjs` confere a **estrutura** do arquivo (cada `xref` aponta para o objeto certo, `/Length` confere); `tests/model/debtor-report.test.mjs` cobre mês, total em aberto, cartão, limite, vazio e paginação.
- Para **validar um PDF de verdade**, use `pdfinfo`, `pdftotext` e `pdftoppm -png` (poppler) ou o `pypdf` em modo estrito; nenhum deles é dependência do projeto.

## Armadilhas

- Cancelar para menos precisa devolver ao `lentCents`; o emprestado **nunca** pode ficar abaixo do já recebido.
- Recebimento em parcela de compra no cartão é independente do pagamento da fatura (fluxos separados).
- Conta de destino precisa estar ativa.
