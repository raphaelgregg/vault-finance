/**
 * Relatórios — VF-2-03g. Período em meses (máx. 24), receitas × despesas realizadas por mês e
 * totais por categoria, com exportação CSV gerada no cliente. Somente leitura.
 */
import { el, toast, refreshIcons } from '../components/dom.js';
import {
  field, statCard, panelHeader, emptyBlock, dataTable, progressBar, formatMonth,
  mount,
} from '../components/form-kit.js';
import { loadReport, seriesToCsv, categoriesToCsv, formatCents } from '../services/reports.js';
import { addMonths } from '../core/model.js';
import { currentMonthKey } from '../utils/dates.js';

export const meta = { title: 'Relatórios', icon: 'bar-chart-3' };

let user = null;
let container = null;
let fromMonth = '';
let toMonth = '';
let report = null;
let message = '';

export async function render(target, ctx) {
  user = ctx.user;
  container = target;
  toMonth = currentMonthKey();
  fromMonth = addMonths(toMonth, -5);
  await run();
}

async function run() {
  const result = await loadReport(user.uid, fromMonth, toMonth);
  if (result.ok) { report = result; message = ''; } else { report = null; message = result.errors._form; }
  draw();
}

function download(filename, csv) {
  // BOM para o Excel reconhecer UTF-8.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function draw() {
  const header = panelHeader({ icon: 'bar-chart-3', title: 'Relatórios', hint: 'Receitas e despesas realizadas por período e categoria.' });

  const from = el('input', { type: 'month', id: 'rep-from', value: fromMonth });
  const to = el('input', { type: 'month', id: 'rep-to', value: toMonth });
  const apply = el('button', { type: 'button', class: 'btn btn--primary', text: 'Atualizar', onClick: async () => {
    fromMonth = from.value;
    toMonth = to.value;
    await run();
  } });
  const toolbar = el('div', { class: 'toolbar' }, [field('De', 'rep-from', from), field('Até', 'rep-to', to), apply]);

  const alert = message ? el('p', { class: 'form__error', role: 'alert', text: message }) : null;
  if (!report) {
    mount(container, header, toolbar, alert);
    refreshIcons();
    return;
  }

  const { totals, series } = report;
  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard('Receitas', formatCents(totals.incomeCents), 'trending-up', 'Recebidas no período', 'income'),
    statCard('Despesas', formatCents(totals.expenseCents), 'trending-down', 'Pagas no período', 'expense'),
    statCard('Resultado', formatCents(totals.resultCents), 'scale', `${series.length} mês(es)`),
  ]);
  const notice = report.truncated
    ? el('p', { class: 'notice', role: 'status', text: 'O período tem mais lançamentos que o limite de leitura; os totais podem estar incompletos. Reduza o período.' })
    : null;

  const hasData = totals.incomeCents > 0 || totals.expenseCents > 0;
  const max = Math.max(1, ...series.flatMap((r) => [r.incomeCents, r.expenseCents]));
  const evolution = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Evolução mensal' }), el('div', { class: 'topbar__spacer' }),
      el('button', { type: 'button', class: 'btn btn--secondary', text: 'Exportar CSV', onClick: () => {
        download(`evolucao-${fromMonth}-${toMonth}.csv`, seriesToCsv(series));
        toast('CSV gerado.');
      } }),
    ]),
    el('div', { class: 'panel__body' }, hasData
      ? series.map((r) => el('div', {}, [
        el('div', { class: 'bar-row' }, [
          el('span', { class: 'bar-row__label', text: `${formatMonth(r.month)} · receitas` }),
          el('div', { class: 'bar--income' }, [progressBar(Math.floor((r.incomeCents * 100) / max), 'ok', `Receitas de ${formatMonth(r.month)}`)]),
          el('span', { class: 'bar-row__value', text: formatCents(r.incomeCents) }),
        ]),
        el('div', { class: 'bar-row' }, [
          el('span', { class: 'bar-row__label', text: `${formatMonth(r.month)} · despesas` }),
          el('div', { class: 'bar--expense' }, [progressBar(Math.floor((r.expenseCents * 100) / max), 'ok', `Despesas de ${formatMonth(r.month)}`)]),
          el('span', { class: 'bar-row__value', text: formatCents(r.expenseCents) }),
        ]),
      ]))
      : [emptyBlock('bar-chart-3', 'Nenhum dado para relatar', 'Não há receitas recebidas nem despesas pagas no período.')]),
  ]);

  const categoryPanel = (title, rows, kind, filePrefix) => el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: title }), el('div', { class: 'topbar__spacer' }),
      rows.length ? el('button', { type: 'button', class: 'btn btn--secondary', text: 'Exportar CSV', onClick: () => {
        download(`${filePrefix}-${fromMonth}-${toMonth}.csv`, categoriesToCsv(rows, report.categories));
        toast('CSV gerado.');
      } }) : null,
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [
      rows.length
        ? dataTable({
          columns: [
            { key: 'categoryId', label: 'Categoria', render: (v) => report.categories.get(v) ?? '(sem categoria)' },
            { key: 'count', label: 'Lançamentos', numeric: true },
            { key: 'totalCents', label: 'Total', numeric: true, render: (v) => formatCents(v) },
            { key: 'sharePercent', label: 'Participação', numeric: true, render: (v) => `${v}%` },
          ],
          rows,
        })
        : emptyBlock('tags', 'Sem lançamentos', kind === 'expense' ? 'Nenhuma despesa paga no período.' : 'Nenhuma receita recebida no período.'),
    ]),
  ]);

  mount(container,
    header, toolbar, alert, notice, cards, evolution,
    categoryPanel('Despesas por categoria', report.expensesByCategory, 'expense', 'despesas-por-categoria'),
    categoryPanel('Receitas por categoria', report.incomesByCategory, 'income', 'receitas-por-categoria'),
  );
  refreshIcons();
}
