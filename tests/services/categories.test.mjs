/**
 * Testes do serviço de Categorias (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCategoryKindOptions,
  categoryLabel,
  CATEGORY_LINK_COLLECTIONS,
  summarizeCategoryLinks,
  buildCategoryInUseMessage,
} from '../../js/services/categories.js';
import { buildEntity } from '../../js/core/model.js';

describe('categories service — validação', () => {
  it('getCategoryKindOptions retorna tipos esperados', () => {
    const options = getCategoryKindOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['income', 'expense', 'both']);
  });

  it('categoryLabel (fonte única de Receitas/Despesas/Assinaturas): "Nome (Tipo)" e só o nome se o tipo é desconhecido', () => {
    const [income] = getCategoryKindOptions();
    assert.equal(categoryLabel({ name: 'Salário', kind: 'income' }), `Salário (${income.label})`);
    assert.equal(categoryLabel({ name: 'Outra', kind: 'desconhecido' }), 'Outra');
  });

  it('buildEntity aceita categoria válida', () => {
    const valid = { name: 'Salário', kind: 'income', color: '#1f7a5c' };
    const { ok, data } = buildEntity('categories', valid);
    assert.ok(ok);
    assert.equal(data.name, 'Salário');
    assert.equal(data.kind, 'income');
  });

  it('buildEntity rejeita kind inválido', () => {
    const invalid = { name: 'Teste', kind: 'invalido', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.kind);
  });

  it('buildEntity rejeita nome vazio', () => {
    const invalid = { name: '   ', kind: 'income', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.name);
  });

  it('buildEntity rejeita nome > 60 caracteres', () => {
    const invalid = { name: 'x'.repeat(61), kind: 'income', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.name);
  });
});

describe('categories service — exclusão segura (checagem de vínculos)', () => {
  it('CATEGORY_LINK_COLLECTIONS cobre as coleções exigidas', () => {
    const names = CATEGORY_LINK_COLLECTIONS.map((item) => item.collection);
    assert.deepEqual(names, ['incomes', 'expenses', 'budgets', 'subscriptions', 'cardPurchases']);
    // Cada coleção precisa de um rótulo legível para a mensagem ao usuário.
    for (const item of CATEGORY_LINK_COLLECTIONS) {
      assert.equal(typeof item.label, 'string');
      assert.ok(item.label.length > 0);
    }
  });

  it('summarizeCategoryLinks marca como não usada quando todas as contagens são 0', () => {
    const summary = summarizeCategoryLinks([
      { collection: 'incomes', label: 'receitas', count: 0 },
      { collection: 'expenses', label: 'despesas', count: 0 },
      { collection: 'budgets', label: 'orçamentos', count: 0 },
      { collection: 'subscriptions', label: 'assinaturas', count: 0 },
    ]);
    assert.equal(summary.inUse, false);
    assert.equal(summary.total, 0);
    assert.deepEqual(summary.links, []);
  });

  it('summarizeCategoryLinks soma vínculos e mantém apenas coleções com uso', () => {
    const summary = summarizeCategoryLinks([
      { collection: 'incomes', label: 'receitas', count: 2 },
      { collection: 'expenses', label: 'despesas', count: 0 },
      { collection: 'budgets', label: 'orçamentos', count: 1 },
      { collection: 'subscriptions', label: 'assinaturas', count: 0 },
    ]);
    assert.equal(summary.inUse, true);
    assert.equal(summary.total, 3);
    assert.deepEqual(
      summary.links.map((link) => link.collection),
      ['incomes', 'budgets']
    );
  });

  it('summarizeCategoryLinks tolera entrada vazia e contagens inválidas', () => {
    const empty = summarizeCategoryLinks();
    assert.equal(empty.inUse, false);
    assert.equal(empty.total, 0);

    const invalid = summarizeCategoryLinks([
      { collection: 'incomes', label: 'receitas', count: -3 },
      { collection: 'expenses', label: 'despesas', count: 1.5 },
      { collection: 'budgets', label: 'orçamentos', count: 2 },
    ]);
    assert.equal(invalid.total, 2);
    assert.deepEqual(invalid.links.map((link) => link.collection), ['budgets']);
  });

  it('buildCategoryInUseMessage informa coleção e contagem', () => {
    const summary = summarizeCategoryLinks([
      { collection: 'incomes', label: 'receitas', count: 2 },
      { collection: 'expenses', label: 'despesas', count: 3 },
    ]);
    const message = buildCategoryInUseMessage(summary);
    assert.match(message, /não pode ser excluída/);
    assert.match(message, /receitas \(2\)/);
    assert.match(message, /despesas \(3\)/);
    assert.match(message, /5 registros/);
  });

  it('buildCategoryInUseMessage usa singular para um único vínculo', () => {
    const summary = summarizeCategoryLinks([
      { collection: 'budgets', label: 'orçamentos', count: 1 },
    ]);
    const message = buildCategoryInUseMessage(summary);
    assert.match(message, /orçamentos \(1\)/);
    assert.match(message, /1 registro\b/);
    assert.doesNotMatch(message, /1 registros/);
  });
});
