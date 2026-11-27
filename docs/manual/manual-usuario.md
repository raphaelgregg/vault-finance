---
title: "Vault Finance — Manual do usuário"
subtitle: "Como usar o sistema e como as operações funcionam e se conversam"
lang: pt-BR
---

# 1. Para que serve o Vault Finance

O Vault Finance é um controle financeiro pessoal. Ele responde, em poucos toques, a perguntas como:

- **Quanto eu tenho hoje** nas minhas contas?
- **O que entrou e o que saiu** neste mês? O que ainda vai entrar e sair?
- **Quanto devo de cartão** e **quanto tenho a receber** de quem me deve?
- Estou **dentro do orçamento**? Estou chegando na minha **meta**?

Tudo é seu: cada pessoa só enxerga os próprios dados.

## As três ideias que explicam o sistema inteiro

1. **Seu saldo nunca é digitado.** O saldo de uma conta é *calculado* somando o saldo inicial, o que foi recebido, o que foi pago, as transferências e os demais movimentos. Por isso ele sempre bate com o histórico.
2. **Previsto não mexe no saldo; realizado mexe.** Uma receita "prevista" ou uma despesa "pendente" é só um aviso. O dinheiro só se move quando você marca como **recebida** ou **paga**.
3. **O que já aconteceu não se apaga — se estorna.** Um lançamento recebido ou pago não pode ser editado nem excluído. Se errou, você faz um **estorno** (um lançamento que desfaz o anterior, com um motivo). Assim o histórico fica confiável.

# 2. Primeiros passos

## Criar a conta e entrar

Na tela inicial há três abas: **Entrar**, **Criar conta** e **Esqueci a senha**.

- A senha precisa ter **no mínimo 10 caracteres**.
- Ao criar a conta, você recebe um e-mail de verificação. Confirme o link; se não chegar, peça o reenvio em *Configurações → Segurança — e-mail*.
- A sessão fica aberta mesmo ao fechar o navegador. Use **Sair** (ícone no topo) em computadores compartilhados.

## Uma configuração inicial em 5 minutos

Siga esta ordem; cada passo prepara o próximo:

| Passo | Onde | O que fazer |
|---|---|---|
| 1 | **Bancos** | Cadastre suas contas (corrente, poupança, carteira…) com o **saldo inicial** de hoje. |
| 2 | **Categorias** | Crie categorias de receita (Salário…) e de despesa (Mercado, Moradia…). |
| 3 | **Receitas / Despesas** | Comece a lançar o que entra e o que sai. |
| 4 | **Cartões** | Cadastre cartões (limite, dia de fechamento e de vencimento). |
| 5 | **Orçamentos, Metas, Assinaturas, Devedores** | Quando precisar. |

## Navegando

- **Computador:** menu lateral com todas as áreas.
- **Celular:** barra inferior com **Início**, o botão **Lançar** (+), **Cartões** e **Mais**.
- As páginas trocam **sem recarregar**. Passe o mouse ou toque num item e ele já começa a abrir.
- Em *Configurações* você escolhe o **tema** (claro, escuro ou do aparelho) e pode **ocultar valores** na tela.

# 3. Cada área do sistema

## Dashboard — a visão geral

Só leitura. Mostra, para o **período** que você escolher (mês, semestre, ano ou tudo):

- **Saldo total** das contas hoje.
- **Resultado do período** (recebido − pago), as **faturas a pagar**, o **a receber de devedores** e a **posição líquida** (saldo + a receber − faturas).
- **Entradas e saídas do período**, em três linhas:

| Linha | Significado |
|---|---|
| **Realizado** | O que já foi recebido e pago no período. |
| **Pendente** | O que ainda vai ser recebido (a receber) e pago (a pagar) com data no período. |
| **Total do período** | Realizado + pendente = o **previsto** do período. |

> **Dica:** num mês futuro nada foi realizado ainda; você verá só o pendente e o total previsto.

- **Pontos de atenção** (despesas vencidas, orçamentos estourados, cartão no limite), **previsão do mês** e **próximos vencimentos**.

## Bancos — suas contas

Cadastre contas com instituição, tipo, cor e **saldo inicial**. O **saldo atual** é calculado ao tocar no botão de atualizar (poupa leituras do sistema).

- **Ajustar saldo:** informe o saldo real de hoje; o sistema corrige o *saldo de abertura* sem mexer nos seus lançamentos.
- **Arquivar:** a conta deixa de receber lançamentos, mas o histórico fica.
- **Excluir:** só é possível para contas **sem nenhum histórico**.

## Categorias

Servem para organizar receitas, despesas e orçamentos. Cada categoria é de **receita**, **despesa** ou **ambas**. Uma categoria **em uso não pode ser excluída**; o sistema avisa onde ela é usada.

## Receitas — o que entra

Ciclo de vida:

```
  Prevista  ───►  Recebida  ───►  (se errou) Estornada
     │
     └──► Cancelada / Editada / Excluída   (só enquanto não recebida)
```

- No topo da página há o **Resumo do mês selecionado**: **Previsto**, **Recebido** e **A receber** (com o valor em atraso). Escolha outro mês no filtro e o resumo acompanha.
- Use os filtros de **status**, **mês** e **categoria**; clique nos títulos das colunas para ordenar.
- Para confirmar que o dinheiro entrou, use **Marcar como recebida** e escolha a conta que recebeu.

## Despesas — o que sai

Funciona como receitas, com o sinal invertido: **Pendente → Paga → (estorno)**.

- O **Resumo do mês** mostra **Previsto**, **Pago** e **A pagar** (com o valor em atraso).
- Ao **pagar**, o sistema confere se a conta tem saldo. Sem saldo suficiente, o pagamento é recusado de propósito, com os valores na mensagem.
- Compras no cartão **não são despesas**: veja a seção *Cartões*.

## Transferências — entre suas contas e metas

Move dinheiro de uma conta para outra (ou para/da uma **meta**). Uma transferência **pendente** não move nada; ao **confirmar**, sai da origem e entra no destino ao mesmo tempo. Se algo falhar no meio, **nada** é alterado.

## Orçamentos

Defina um **limite por categoria e por mês**. O gasto é calculado sozinho a partir das despesas daquele mês (por data de vencimento, sem contar canceladas). O Dashboard avisa quando um orçamento estoura.

## Cartões de crédito

- Cadastre o cartão com **limite**, **dia de fechamento** e **dia de vencimento**.
- Cada **compra** entra na fatura do seu mês. Compras feitas **depois do fechamento** vão para a fatura seguinte. Compras **parceladas** (até 48x) geram uma parcela por fatura.
- A fatura passa por **aberta → fechada → paga**. O **limite usado** é calculado sozinho.
- **O saldo da conta só diminui quando você paga a fatura** (pagamento integral, escolhendo a conta). Isso evita contar a mesma compra duas vezes.

## Assinaturas

Cadastre serviços recorrentes (mensal, semanal, anual). Ao **registrar a cobrança**, o sistema lança só a cobrança da data atual e avança a próxima data:

- **Com cartão:** vira uma parcela na fatura aberta.
- **Vinculada a um devedor:** vira uma dívida dele (útil para dividir uma assinatura).
- **Sem cartão nem devedor:** só avança a data.

## Devedores — quem me deve

Cadastre quem lhe deve dinheiro e crie **dívidas** (à vista ou parceladas). Você registra **recebimentos** (parciais ou totais) numa conta sua.

- **Pendente = emprestado − recebido** (calculado).
- **Quitar o mês** de uma vez, **cancelar** várias parcelas e **estornar** um recebimento errado.
- **Fechamento do mês:** para cada devedor, mostra compras de cartão vinculadas, parcelas e recebimentos do mês.
- **Exportar PDF:** gera um documento com as dívidas **do mês** ou **todas em aberto** de um devedor, pronto para enviar a ele.

## Metas

Guarde dinheiro para um objetivo. **Aportar** tira da conta e soma na meta; **resgatar** faz o caminho inverso. Uma meta **vinculada a uma conta** acompanha o saldo dessa conta (aportes manuais não se aplicam). Metas com movimentos não podem ser excluídas: **cancele-as** para manter o histórico.

## Relatórios

Compare receitas e despesas **realizadas** por mês (até 24 meses) e por categoria, e **exporte em CSV** para abrir no Excel.

## Manutenção de dados

Em *Configurações → Abrir manutenção de dados*:

- **Exportar** seus dados (CSV por tipo ou um ZIP com tudo). **É o seu backup — exporte antes de qualquer limpeza.**
- **Importar** CSV: primeiro uma **simulação** que mostra o que seria criado, repetido ou com erro; só depois você aplica.
- **Apagar meus dados:** exige digitar uma frase de confirmação e um login recente. Não há como desfazer.

# 4. Como as operações funcionam e se comunicam

## O mapa: de onde vem cada número

```
   CADASTROS                     MOVIMENTOS                      RESULTADOS (calculados)
 ┌──────────────┐          ┌─────────────────────┐          ┌─────────────────────────┐
 │ Bancos       │─────────►│ Receitas recebidas  │─────────►│ Saldo de cada conta     │
 │ Categorias   │          │ Despesas pagas      │          │ Saldo total             │
 │ Cartões      │          │ Transferências      │          │ Resultado do mês        │
 │ Devedores    │          │ Recebimentos        │          │ Faturas e limite usado  │
 │ Metas        │          │ Aportes em metas    │          │ A receber de devedores  │
 │ Orçamentos   │          │ Faturas pagas       │          │ Gasto do orçamento      │
 └──────────────┘          └─────────────────────┘          │ Previsão do mês         │
                                     ▲                       └─────────────────────────┘
                                     │
                              Estornos desfazem
```

Os **cadastros** descrevem o seu mundo. Os **movimentos** são os fatos. Os **resultados** nunca são digitados: o sistema os recalcula sempre a partir dos movimentos — por isso, corrigir um movimento (com um estorno) corrige todos os números ligados a ele.

## Como cada área se conversa

| Quando você… | O que acontece nas outras áreas |
|---|---|
| **Marca uma receita como recebida** | O saldo da conta escolhida **sobe**; o Dashboard e os Relatórios passam a contá-la como realizada. |
| **Paga uma despesa** | O saldo da conta **desce** (se houver saldo); o gasto do **orçamento** da categoria é refletido. |
| **Compra no cartão** | Não mexe no saldo. Aumenta a **fatura** e o **limite usado**. |
| **Paga a fatura** | O saldo da conta **desce uma vez** pelo total da fatura; a fatura vira **paga**. |
| **Confirma uma transferência** | Sai da conta de origem e entra na de destino **juntos**. |
| **Recebe de um devedor** | O saldo da conta **sobe**; o **pendente** do devedor diminui. |
| **Aporta em uma meta** | O saldo da conta **desce**; o valor guardado da meta **sobe**. |
| **Registra a cobrança de uma assinatura** | Vira parcela de cartão ou dívida de um devedor, conforme a configuração. |
| **Faz um estorno** | O movimento original deixa de contar; saldo, devedor, meta ou fatura voltam ao que eram. |

## Por trás da tela: duas portas para os dados

Para manter tudo correto, o sistema usa dois caminhos:

```
  Você ──► Tela ──┬──► Cadastros e rascunhos ───────► Banco de dados
                  │    (categorias, contas, orçamentos,   (confere as regras de segurança)
                  │     itens ainda previstos)
                  │
                  └──► Tudo que MEXE EM SALDO ──► Servidor ──► Banco de dados
                       (receber, pagar, transferir,   (confere identidade, saldo,
                        estornar, aportar, pagar      e grava tudo de uma vez)
                        fatura…)
```

- **Cadastros e itens previstos** são salvos direto, e o banco confere as regras.
- **Tudo que muda saldo** passa por um **servidor**, que:
  1. confirma **quem você é**;
  2. confere as regras (existe saldo? a conta está ativa? o valor é válido?);
  3. grava o movimento, atualiza a conta e registra a **auditoria** **tudo de uma só vez**;
  4. se qualquer etapa falhar, **nada** é gravado.

## O que isso garante a você

- **Sem duplicidade.** Se você clicar duas vezes ou a internet cair no meio, a mesma operação **não é executada duas vezes**: o sistema reconhece o pedido repetido e devolve o resultado do primeiro.
- **Sem saldo negativo por acidente.** Duas operações ao mesmo tempo na mesma conta são tratadas **uma por vez**; a segunda enxerga o saldo já atualizado.
- **Tudo ou nada.** Uma transferência, um pagamento de fatura ou um aporte nunca ficam "pela metade".
- **Histórico confiável.** O que foi liquidado não é editado; correções são estornos com motivo, e cada ação fica registrada.
- **Privacidade.** Cada pessoa acessa somente os próprios dados.

# 5. Receitas de uso (passo a passo)

**Registrar o salário que caiu hoje**
1. *Receitas → Nova receita*; informe descrição, categoria, valor, data e conta.
2. Em status, escolha **Recebida** (ou crie como **Prevista** e depois use *Marcar como recebida*).

**Pagar uma conta que vence na semana que vem**
1. *Despesas → Nova despesa* como **Pendente**, com a data de vencimento.
2. No dia, clique em **Pagar** e escolha a conta.

**Saber quanto vou gastar em dezembro**
1. Em *Despesas*, filtre o mês **12/2026**: o resumo mostra *Previsto*, *Pago* e *A pagar*.
2. No *Dashboard*, escolha o mês e veja **Entradas e saídas** do período.

**Lançei algo errado e já estava pago**
1. Abra o lançamento e use **Estornar**, com um motivo.
2. Lance o valor correto.

**Cobrar um devedor**
1. *Devedores →* abra o devedor → **Exportar PDF** (do mês ou total em aberto).

**Meu saldo não bate com o banco**
1. *Bancos → Ajustar saldo* e informe o saldo real. O sistema corrige a abertura sem alterar seus lançamentos.

# 6. Dúvidas frequentes

**Por que não consigo editar uma despesa paga?**
Para preservar o histórico. Use o estorno e lance novamente.

**Por que a compra no cartão não aparece como despesa?**
Ela só vira saída de dinheiro quando você paga a fatura. Antes disso, ela aparece na fatura e no limite usado.

**Por que o Dashboard mostra 0,00 num mês futuro?**
O *resultado* conta só o que já foi realizado. Veja a tabela **Entradas e saídas**, que traz também o pendente e o total previsto.

**Não consigo excluir uma conta ou categoria.**
Elas têm histórico ou vínculos. Arquive a conta; troque a categoria dos lançamentos antes de excluí-la.

**Apareceu "saldo indisponível".**
O sistema prefere não mostrar um número a mostrar um errado: houve falha de leitura ou excesso de dados. Tente de novo.

**A operação foi recusada por saldo insuficiente.**
É a proteção funcionando. Confira o saldo da conta, transfira dinheiro ou escolha outra conta.

**Esqueci a senha.**
Na tela inicial, aba *Esqueci a senha*; você recebe um e-mail para redefinir.

**Como faço backup?**
*Configurações → Manutenção de dados → Exportar (ZIP)*. Faça isso periodicamente.

# 7. Glossário

| Termo | Significado |
|---|---|
| **Previsto / Pendente** | Ainda não aconteceu; não altera saldo. |
| **Realizado** | Já foi recebido ou pago; altera saldo. |
| **Saldo de abertura** | Saldo da conta na data em que você começou a usar o sistema. |
| **Estorno** | Lançamento que desfaz outro, com motivo. |
| **Fatura** | Soma das compras do cartão num ciclo; é paga de uma vez. |
| **Posição líquida** | Saldo + a receber − faturas a pagar. |
| **Auditoria** | Registro de quem fez o quê e quando. |
| **Derivado / calculado** | Valor que o sistema calcula, nunca digitado. |
