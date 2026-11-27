---
title: Relatórios
category: Funcionalidades
tags: relatórios, período, categoria, csv, realizado
summary: Receitas × despesas realizadas por mês e totais por categoria, até 24 meses, com exportação CSV gerada no navegador.
files: js/modules/relatorios.js, js/services/reports.js, js/core/aggregates.js, js/utils/csv.js
page: relatorios
---

# Relatórios

Rota `/relatorios`. **Somente leitura.**

- **Período** em meses `[de, até]`, **máximo 24** (`MAX_REPORT_MONTHS`, `validatePeriod`). Lê só o intervalo (`receivedDate`/`paidDate`) com teto `REPORT_READ_LIMIT` = 2000 por coleção.
- **Realizado** = receitas `received` e despesas `paid`. Mostra, por mês, receitas × despesas e, por categoria, os totais.
- **Exportação CSV** gerada no cliente, sem bibliotecas (`js/utils/csv.js`): separador `;`, BOM para o Excel, CRLF. Campos de texto que começam com `=`, `+`, `-`, `@`, tab ou CR recebem um apóstrofo (**neutralização de injeção de fórmula**); números (inclusive negativos) ficam intactos.
- **Sem PDF:** relatórios gerais exportam só CSV. O único PDF do sistema é o das dívidas de um devedor ([Devedores](doc:devedores#exportar-pdf-das-dividas-vf-feat-01)).
- Se o teto for atingido, o resultado vem com aviso de truncamento.
