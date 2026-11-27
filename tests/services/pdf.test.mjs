/**
 * VF-FEAT-01 — gerador de PDF mínimo (`js/utils/pdf.js`): codificação WinAnsi, medição, quebra de linha e, principalmente,
 * a ESTRUTURA do arquivo (cada deslocamento da tabela xref aponta para o objeto certo; /Length confere).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PdfDocument, measureText, wrapText, toHex, winAnsiByte, PAGE_A4 } from '../../js/utils/pdf.js';
import { inspectPdf, drawnText } from './helpers/pdf-inspect.mjs';

describe('codificação e medição', () => {
  it('WinAnsi: português, símbolos e desconhecidos', () => {
    assert.equal(toHex('Ação'), '41e7e36f');
    assert.equal(winAnsiByte('—'), 0x97);
    assert.equal(winAnsiByte('“'), 0x93);
    assert.equal(winAnsiByte('•'), 0x95);
    assert.equal(winAnsiByte('€'), 0x80);
    assert.equal(winAnsiByte('漢'), 0x3f, 'fora de WinAnsi vira "?"');
    assert.equal(winAnsiByte('ń'), 'n'.charCodeAt(0), 'decompõe para a letra base');
    assert.equal(winAnsiByte('\n'), 0x20, 'controle vira espaço');
  });
  it('larguras da Helvetica (AFM): Hello a 10 pt; dígitos e vírgula do dinheiro são exatos', () => {
    assert.equal(measureText('Hello', { size: 10 }).toFixed(2), '22.78'); // (722+556+222+222+556)/100
    assert.equal(measureText('12.345,67', { size: 10 }).toFixed(2), '44.48'); // 7×556 + 2×278
    assert.equal(measureText('1234', { size: 10, bold: true }), measureText('1234', { size: 10 }), 'dígitos iguais em negrito');
    assert.ok(measureText('Hello', { size: 10, bold: true }) > measureText('Hello', { size: 10 }));
    assert.equal(measureText('ação', { size: 10 }), measureText('acao', { size: 10 }), 'acentuada = letra base');
    assert.equal(measureText('', { size: 10 }), 0);
  });
  it('quebra por palavras, respeita parágrafos e corta palavra maior que a linha', () => {
    const lines = wrapText('Empréstimo para reforma da cozinha e compra de eletrodomésticos', 100, { size: 8 });
    assert.ok(lines.length >= 3);
    for (const l of lines) assert.ok(measureText(l, { size: 8 }) <= 100 + 0.001, l);
    assert.equal(lines.join(' '), 'Empréstimo para reforma da cozinha e compra de eletrodomésticos');
    assert.deepEqual(wrapText('a\nb', 100), ['a', 'b']);
    const long = wrapText('x'.repeat(200), 50, { size: 10 });
    assert.ok(long.length > 1 && long.every((l) => measureText(l, { size: 10 }) <= 50.001));
    assert.deepEqual(wrapText('', 50), ['']);
  });
});

describe('estrutura do documento', () => {
  it('documento mínimo é válido (xref, /Length, metadados em UTF-16)', () => {
    const doc = new PdfDocument({ title: 'Dívidas — João', author: 'Vault Finance', now: new Date('2026-11-27T10:00:00Z') });
    doc.addPage();
    doc.text('Olá (mundo) \\ teste', 36, 60, { size: 12, bold: true, color: '#1f7a5c' });
    doc.line(36, 70, 500, 70, { color: '#e3e8ee' });
    doc.rect(36, 80, 100, 20, { fill: '#f8fafb', stroke: '#e3e8ee' });
    const { text, pages, streams } = inspectPdf(doc.toBytes());
    assert.equal(pages, 1);
    assert.ok(text.includes('/CreationDate (D:20261127100000Z)'));
    assert.ok(text.includes('/Title <FEFF'), 'título em UTF-16BE hexadecimal');
    assert.deepEqual(drawnText(streams[0]), ['Ol\xe1 (mundo) \\ teste'], 'parênteses e barra vão em hex: sem escapes');
    assert.ok(streams[0].includes('/F2 12 Tf'), 'negrito usa F2');
  });
  it('várias páginas; setPage desenha em página anterior; sem páginas gera uma em branco', () => {
    const doc = new PdfDocument();
    doc.addPage(); doc.addPage(); doc.addPage();
    doc.setPage(0);
    doc.text('Página 1 de 3', 559, 820, { size: 8, align: 'right' });
    assert.throws(() => doc.setPage(3), RangeError);
    const { pages, streams } = inspectPdf(doc.toBytes());
    assert.equal(pages, 3);
    assert.deepEqual(drawnText(streams[0]), ['P\xe1gina 1 de 3']);
    assert.deepEqual(drawnText(streams[1]), []);
    assert.equal(inspectPdf(new PdfDocument().toBytes()).pages, 1);
  });
  it('alinhamento: direita termina em x; centro divide a largura; tamanho A4', () => {
    const doc = new PdfDocument();
    doc.addPage();
    const w = measureText('R$ 1,00', { size: 10 });
    doc.text('R$ 1,00', 200, 50, { size: 10, align: 'right' });
    doc.text('R$ 1,00', 200, 70, { size: 10, align: 'center' });
    const [right, center] = doc.pages[0].map((op) => Number(/1 0 0 1 ([\d.]+) /.exec(op)[1]));
    assert.ok(Math.abs(right - (200 - w)) < 0.01);
    assert.ok(Math.abs(center - (200 - w / 2)) < 0.01);
    assert.deepEqual([doc.width, doc.height], [PAGE_A4.width, PAGE_A4.height]);
  });
  it('texto vazio e formas sem preenchimento não geram operações', () => {
    const doc = new PdfDocument();
    doc.addPage();
    doc.text('', 10, 10);
    doc.rect(0, 0, 10, 10, {});
    assert.deepEqual(doc.pages[0], []);
  });
});
