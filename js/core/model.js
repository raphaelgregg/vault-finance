/**
 * Modelo financeiro (puro, sem dependência do Firebase nem do DOM) — ponto de entrada único.
 *
 * Este arquivo apenas REEXPORTA os submódulos de `js/core/model/`; é o contrato público consumido por
 * services, módulos, servidor e testes (`import … from '../core/model.js'`). A lógica vive em:
 *   model/schemas.js        schemas das entidades (espelham firestore.rules) e campos de referência
 *   model/validation.js     validateEntity/buildEntity e compatibilidade categoria × movimentação
 *   model/ledger.js         rótulo de conta, filtros e saldos derivados (accountBalances)
 *   model/subscriptions.js  assinaturas
 *   model/debtors.js        devedores, parcelas e recebimentos
 *   model/goals.js          metas (aportes/resgates)
 *   model/cards.js          cartões, faturas e parcelamento
 *   ../utils/money.js       centavos ↔ texto (parseMoneyToCents, centsToMoneyString, formatCents)
 *
 * Regras: dinheiro em centavos inteiros; datas ISO "YYYY-MM-DD" (a conversão para Timestamp é do service);
 * saldo nunca é gravado. Os schemas espelham EXATAMENTE as Security Rules — toda mudança exige conferência.
 */
export {
  ACCOUNT_TYPES,
  RECURRENCES,
  SUBSCRIPTION_PERIODICITIES,
  SUBSCRIPTION_STATUSES,
  DEBTOR_STATUSES,
  DEBT_STATUSES,
  GOAL_STATUSES,
  GOAL_TRANSACTION_TYPES,
  CARD_STATUSES,
  INVOICE_STATUSES,
} from '../utils/constants.js';

export * from '../utils/money.js';
export * from './model/schemas.js';
export * from './model/validation.js';
export * from './model/ledger.js';
export * from './model/subscriptions.js';
export * from './model/debtors.js';
export * from './model/goals.js';
export * from './model/cards.js';
