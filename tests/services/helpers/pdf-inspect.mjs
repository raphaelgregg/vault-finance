/** Auxiliares de teste: confere a ESTRUTURA de um PDF gerado (xref, /Length) e extrai os textos desenhados. */
import assert from 'node:assert/strict';

/** Confere a estrutura do PDF e devolve { text, pages, streams }. */
export function inspectPdf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'cabeçalho');
  assert.ok(text.endsWith('%%EOF\n'), 'fim do arquivo');
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n', 'startxref aponta para a tabela');
  const size = Number(/xref\n0 (\d+)\n/.exec(text.slice(startxref))[1]);
  const table = text.slice(startxref).split('\n').slice(2, 2 + size);
  assert.equal(table[0], '0000000000 65535 f ');
  for (let id = 1; id < size; id += 1) {
    assert.match(table[id], /^\d{10} 00000 n $/);
    const offset = Number(table[id].slice(0, 10));
    assert.ok(text.slice(offset).startsWith(`${id} 0 obj\n`), `objeto ${id} no deslocamento ${offset}`);
  }
  const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)].map((m) => {
    assert.equal(Number(m[1]), m[2].length, '/Length do conteúdo');
    return m[2];
  });
  const pages = Number(/\/Count (\d+)/.exec(text)[1]);
  assert.equal(streams.length, pages, 'um conteúdo por página');
  return { text, pages, streams };
}

/** Textos desenhados (strings hex WinAnsi → Latin-1), por página. */
export const drawnText = (stream) => [...stream.matchAll(/<([0-9a-f]+)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
