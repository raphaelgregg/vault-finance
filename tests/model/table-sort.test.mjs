/**
 * Ordenação e filtro de tabelas — lógica pura (js/utils/tableSort.js). Executar: node --test tests/model
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareCells, detectColumnType, filterIndexes, isEmptyValue, normalizeText, parseValue, sortedIndexes } from '../../js/utils/tableSort.js';

describe('detectColumnType', () => {
  it('reconhece valor em R$, número, data, mês e texto; vazios não contam', () => {
    assert.equal(detectColumnType(['R$ 55,90', 'R$ 1.200,00', '—']), 'number');
    assert.equal(detectColumnType(['-R$ 5,00', 'R$ 0,10']), 'number');
    assert.equal(detectColumnType(['3', '12', '7,5']), 'number');
    assert.equal(detectColumnType(['10%', '5,5%']), 'number');
    assert.equal(detectColumnType(['23/11/2026', '05/01/2027', '—']), 'date');
    assert.equal(detectColumnType(['11/2026', '01/2027']), 'month');
    assert.equal(detectColumnType(['Netflix', 'R$ 5,00']), 'text'); // misto → texto
    assert.equal(detectColumnType(['—', '']), 'text');
  });
});

describe('parseValue', () => {
  it('converte para chave comparável', () => {
    assert.equal(parseValue('R$ 1.234,56', 'number'), 1234.56);
    assert.equal(parseValue('-R$ 5,00', 'number'), -5);
    assert.equal(parseValue('1.5', 'number'), 1.5);
    assert.equal(parseValue('23/11/2026', 'date'), '2026-11-23');
    assert.equal(parseValue('11/2026', 'month'), '2026-11');
  });
});

describe('sortedIndexes', () => {
  const rows = [['Netflix', 'R$ 55,90', '23/11/2026'], ['spotify', 'R$ 1.200,00', '05/01/2027'], ['Água', '—', '31/12/2026'], ['Zé', 'R$ 9,90', '01/02/2026']];

  it('valores monetários: numérico (não alfabético), vazios por último nas DUAS direções', () => {
    assert.deepEqual(sortedIndexes(rows, 1, 'asc'), [3, 0, 1, 2]);
    assert.deepEqual(sortedIndexes(rows, 1, 'desc'), [1, 0, 3, 2]);
  });

  it('datas dd/mm/aaaa: cronológico', () => {
    assert.deepEqual(sortedIndexes(rows, 2, 'asc'), [3, 0, 2, 1]);
    assert.deepEqual(sortedIndexes(rows, 2, 'desc'), [1, 2, 0, 3]);
  });

  it('texto: sem diferenciar caixa/acento, números "naturais" (item 2 antes de item 10) e estável', () => {
    assert.deepEqual(sortedIndexes(rows, 0, 'asc'), [2, 0, 1, 3]);
    assert.deepEqual(sortedIndexes([['item 10'], ['item 2'], ['Item 2']], 0, 'asc'), [1, 2, 0]);
  });
});

describe('filterIndexes', () => {
  const rows = [['Netflix', 'Streaming'], ['Água', 'Casa'], ['Mercado', 'Alimentação']];
  it('sem acento/caixa, em qualquer célula, todos os termos (E)', () => {
    assert.deepEqual(filterIndexes(rows, 'AGUA'), [1]);
    assert.deepEqual(filterIndexes(rows, 'alimentacao'), [2]);
    assert.deepEqual(filterIndexes(rows, 'net stream'), [0]);
    assert.deepEqual(filterIndexes(rows, 'net casa'), []);
    assert.deepEqual(filterIndexes(rows, '   '), [0, 1, 2]);
  });
});

describe('utilitários', () => {
  it('normalizeText e isEmptyValue', () => {
    assert.equal(normalizeText('  AÇÃO Água '), 'acao agua');
    for (const v of ['', ' ', '—', '-', null, undefined]) assert.equal(isEmptyValue(v), true);
    assert.equal(isEmptyValue('0'), false);
    assert.equal(compareCells('b', 'a', 'text', 'desc'), -1);
  });
});
