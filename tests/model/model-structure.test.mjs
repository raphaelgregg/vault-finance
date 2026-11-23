/**
 * Estrutura do modelo (reestruturação): `js/core/model.js` é só um barrel dos submódulos e o dinheiro vive em
 * `js/utils/money.js`. Estes testes fixam o CONTRATO PÚBLICO (nomes exportados) e golden values financeiros, para que
 * mover/dividir funções nunca altere o que services, módulos, servidor e testes importam.
 * Executar: node --test tests/model
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as barrel from '../../js/core/model.js';
import * as money from '../../js/utils/money.js';
import * as schemas from '../../js/core/model/schemas.js';
import * as validation from '../../js/core/model/validation.js';
import * as ledger from '../../js/core/model/ledger.js';
import * as subscriptions from '../../js/core/model/subscriptions.js';
import * as debtors from '../../js/core/model/debtors.js';
import * as goals from '../../js/core/model/goals.js';
import * as cards from '../../js/core/model/cards.js';

const PUBLIC_API = [
  'ACCOUNT_TYPES', 'CARD_STATUSES', 'CATEGORY_KIND_ERROR', 'DEBTOR_STATUSES', 'DEBT_STATUSES', 'GOAL_STATUSES',
  'GOAL_TRANSACTION_TYPES', 'INVOICE_STATUSES', 'RECURRENCES', 'REF_FIELDS', 'SCHEMAS', 'SUBSCRIPTION_PERIODICITIES',
  'SUBSCRIPTION_STATUSES', 'accountBalances', 'accountLabel', 'addMonths', 'advanceChargeDate',
  'allocateLinkedGoalBalances', 'applyGoalTransaction', 'applyPaymentToDebtor', 'buildEntity', 'cardInvoicesSummary',
  'cardLimitUsage', 'centsToMoneyString', 'checkCategoryForMovement', 'clampDayInMonth', 'consolidationDeltaCents',
  'debtorMonthStatement', 'debtorObligations', 'debtorOverview', 'debtorPendingCents', 'filterMovements',
  'formatCents', 'goalProgressPercent', 'goalSavedCents', 'installmentPaymentState', 'invoiceDatesFor',
  'invoiceMonthForPurchase', 'invoiceTotalCents', 'isAccountLinkedGoal', 'isKindCompatible', 'isValidIsoDate',
  'orphanMovements', 'parseMoneyToCents', 'pendingInstallmentsOfMonth', 'receivedByInstallment', 'splitInstallments',
  'subscriptionAnnualCents', 'subscriptionMonthlyCents', 'sumAmounts', 'summarizeDebtors', 'summarizeSubscriptions',
  'validateEntity',
];

describe('js/core/model.js — contrato público preservado', () => {
  it('exporta exatamente os mesmos nomes de antes da divisão em submódulos', () => {
    assert.deepEqual(Object.keys(barrel).sort(), [...PUBLIC_API].sort());
  });

  it('não há nomes duplicados entre submódulos (um dono por regra de negócio)', () => {
    const owners = new Map();
    for (const [file, mod] of Object.entries({ money, schemas, validation, ledger, subscriptions, debtors, goals, cards })) {
      for (const name of Object.keys(mod)) {
        assert.ok(!owners.has(name), `${name} exportado por ${owners.get(name)} e ${file}`);
        owners.set(name, file);
      }
    }
  });

  it('cada função do barrel é a MESMA do submódulo dono (sem reimplementação)', () => {
    assert.equal(barrel.parseMoneyToCents, money.parseMoneyToCents);
    assert.equal(barrel.accountBalances, ledger.accountBalances);
    assert.equal(barrel.validateEntity, validation.validateEntity);
    assert.equal(barrel.debtorObligations, debtors.debtorObligations);
    assert.equal(barrel.applyGoalTransaction, goals.applyGoalTransaction);
    assert.equal(barrel.splitInstallments, cards.splitInstallments);
    assert.equal(barrel.SCHEMAS, schemas.SCHEMAS);
  });
});

describe('js/utils/money.js — fonte única de dinheiro', () => {
  it('golden values de parse/format (centavos inteiros)', () => {
    assert.equal(money.parseMoneyToCents('R$ 1.234,56'), 123456);
    assert.equal(money.parseMoneyToCents('1.234'), 123400);
    assert.equal(money.parseMoneyToCents('1234.56'), 123456);
    assert.equal(money.parseMoneyToCents('abc'), null);
    assert.equal(money.parseMoneyToCents('-1'), null);
    assert.equal(money.centsToMoneyString(123456), '1234,56');
    assert.equal(money.centsToMoneyString(5), '0,05');
    assert.equal(money.centsToMoneyString(-1), null);
    assert.equal(money.formatCents(123456), 'R$ 1.234,56');
    assert.equal(money.formatCents(-5), '-R$ 0,05');
    assert.equal(money.formatCents(1.5), '—');
  });

  it('ida e volta: formatar para o campo e interpretar devolve os mesmos centavos', () => {
    for (const cents of [0, 1, 99, 100, 12345, 99999999]) {
      assert.equal(money.parseMoneyToCents(money.centsToMoneyString(cents)), cents);
    }
  });

  it('a implementação paralela removida (float) não voltou', () => {
    for (const name of ['toCents', 'fromCents', 'formatBRL', 'isValidCents']) assert.equal(name in money, false);
  });
});
