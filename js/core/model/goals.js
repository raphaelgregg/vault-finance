/**
 * Metas (aportes e resgates) — cálculos puros.
 * Parte do modelo financeiro puro (js/core/model.js reexporta tudo; sem Firebase nem DOM).
 */

/** Valor guardado da meta (aportes − resgates), derivado; nunca gravado. */
export function goalSavedCents(transactions = [], reversals = []) {
  const reversed = new Set(reversals.filter((r) => r.targetCollection === 'goalTransactions').map((r) => r.targetId));
  return transactions.reduce((total, t) => {
    if (t?.reversed || reversed.has(t?.id)) return total; // movimento estornado não conta
    const amount = Number(t?.amountCents) || 0;
    return total + (t?.type === 'deposit' ? amount : t?.type === 'withdraw' ? -amount : 0);
  }, 0);
}

/**
 * Meta em modo "conta vinculada" (VF-2-03o): tem `accountId` e NENHUMA movimentação própria (aporte/resgate).
 * O progresso segue o saldo derivado da conta (caixinha/investimento), alimentado por transferências, e não
 * por goalTransactions — fonte única, sem duplicar valores. Metas com movimentações seguem o modo legado.
 */
export const isAccountLinkedGoal = (goal, txCount) => Boolean(goal?.accountId) && !txCount;

/**
 * Distribui o saldo de cada conta entre as metas vinculadas a ela (várias metas na mesma conta não repetem o
 * mesmo valor): por conta, em ordem de criação, cada meta recebe min(alvo, saldo restante); o excedente
 * fica sem alocar. Só metas ativas/concluídas em modo conta vinculada; saldo negativo conta como 0.
 * `balances`: Map(accountId → centavos); `txCounts`: Map(goalId → nº de movimentações).
 * Retorna Map(goalId → centavos guardados).
 */
export function allocateLinkedGoalBalances(goals = [], balances = new Map(), txCounts = new Map()) {
  const out = new Map();
  const byAccount = new Map();
  for (const g of goals) {
    if (g.status === 'cancelled' || !isAccountLinkedGoal(g, txCounts.get(g.id))) continue;
    if (!byAccount.has(g.accountId)) byAccount.set(g.accountId, []);
    byAccount.get(g.accountId).push(g);
  }
  const created = (g) => (typeof g.createdAt?.toMillis === 'function' ? g.createdAt.toMillis() : 0);
  for (const [accountId, list] of byAccount) {
    let remaining = Math.max(0, Number(balances.get(accountId)) || 0);
    list.sort((a, b) => created(a) - created(b) || String(a.id).localeCompare(String(b.id)));
    for (const g of list) {
      const share = Math.min(Number(g.targetCents) || 0, remaining);
      out.set(g.id, share);
      remaining -= share;
    }
  }
  return out;
}

/** Progresso 0..100 (inteiro, truncado) do guardado sobre a meta. */
export function goalProgressPercent(savedCents, targetCents) {
  if (!Number.isInteger(targetCents) || targetCents <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((savedCents * 100) / targetCents)));
}

/**
 * Aplica aporte/resgate. Retorna { ok, savedCents, status, error }.
 * Aporte só em meta ativa; resgate em ativa ou concluída e nunca acima do guardado.
 * Atingir a meta conclui; resgatar de meta concluída abaixo da meta reativa.
 */
export function applyGoalTransaction(goal, savedCents, type, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'O valor deve ser maior que zero.' };
  if (type === 'deposit') {
    if (goal?.status !== 'active') return { ok: false, error: 'Só é possível aportar em metas ativas.' };
    const next = savedCents + amountCents;
    return { ok: true, savedCents: next, status: next >= goal.targetCents ? 'completed' : 'active' };
  }
  if (type === 'withdraw') {
    if (!['active', 'completed'].includes(goal?.status)) return { ok: false, error: 'Só é possível resgatar de metas ativas ou concluídas.' };
    if (amountCents > savedCents) return { ok: false, error: 'O resgate excede o valor guardado na meta.' };
    const next = savedCents - amountCents;
    return { ok: true, savedCents: next, status: next >= goal.targetCents ? 'completed' : 'active' };
  }
  return { ok: false, error: 'Tipo de movimentação inválido.' };
}
