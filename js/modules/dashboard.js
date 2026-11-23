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

let selectedMonth = null; // mês do indicador; null = vigente
let includeDebtors = false; // inclui o "a receber de devedores" no saldo projetado

export async function render(container, { user }) {
  mount(container, el('p', { class: 'card__hint', role: 'status', text: 'Carregando indicadores…' }));
  let data;
  try {
    data = await loadDashboard(user.uid, { ...(selectedMonth ? { month: selectedMonth } : {}), includeDebtors });
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
  const header = panelHeader({ icon: 'layout-dashboard', title: 'Visão geral', hint: `Indicadores de ${formatMonth(data.month)}, derivados dos seus lançamentos.` });

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

  const monthInput = el('input', {
    type: 'month', id: 'dashboard-month', value: data.month, 'aria-label': 'Mês dos indicadores',
    onChange: (event) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
      selectedMonth = event.target.value;
      rerender();
    },
  });
  const monthBar = el('div', { class: 'form__field' }, [el('label', { for: 'dashboard-month', text: 'Mês dos indicadores' }), monthInput]);

  const { forecast, cardInvoices: inv } = data;
  const sec = (title, cardsList) => el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: title })]),
    el('div', { class: 'panel__body' }, [el('div', { class: 'grid grid--cards' }, cardsList)]),
  ]);

  const balanceSection = sec('Saldo em contas', [
    statCard('Saldo total', money(data.totalBalanceCents), 'wallet', data.accountCount === null ? unavailable : `${data.accountCount} conta(s) ativa(s)`),
    statCard('Livre', money(data.freeBalanceCents), 'unlock', data.freeBalanceCents === null ? unavailable : 'Saldo total − vinculado a metas'),
    statCard('Vinculado a metas', money(data.linkedGoalsCents), 'target', data.linkedGoalsCents === null ? unavailable : 'Caixinhas/investimentos com meta'),
  ]);
  const monthSection = sec(`Receitas × despesas — ${formatMonth(data.month)}`, [
    statCard('Receitas', money(result?.incomeCents), 'trending-up', forecast ? `Realizado · previsto pendente ${formatCents(forecast.incomeCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'income'),
    statCard('Despesas', money(result?.expenseCents), 'trending-down', forecast ? `Realizado · previsto pendente ${formatCents(forecast.expenseCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'expense'),
    statCard('Resultado', money(result?.resultCents), 'scale', forecast ? `Realizado · previsto ${formatCents(forecast.forecastResultCents)}` : (result ? 'Realizado' : unavailable)),
    statCard('Orçamentos', budgets && (budgets.spentCents > 0 || budgets.limitCents > 0) ? formatCents(budgets.spentCents) : '—', 'gauge',
      !budgets ? unavailable : budgets.limitCents > 0 ? `de ${formatCents(budgets.limitCents)} · ${budgets.overCount} estourado(s)` : 'Nenhum orçamento no mês'),
  ]);
  const cardSection = sec(`Faturas de cartão — ${formatMonth(data.month)}`, [
    statCard('Faturas a pagar', inv ? formatCents(inv.dueCents) : '—', 'credit-card',
      inv ? `${inv.count} fatura(s) · abertas ${formatCents(inv.openCents)} · fechadas ${formatCents(inv.closedCents)} · pagas ${formatCents(inv.paidCents)}` : unavailable),
    statCard('Limite utilizado', inv ? formatCents(inv.usedCents) : '—', 'gauge',
      inv ? `de ${formatCents(inv.limitCents)} · disponível ${formatCents(inv.availableCents)}` : unavailable),
  ]);
  const debtorSection = sec('Devedores', [
    statCard(`A receber em ${formatMonth(data.month)}`, money(debtors?.monthDueCents), 'calendar-check', debtors?.monthDueCents == null ? unavailable : 'Fechamento do mês (cartão + dívidas), limitado ao pendente'),
    statCard('Total em aberto', money(debtors?.pendingCents), 'hand-coins', debtors ? `${debtors.openCount} devedor(es) em aberto` : unavailable),
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
          rows: data.upcoming,
        })
        : emptyBlock('calendar-check', 'Nada a vencer', 'Despesas pendentes, assinaturas ativas e faturas fechadas aparecem aqui.'),
    ]),
  ]);

  mount(container, header, monthBar, failedNotice, balanceUnavailableNotice, notice, balanceSection, ...[].concat(forecastSection), monthSection, cardSection, debtorSection, note, upcoming);
  refreshIcons();
}
