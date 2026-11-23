/**
 * Rótulo de conta, filtros de listagem e derivações financeiras. Saldo NUNCA é gravado: é sempre calculado a partir das movimentações.
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */

/**
 * Rótulo de exibição de uma conta (selects, listas, mensagens). Puro.
 * "Instituição — Conta" quando ambos existem e diferem; só um deles quando o outro falta ou são iguais
 * (sem caixa/acento); nunca separador sobrando.
 */
export function accountLabel(account) {
  const fold = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const institution = String(account?.institution ?? '').trim();
  const name = String(account?.name ?? '').trim();
  if (!institution) return name || '—';
  if (!name || fold(name) === fold(institution)) return institution;
  return `${institution} — ${name}`;
}

/**
 * Filtra movimentações por status, mês e categoria.
 *
 * IMPORTANTE (limitação conhecida): o filtro é client-side sobre a lista já
 * carregada. Vale enquanto a listagem não for paginada; com paginação futura,
 * migrar para options.where no serviço (campos únicos, sem índice composto novo).
 *
 * @param {Array} items movimentações (incomes/expenses)
 * @param {object} filters { status: 'all'|valor, month: 'YYYY-MM'|null, categoryId: id|null }
 * @param {object} options { dateField } campo de data usado pelo filtro de mês
 */
export function filterMovements(items, filters = {}, { dateField } = {}) {
  const { status = 'all', month = null, categoryId = null } = filters ?? {};
  return (items ?? []).filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    if (month) {
      const value = dateField ? item?.[dateField] : null;
      if (typeof value !== 'string' || !value.startsWith(month)) return false;
    }
    if (categoryId && item.categoryId !== categoryId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Derivações financeiras (nada de saldo gravado: sempre calculado)
// ---------------------------------------------------------------------------

/**
 * Saldo atual de cada conta, derivado dos movimentos (nunca gravado):
 *   saldo = saldo de abertura (`initialBalanceCents`)
 *         + receitas recebidas (status received)
 *         - despesas pagas (status paid)
 *         + transferências confirmadas recebidas - confirmadas enviadas
 *         + recebimentos de devedores (debtPayments)
 *         - aportes em metas + resgates (goalTransactions)
 *         - faturas de cartão pagas com a conta.
 * Transferências pendentes/canceladas não movem dinheiro.
 * DATA DE ABERTURA: se a conta tem `openingDate`, só movimentos com data (recebimento/pagamento/data da
 * movimentação) >= `openingDate` entram — o saldo de abertura já inclui o que aconteceu antes. Sem `openingDate`
 * (contas antigas) todos os movimentos entram, como sempre. Movimento sem data conhecida entra.
 */
export function accountBalances(accounts, { incomes = [], expenses = [], transfers = [], debtPayments = [], goalTransactions = [], invoices = [], reversals = [] } = {}) {
  const balances = new Map();
  const opening = new Map();
  for (const account of accounts) {
    balances.set(account.id, Number(account.initialBalanceCents) || 0);
    if (typeof account.openingDate === 'string' && account.openingDate) opening.set(account.id, account.openingDate);
  }
  const counts = (id, date) => {
    const from = opening.get(id);
    return !from || typeof date !== 'string' || date >= from;
  };
  const bump = (id, delta, date) => {
    if (balances.has(id) && counts(id, date)) balances.set(id, balances.get(id) + delta);
  };
  // ESTORNOS (VF-ARQ-02): recebimento de devedor e movimento de meta não têm status; quando estornados (documento em
  // `reversals`) o original permanece no histórico mas deixa de contar. Receita/despesa/transferência/fatura estornadas
  // mudam de status no servidor e já saem por aí.
  const reversed = new Set(reversals.map((r) => `${r.targetCollection}/${r.targetId}`));

  for (const income of incomes) {
    if (income.status === 'received') bump(income.accountId, income.amountCents, income.receivedDate);
  }
  for (const expense of expenses) {
    if (expense.status === 'paid') bump(expense.accountId, -expense.amountCents, expense.paidDate);
  }
  // Recebimentos de devedores entram na conta de destino (existir já = dinheiro recebido).
  for (const payment of debtPayments) if (!reversed.has(`debtPayments/${payment.id}`)) bump(payment.accountId, payment.amountCents, payment.date);
  // Fatura paga com conta (VF-2-03p) debita a conta UMA vez; as compras do cartão não são despesas (sem dupla contagem).
  for (const invoice of invoices) {
    if (invoice.status === 'paid' && invoice.accountId) bump(invoice.accountId, -(Number(invoice.paidCents ?? invoice.totalCents) || 0), invoice.paidAt);
  }
  // Aporte em meta tira dinheiro da conta; resgate devolve.
  for (const t of goalTransactions) if (!reversed.has(`goalTransactions/${t.id}`)) bump(t.accountId, t.type === 'deposit' ? -t.amountCents : t.amountCents, t.date);
  for (const transfer of transfers) {
    if (transfer.status !== 'confirmed') continue;
    bump(transfer.fromAccountId, -transfer.amountCents, transfer.date);
    bump(transfer.toAccountId, transfer.amountCents, transfer.date);
  }
  return balances;
}

/**
 * Movimentos realizados que apontam para uma conta INEXISTENTE (órfãos): `accountBalances` os ignora, então o
 * dinheiro "some" do saldo. Retorna { count, byCollection } para a UI avisar. Puro.
 */
export function orphanMovements(accounts, { incomes = [], expenses = [], transfers = [], debtPayments = [], goalTransactions = [], invoices = [] } = {}) {
  const known = new Set(accounts.map((a) => a.id));
  const byCollection = {};
  const mark = (name, rows, test, ids) => {
    const n = rows.filter((r) => test(r) && ids(r).some((id) => id && !known.has(id))).length;
    if (n) byCollection[name] = n;
  };
  mark('incomes', incomes, (r) => r.status === 'received', (r) => [r.accountId]);
  mark('expenses', expenses, (r) => r.status === 'paid', (r) => [r.accountId]);
  mark('transfers', transfers, (r) => r.status === 'confirmed', (r) => [r.fromAccountId, r.toAccountId]);
  mark('debtPayments', debtPayments, () => true, (r) => [r.accountId]);
  mark('goalTransactions', goalTransactions, () => true, (r) => [r.accountId]);
  mark('invoices', invoices, (r) => r.status === 'paid' && r.accountId, (r) => [r.accountId]);
  return { count: Object.values(byCollection).reduce((t, n) => t + n, 0), byCollection };
}

/** Soma de amountCents dos itens com o status pedido. */
export function sumAmounts(items, status) {
  return items
    .filter((item) => (status ? item.status === status : true))
    .reduce((total, item) => total + (Number(item.amountCents) || 0), 0);
}
