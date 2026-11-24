/**
 * Dashboard — VF-2-03f. Somente leitura: tudo é derivado (js/services/dashboard.js).
 * Sem dado real mostra zeros/estado vazio; nada é DEMO.
 */
import { el, refreshIcons } from '../components/dom.js';
import { statCard, panelHeader, emptyBlock, dataTable, formatDate, formatMonth, mount } from '../components/form-kit.js';
import { loadDashboard, formatCents, DASHBOARD_SOURCES } from '../services/dashboard.js';

export const meta = { title: 'Dashboard', icon: 'layout-dashboard' };

const KIND_LABELS = { expense: 'Despesa', subscription: 'Assinatura', invoice: 'Fatura' };
const SOURCE_LABELS = {
  goals: 'metas (saldo vinculado)', monthPending: 'previsto do mês', cardInvoices: 'faturas e limite dos cartões', debtorMonth: 'a receber no mês (devedores)',
  accounts: 'contas', movements: 'movimentações (saldo e resultado)', pendingExpenses: 'despesas a vencer',
  subscriptions: 'assinaturas', invoices: 'faturas', debtors: 'devedores', budgets: 'orçamentos', monthlyForecast: 'previsão do mês',
};
const COLLECTION_LABELS = {
  incomes: 'receitas', expenses: 'despesas', transfers: 'transferências',
  debtPayments: 'recebimentos', cardInvoices: 'faturas/compras de cartão', invoices: 'faturas pagas', goalTransactions: 'movimentações de metas', budgetExpenses: 'despesas do orçamento',
  expensesInMonth: 'despesas do mês (previsão)', expensesOverdue: 'despesas vencidas (previsão)', incomesPending: 'receitas pendentes (previsão)',
};

const PERIOD_LABELS = { month: 'Mês', semester: 'Semestre', year: 'Ano', all: 'Todo o período' };
const PERIODICITY_LABELS = { weekly: '/sem', monthly: '/mês', yearly: '/ano' };
let selectedPeriod = { mode: 'month' }; // { mode, month, year, semester }; padrão: mês vigente
let includeDebtors = false; // inclui o "a receber de devedores" no saldo projetado

export async function render(container, { user }) {
  mount(container, el('p', { class: 'card__hint', role: 'status', text: 'Carregando indicadores…' }));
  let data;
  try {
    data = await loadDashboard(user.uid, { period: selectedPeriod, includeDebtors });
  } catch (error) {
    console.error('[dashboard] falha ao carregar', error);
    mount(container, el('p', { role: 'alert', text: 'Não foi possível carregar o dashboard. Tente recarregar a página.' }));
    return;
  }
  if (data.failed.length >= DASHBOARD_SOURCES.length) {
    mount(container, el('p', { role: 'alert', text: 'Não foi possível carregar nenhum indicador. Verifique a conexão e as regras do Firestore e recarregue a página.' }));
    return;
  }
  draw(container, data, () => render(container, { user }));
}

const money = (value, fn = (v) => v) => (value === null || value === undefined ? '—' : formatCents(fn(value)));

function draw(container, data, rerender) {
  const { result, budgets, debtors } = data;
  const { period } = data;
  const header = panelHeader({ icon: 'layout-dashboard', title: 'Visão geral', hint: `Receitas e despesas de ${period.label}; contas, cartões, devedores e assinaturas mostram a situação de hoje. Tudo derivado dos seus lançamentos.` });

  const notice = data.truncated.length
    ? el('p', { class: 'notice', role: 'status', text: `Leitura limitada em: ${data.truncated.map((k) => COLLECTION_LABELS[k] ?? k).join(', ')}. Saldo e totais podem estar incompletos.` })
    : null;

  const failedNotice = data.failed.length
    ? el('p', { class: 'notice', role: 'alert', text: `Não foi possível carregar: ${data.failed.map((k) => SOURCE_LABELS[k] ?? k).join(', ')}. Os demais indicadores continuam válidos; recarregue para tentar de novo.` })
    : null;
  const unavailable = 'Indisponível nesta carga';
  // Saldo/resultado dependem das movimentações E dos estornos: sem a leitura completa NENHUM saldo é exibido (já "—"); aqui o motivo
  // explícito e uma nova tentativa. O motivo exato (negado × conexão) é apurado pelo serviço, que registra no console.
  const balanceUnavailableNotice = data.failed.includes('movements')
    ? el('div', { class: 'notice', role: 'alert', id: 'dashboard-balance-unavailable' }, [
      el('span', { text: 'Saldo, resultado e previsão indisponíveis: não foi possível ler as movimentações e estornos (leitura negada pelas regras publicadas ou erro de conexão). Nenhum saldo é exibido porque não é possível saber se há estornos que o alteram. ' }),
      el('button', { type: 'button', class: 'btn btn--secondary', id: 'retry-dashboard', onClick: rerender, text: 'Tentar novamente' }),
    ])
    : null;

  const choose = (patch) => { selectedPeriod = { ...selectedPeriod, ...patch }; rerender(); };
  const field = (id, label, control) => el('div', { class: 'form__field' }, [el('label', { for: id, text: label }), control]);
  const modeSelect = el('select', { id: 'dashboard-period-mode', onChange: (event) => choose({ mode: event.target.value }) },
    Object.entries(PERIOD_LABELS).map(([value, text]) => el('option', { value, text, selected: value === period.mode })));
  const yearInput = el('input', {
    type: 'number', id: 'dashboard-year', min: 2000, max: 2100, step: 1, value: period.year,
    onChange: (event) => { const year = Number(event.target.value); if (Number.isInteger(year) && year >= 2000 && year <= 2100) choose({ year }); },
  });
  const semesterSelect = el('select', { id: 'dashboard-semester', onChange: (event) => choose({ semester: Number(event.target.value) }) },
    [1, 2].map((n) => el('option', { value: n, text: n === 1 ? '1º semestre (jan–jun)' : '2º semestre (jul–dez)', selected: n === period.semester })));
  const monthInput = el('input', {
    type: 'month', id: 'dashboard-month', value: data.month, 'aria-label': 'Mês dos indicadores',
    onChange: (event) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
      choose({ mode: 'month', month: event.target.value });
    },
  });
  const monthBar = el('div', { class: 'toolbar', role: 'group', 'aria-label': 'Período dos indicadores' }, [
    field('dashboard-period-mode', 'Período', modeSelect),
    period.mode === 'month' ? field('dashboard-month', 'Mês dos indicadores', monthInput) : null,
    period.mode === 'semester' ? field('dashboard-year', 'Ano', yearInput) : null,
    period.mode === 'semester' ? field('dashboard-semester', 'Semestre', semesterSelect) : null,
    period.mode === 'year' ? field('dashboard-year', 'Ano', yearInput) : null,
    el('p', { class: 'card__hint', text: `Exibindo: ${period.label}` }),
  ]);

  const { forecast, cardInvoices: inv } = data;
  const sec = (title, cardsList, { hint, id } = {}) => el('section', { class: 'panel', id }, [
    el('div', { class: 'panel__header' }, [el('div', {}, [el('h2', { text: title }), hint ? el('p', { class: 'card__hint', text: hint }) : null])]),
    el('div', { class: 'panel__body' }, [el('div', { class: 'grid grid--cards' }, cardsList)]),
  ]);
  const link = (href, text) => el('a', { href, class: 'card__hint', text });
  const panel = (title, icon, hint, body, footer) => el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
      el('div', {}, [el('h2', { text: title }), hint ? el('p', { class: 'card__hint', text: hint }) : null]),
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [body]),
    footer ? el('div', { class: 'panel__body' }, [footer]) : null,
  ]);

  // ---- 1. Resumo da situação: um número principal (saldo) e quatro de apoio ----
  const tone = (cents) => (cents === null || cents === undefined ? '' : cents < 0 ? ' stat__value--expense' : ' stat__value--income');
  const stat = (label, value, hint, toneClass = '') => el('div', { class: 'stat' }, [
    el('dt', { class: 'stat__label', text: label }),
    el('dd', { class: `stat__value${toneClass}`, text: value }),
    hint ? el('dd', { class: 'stat__hint', text: hint }) : null,
  ]);
  const summary = el('section', { class: 'hero', id: 'dashboard-summary', 'aria-label': 'Situação financeira' }, [
    el('article', { class: 'card hero__main' }, [
      el('div', { class: 'card__head' }, [el('span', { text: 'Saldo total' })]),
      el('div', { class: 'card__value hero__value', text: money(data.totalBalanceCents) }),
      el('p', { class: 'hero__sub', text: data.accountCount === null ? unavailable : `${data.accountCount} conta(s) ativa(s), hoje` }),
      el('p', { class: 'hero__sub' }, [
        el('span', { text: `Livre ${money(data.freeBalanceCents)}` }),
        el('span', { text: `Vinculado a metas ${money(data.linkedGoalsCents)}` }),
      ]),
    ]),
    el('dl', { class: 'hero__stats' }, [
      stat(`Resultado — ${period.label}`, money(result?.resultCents), result ? `Receitas ${formatCents(result.incomeCents)} − despesas ${formatCents(result.expenseCents)}` : unavailable, tone(result?.resultCents)),
      stat('Faturas a pagar', data.cardsView ? formatCents(data.cardsView.dueCents) : '—', data.cardsView ? 'Vencidas e a próxima fatura de cada cartão (parcelas futuras não entram)' : unavailable, data.cardsView?.dueCents > 0 ? ' stat__value--expense' : ''),
      stat('A receber de devedores', money(debtors?.pendingCents), debtors ? `${debtors.openCount} devedor(es) em aberto` : unavailable, debtors?.pendingCents > 0 ? ' stat__value--income' : ''),
      stat('Posição líquida', money(data.netPositionCents), data.netPositionCents === null ? unavailable : 'Saldo + a receber − faturas a pagar (vencidas e próximas)', tone(data.netPositionCents)),
    ]),
  ]);

  // ---- 2. Pontos de atenção em linguagem simples ----
  const alerts = [];
  if (result && result.resultCents < 0) alerts.push(`As despesas pagas superaram as receitas recebidas em ${formatCents(-result.resultCents)} (${period.label}).`);
  if (data.monthlyForecast && data.monthlyForecast.projectedBalanceCents < 0) alerts.push(`O saldo projetado ao fim de ${formatMonth(data.month)} fica negativo (${formatCents(data.monthlyForecast.projectedBalanceCents)}).`);
  if (data.monthlyForecast?.expenses.overdueCents > 0) alerts.push(`Há despesas vencidas e não pagas: ${formatCents(data.monthlyForecast.expenses.overdueCents)}.`);
  for (const c of data.cardsView?.rows ?? []) {
    if (c.overdue) alerts.push(`Fatura do cartão ${c.name} venceu em ${formatDate(c.nextDueDate)} (${formatCents(c.overdueCents)} vencido).`);
    if (c.usedPercent >= 80) alerts.push(`Cartão ${c.name} com ${c.usedPercent}% do limite usado.`);
  }
  if (budgets?.overCount > 0) alerts.push(`${budgets.overCount} orçamento(s) estourado(s) em ${formatMonth(data.month)}.`);
  const attention = el('section', { class: 'panel', id: 'dashboard-attention' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Pontos de atenção' })]),
    el('div', { class: 'panel__body' }, alerts.length
      ? [el('ul', { class: 'attention' }, alerts.map((text) => el('li', { text })))]
      : [el('p', { class: 'card__hint', role: 'status', text: 'Nenhum ponto de atenção com os dados carregados.' })]),
  ]);

  // ---- 3. Contas, cartões, devedores e assinaturas (situação de hoje) ----
  const accountsPanel = panel('Contas', 'landmark', 'Saldo atual de cada conta ativa (derivado das movimentações).',
    data.accounts === null
      ? el('p', { class: 'card__hint', role: 'status', text: unavailable })
      : data.accounts.length
        ? dataTable({
          columns: [
            { key: 'label', label: 'Conta' },
            { key: 'typeLabel', label: 'Tipo' },
            { key: 'balanceCents', label: 'Saldo', numeric: true, render: (v) => formatCents(v) },
          ],
          rows: data.accounts, compact: true, stack: true,
        })
        : emptyBlock('landmark', 'Nenhuma conta ativa', 'Cadastre uma conta em Bancos.'),
    link('bancos.html', 'Ver Bancos'));

  const cardsView = data.cardsView;
  const cardsPanel = panel('Cartões', 'credit-card', 'Usado = tudo que está comprometido no limite (inclui parcelas futuras). Fatura a pagar = vencidas e a próxima de cada cartão.',
    cardsView === null
      ? el('p', { class: 'card__hint', role: 'status', text: unavailable })
      : cardsView.rows.length
        ? dataTable({
          columns: [
            { key: 'name', label: 'Cartão' },
            { key: 'usedCents', label: 'Usado / limite', numeric: true, render: (v, r) => `${formatCents(v)} / ${formatCents(r.limitCents)} (${r.usedPercent}%)` },
            { key: 'availableCents', label: 'Disponível', numeric: true, render: (v) => formatCents(v) },
            { key: 'dueCents', label: 'Fatura a pagar', numeric: true, render: (v, r) => (r.laterCents > 0 ? `${formatCents(v)} (+ ${formatCents(r.laterCents)} nos meses seguintes)` : formatCents(v)) },
            { key: 'nextDueDate', label: 'Vence', render: (v, r) => (v ? `${formatDate(v)}${r.overdue ? ' (vencida)' : ''}` : '—') },
          ],
          rows: cardsView.rows, compact: true, stack: true,
        })
        : emptyBlock('credit-card', 'Nenhum cartão ativo', 'Cadastre um cartão em Cartões.'),
    link('cartoes.html', 'Ver Cartões'));

  const debtorsPanel = panel('Devedores', 'hand-coins', 'Quem deve a você e quanto falta receber.',
    data.debtorsList === null
      ? el('p', { class: 'card__hint', role: 'status', text: unavailable })
      : data.debtorsList.length
        ? dataTable({
          columns: [
            { key: 'name', label: 'Devedor' },
            { key: 'lentCents', label: 'Emprestado/lançado', numeric: true, render: (v) => formatCents(v) },
            { key: 'receivedCents', label: 'Recebido', numeric: true, render: (v) => formatCents(v) },
            { key: 'monthDueCents', label: `A receber em ${formatMonth(data.month)}`, numeric: true, render: (v) => (v === null ? '—' : formatCents(v)) },
            { key: 'pendingCents', label: 'Total a receber', numeric: true, render: (v) => formatCents(v) },
          ],
          rows: data.debtorsList.slice(0, 8), compact: true, stack: true,
        })
        : emptyBlock('hand-coins', 'Ninguém te deve', 'Devedores em aberto aparecem aqui.'),
    el('div', {}, [
      data.debtorsList && data.debtorsList.length > 8 ? el('p', { class: 'card__hint', text: `Mostrando 8 de ${data.debtorsList.length} devedores.` }) : null,
      link('devedores.html', 'Ver Devedores'),
    ]));

  const subs = data.subscriptionsList;
  const subsSummary = data.subscriptionsSummary;
  const subsPanel = panel('Assinaturas', 'repeat', subsSummary ? `${subsSummary.activeCount} ativa(s) · ${formatCents(subsSummary.monthlyCents)}/mês · ${formatCents(subsSummary.annualCents)}/ano` : unavailable,
    subs === null
      ? el('p', { class: 'card__hint', role: 'status', text: unavailable })
      : subs.length
        ? dataTable({
          columns: [
            { key: 'name', label: 'Assinatura' },
            { key: 'amountCents', label: 'Valor', numeric: true, render: (v, r) => `${formatCents(v)}${PERIODICITY_LABELS[r.periodicity] ?? ''}` },
            { key: 'viaCard', label: 'Cobrança', render: (v) => (v ? 'Cartão' : 'Conta') },
            { key: 'nextChargeDate', label: 'Próxima', render: (v) => formatDate(v) },
          ],
          rows: subs.slice(0, 8), compact: true, stack: true,
        })
        : emptyBlock('repeat', 'Nenhuma assinatura ativa', 'Cadastre em Assinaturas.'),
    el('div', {}, [
      subs && subs.length > 8 ? el('p', { class: 'card__hint', text: `Mostrando 8 de ${subs.length} assinaturas ativas, pelas próximas cobranças.` }) : null,
      link('assinaturas.html', 'Ver Assinaturas'),
    ]));

  cardsPanel.classList.add('panel--wide');
  debtorsPanel.classList.add('panel--wide');
  const snapshot = el('div', { class: 'grid grid--panels', id: 'dashboard-snapshot' }, [accountsPanel, subsPanel, debtorsPanel, cardsPanel]);

  // ---- 4. Receitas × despesas do período ----
  const monthSection = sec(`Receitas × despesas — ${period.label}`, [
    statCard('Receitas', money(result?.incomeCents), 'trending-up', forecast ? `Realizado · previsto pendente ${formatCents(forecast.incomeCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'income'),
    statCard('Despesas', money(result?.expenseCents), 'trending-down', forecast ? `Realizado · previsto pendente ${formatCents(forecast.expenseCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'expense'),
    statCard('Resultado', money(result?.resultCents), 'scale', forecast ? `Realizado · previsto ${formatCents(forecast.forecastResultCents)}` : (result ? 'Realizado' : unavailable)),
  ], { hint: 'Realizado = receitas recebidas e despesas pagas no período. Previsto = pendentes com data prevista no período.' });
  const series = data.series ?? [];
  const seriesPanel = period.mode !== 'month' && series.length
    ? panel(`Mês a mês — ${period.label}`, 'bar-chart-3', 'Realizado por mês.',
      dataTable({
        columns: [
          { key: 'month', label: 'Mês', render: (v) => (v ? formatMonth(v) : 'Total do período') },
          { key: 'incomeCents', label: 'Receitas', numeric: true, render: (v) => formatCents(v) },
          { key: 'expenseCents', label: 'Despesas', numeric: true, render: (v) => formatCents(v) },
          { key: 'resultCents', label: 'Resultado', numeric: true, render: (v) => formatCents(v) },
        ],
        rows: [...series, {
          month: null, incomeCents: result?.incomeCents ?? 0, expenseCents: result?.expenseCents ?? 0, resultCents: result?.resultCents ?? 0,
        }], compact: true, stack: true,
      }))
    : null;
  const monthRefNote = period.mode === 'month'
    ? null
    : el('p', { class: 'card__hint', text: `Orçamentos, faturas do mês, previsão de caixa e "a receber no mês" abaixo usam o mês vigente (${formatMonth(data.month)}); escolha o modo "Mês" para outro mês.` });
  const refSection = sec(`Mês de referência — ${formatMonth(data.month)}`, [
    statCard('Faturas do mês', inv ? formatCents(inv.dueCents) : '—', 'receipt',
      inv ? `${inv.count} fatura(s) · abertas ${formatCents(inv.openCents)} · fechadas ${formatCents(inv.closedCents)} · pagas ${formatCents(inv.paidCents)}` : unavailable),
    statCard('Limite utilizado', inv ? formatCents(inv.usedCents) : '—', 'gauge',
      inv ? `de ${formatCents(inv.limitCents)} · disponível ${formatCents(inv.availableCents)}` : unavailable),
    statCard('Orçamentos', budgets && (budgets.spentCents > 0 || budgets.limitCents > 0) ? formatCents(budgets.spentCents) : '—', 'gauge',
      !budgets ? unavailable : budgets.limitCents > 0 ? `de ${formatCents(budgets.limitCents)} · ${budgets.overCount} estourado(s)` : 'Nenhum orçamento no mês'),
    statCard(`A receber em ${formatMonth(data.month)}`, money(debtors?.monthDueCents), 'calendar-check', debtors?.monthDueCents == null ? unavailable : 'Fechamento do mês (cartão + dívidas), limitado ao pendente'),
  ]);
  const f = data.monthlyForecast;
  const forecastSection = !f
    ? el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [el('h2', { text: `Previsão do mês — ${formatMonth(data.month)}` })]),
      el('div', { class: 'panel__body' }, [el('p', { class: 'card__hint', role: 'status', text: 'Previsão indisponível: falha ao ler uma das fontes (veja o aviso acima).' })]),
    ])
    : [
      sec(`Previsão do mês — ${formatMonth(data.month)}`, [
        statCard('Despesas previstas', formatCents(f.expenses.plannedCents), 'calendar-clock', `Vencem no mês · recorrentes ${formatCents(f.expenses.recurringPlannedCents)}`),
        statCard('Já pagas', formatCents(f.expenses.paidCents), 'check-circle-2', 'Das despesas que vencem no mês', 'income'),
        statCard('Pendentes', formatCents(f.expenses.pendingCents), 'clock', `Vencidas (todas) ${formatCents(f.expenses.overdueCents)} · de meses anteriores ${formatCents(f.expenses.overduePreviousCents)}`, 'expense'),
        statCard('Comprometido em cartões', formatCents(f.cards.committedCents), 'credit-card', `Compras não quitadas (inclui parcelas futuras) · compras do mês ${formatCents(f.cards.purchasesInMonthCents)}`),
        statCard('Faturas a pagar', formatCents(f.cards.invoicesToPayCents), 'receipt', `Abertas ${formatCents(f.cards.openInvoicesCents)} · fechadas ${formatCents(f.cards.closedInvoicesCents)} · vencidas ${formatCents(f.cards.invoicesOverdueCents)}`),
        statCard('Assinaturas', formatCents(f.subscriptions.monthlyCents), 'repeat', `Valor mensal consolidado · cobranças previstas no mês ${formatCents(f.subscriptions.plannedInMonthCents)} (conta ${formatCents(f.subscriptions.directCents)} · cartão ${formatCents(f.subscriptions.cardCommitmentCents)})`),
        statCard('Saldo disponível atual', formatCents(f.balanceCents), 'wallet', 'Contas ativas (já inclui o que foi pago/recebido)'),
        statCard('Saldo projetado ao fim do mês', formatCents(f.projectedBalanceCents), 'trending-up', f.projectedBalanceCents < 0 ? 'Atenção: projeção negativa' : 'Saldo atual + pendentes − compromissos', f.projectedBalanceCents < 0 ? 'expense' : 'income'),
      ]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'panel__header' }, [
          el('h2', { text: 'Como o saldo projetado foi calculado' }),
          el('div', { class: 'topbar__spacer' }),
          el('label', { class: 'card__hint' }, [
            el('input', { type: 'checkbox', id: 'include-debtors', checked: includeDebtors, onChange: (event) => { includeDebtors = event.target.checked; rerender(); } }),
            ` Incluir a receber de devedores (${formatCents(f.debtors.receivableCents)})`,
          ]),
        ]),
        el('div', { class: 'panel__body panel__body--flush' }, [
          dataTable({
            columns: [
              { key: 'label', label: 'Item' },
              { key: 'cents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
            ],
            rows: [
              { label: 'Saldo atual das contas', cents: f.balanceCents },
              ...f.components,
              { label: '= Saldo projetado ao fim do mês', cents: f.projectedBalanceCents },
            ],
          }),
        ]),
        el('p', { class: 'card__hint', text: 'Compras no cartão são compromisso, não saída: o caixa só sai quando a fatura é paga, por isso entram as faturas (pelo vencimento), nunca as compras. Recorrências ainda não lançadas não são projetadas. Assinatura no cartão: o comprometimento é o mês da cobrança; o caixa é o mês do vencimento da fatura que a receberá. Já lançada, ela está na fatura e no comprometido do cartão (nunca somada de novo).' }),
        f.subscriptions.cardCharges.length
          ? dataTable({
            columns: [
              { key: 'name', label: 'Assinatura no cartão (ainda não lançada)' },
              { key: 'date', label: 'Cobrança (comprometimento)', render: (v) => formatDate(v) },
              { key: 'referenceMonth', label: 'Fatura prevista', render: (v) => (v ? formatMonth(v) : '—') },
              { key: 'dueDate', label: 'Vence (saída de caixa)', render: (v) => formatDate(v) },
              { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
            ],
            rows: f.subscriptions.cardCharges.slice(0, 12),
          })
          : null,
        el('p', { class: 'card__hint', text: `Assinaturas já lançadas nos cartões e ainda não quitadas: ${formatCents(f.subscriptions.launchedInCardsCents)} (já estão na fatura e no comprometido do cartão).` }),
        ...f.subscriptions.duplicates.filter((d) => d.via === 'purchase').map((d) => el('p', { class: 'notice', role: 'status', text: `Assinatura "${d.name}" (${formatCents(d.amountCents)} em ${formatDate(d.date)}) ignorada na previsão: a compra já está lançada no cartão.` })),
        ...f.subscriptions.duplicates.filter((d) => d.via === 'expense').map((d) => el('p', { class: 'notice', role: 'status', text: `Assinatura "${d.name}" (${formatCents(d.amountCents)}) ignorada na previsão: já existe como despesa no mês (evita contar duas vezes).` })),
      ]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'panel__header' }, [el('h2', { text: 'Compromissos dos próximos meses' })]),
        el('div', { class: 'panel__body panel__body--flush' }, [
          dataTable({
            columns: [
              { key: 'month', label: 'Mês', render: (v) => formatMonth(v) },
              { key: 'expensesCents', label: 'Despesas pendentes', numeric: true, render: (v) => formatCents(v) },
              { key: 'invoicesCents', label: 'Faturas (vencimento)', numeric: true, render: (v) => formatCents(v) },
              { key: 'subscriptionsCents', label: 'Assinaturas (saída de caixa)', numeric: true, render: (v) => formatCents(v) },
              { key: 'commitmentsCents', label: 'Total de saída de caixa', numeric: true, render: (v) => formatCents(v) },
              { key: 'cardSubscriptionChargesCents', label: 'Cobranças no cartão (comprometimento)', numeric: true, render: (v) => formatCents(v) },
            ],
            rows: f.nextMonths,
          }),
        ]),
      ]),
    ];
  const note = el('p', { class: 'card__hint', text: 'Compras no cartão não entram em Despesas: aparecem em Faturas; pagar a fatura debita a conta escolhida (uma vez).' });

  const upcoming = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Próximos vencimentos' })]),
    el('div', { class: 'panel__body panel__body--flush' }, [
      data.upcoming.length
        ? dataTable({
          columns: [
            { key: 'date', label: 'Data', render: (v) => formatDate(v) },
            { key: 'kind', label: 'Tipo', render: (v) => KIND_LABELS[v] ?? v },
            { key: 'label', label: 'Descrição' },
            { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
          ],
          rows: data.upcoming, stack: true,
        })
        : emptyBlock('calendar-check', 'Nada a vencer', 'Despesas pendentes, assinaturas ativas e faturas fechadas aparecem aqui.'),
    ]),
  ]);

  const forecastParts = [].concat(forecastSection);
  const forecastBlocks = forecastParts.length === 3
    ? [forecastParts[0], el('details', { class: 'dash-details', id: 'dashboard-forecast-details' }, [
      el('summary', { text: 'Como o saldo foi calculado e compromissos dos próximos meses' }), forecastParts[1], forecastParts[2],
    ])]
    : forecastParts;

  mount(container, header, monthBar, failedNotice, balanceUnavailableNotice, notice, summary, attention, snapshot, monthSection, seriesPanel, monthRefNote, refSection, ...forecastBlocks, note, upcoming);
  refreshIcons();
}
