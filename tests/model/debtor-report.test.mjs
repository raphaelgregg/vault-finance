/**
 * VF-FEAT-01 — relatório de dívidas do devedor (`js/core/debtorReport.js`): dados do relatório (mês × total em aberto) e
 * PDF gerado. Usa `debtorObligations` real, as MESMAS obrigações da tela de parcelas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { debtorObligations, receivedByInstallment } from '../../js/core/model/debtors.js';
import { buildDebtorReport, renderDebtorReportPdf, reportState, debtorReportFilename, monthLabel, isoDateText, REPORT_MODES } from '../../js/core/debtorReport.js';
import { inspectPdf, drawnText } from '../services/helpers/pdf-inspect.mjs';

const TODAY = '2026-11-27';
const debtor = (over = {}) => ({ id: 'd1', name: 'João Álvaro', status: 'open', lentCents: 300000, receivedCents: 40000, ...over });

function ledger({ debtorOver, debts, purchases = [], invoices = [], payments = [] } = {}) {
  const d = debtor(debtorOver);
  const { byDebt, byPurchase } = receivedByInstallment(payments, []);
  const obligations = debtorObligations({
    debtor: d, debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases,
    invoicesById: new Map(invoices.map((i) => [i.id, i])), cardsById: new Map([['c1', 'Nubank']]),
  });
  return { debtor: d, obligations };
}
const debt = (id, n, total, cents, due, status = 'pending', extra = {}) => ({ id, description: 'Reforma', installmentNumber: n, installmentsTotal: total, principalCents: cents, dueDate: due, status, debtGroupId: 'g', ...extra });

describe('situação da parcela', () => {
  it('parcial > paga > cancelada > atrasada > pendente', () => {
    assert.equal(reportState({ paymentState: 'partial', status: 'pending', dueDate: '2026-01-01' }, TODAY), 'partial');
    assert.equal(reportState({ paymentState: 'paid', status: 'paid' }, TODAY), 'paid');
    assert.equal(reportState({ paymentState: 'cancelled', status: 'cancelled' }, TODAY), 'cancelled');
    assert.equal(reportState({ paymentState: 'pending', status: 'pending', dueDate: '2026-11-26' }, TODAY), 'late');
    assert.equal(reportState({ paymentState: 'pending', status: 'pending', dueDate: TODAY }, TODAY), 'pending', 'vence hoje não é atraso');
    assert.equal(reportState({ paymentState: 'pending', status: 'pending', dueDate: null }, TODAY), 'pending');
  });
});

describe('dívidas do mês', () => {
  const data = ledger({
    debts: [debt('a', 1, 3, 100000, '2026-11-10'), debt('b', 2, 3, 100000, '2026-12-10'), debt('c', 1, 1, 50000, '2026-11-25', 'paid'), debt('x', 1, 1, 70000, '2026-11-05', 'cancelled')],
    payments: [{ id: 'r1', debtId: 'a', amountCents: 30000 }, { id: 'r2', debtId: 'c', amountCents: 50000 }],
    purchases: [{ id: 'p1', cardId: 'c1', description: 'Notebook', installmentNumber: 2, installmentsTotal: 10, amountCents: 59900, purchaseDate: '2026-09-02', invoiceId: 'i1' }],
    invoices: [{ id: 'i1', status: 'closed', dueDate: '2026-11-15', referenceMonth: '2026-11' }],
  });
  const report = buildDebtorReport({ ...data, mode: REPORT_MODES.MONTH, month: '2026-11', today: TODAY });

  it('só o mês pedido, sem canceladas; mostra pagas; totais e situação', () => {
    const rows = report.groups[0].rows;
    assert.equal(report.groups.length, 1);
    assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'c', 'p1']);
    assert.deepEqual(rows.map((r) => [r.id, r.stateLabel]).sort(), [['a', 'Parcial'], ['c', 'Paga'], ['p1', 'Atrasada']]);
    assert.deepEqual(report.totals, { amountCents: 100000 + 50000 + 59900, receivedCents: 30000 + 50000, remainingCents: 70000 + 59900, count: 3 });
    assert.equal(report.title, 'Dívidas do mês — Novembro de 2026');
    assert.equal(report.empty, false);
  });
  it('cartão: detalhe com cartão e fatura, vencimento da fatura, parcela n/N', () => {
    const card = report.groups[0].rows.find((r) => r.id === 'p1');
    assert.equal(card.detail, 'Compra no cartão · Cartão Nubank · fatura fechada');
    assert.equal(card.dueText, '15/11/2026');
    assert.equal(card.installment, '2/10');
    assert.ok(report.notes.some((n) => /Compra no cartão: o vencimento/.test(n)));
  });
  it('resumo: a receber no mês = restante do mês, limitado ao total em aberto; devedor não aberto = 0', () => {
    const [openCard, toReceive] = report.summary;
    assert.equal(openCard.label, 'Total em aberto do devedor');
    assert.match(toReceive.label, /A receber em Novembro de 2026/);
    assert.ok(toReceive.text.includes('1.299,00'), toReceive.text); // 700,00 + 599,00
    const capped = buildDebtorReport({ ...ledger({ debtorOver: { lentCents: 100000, receivedCents: 40000 }, debts: [debt('a', 1, 1, 200000, '2026-11-10')] }), mode: 'month', month: '2026-11', today: TODAY });
    assert.ok(capped.summary[1].text.includes('600,00'), capped.summary[1].text);
    assert.ok(capped.notes.some((n) => /limitado ao total em aberto/.test(n)));
    const paid = buildDebtorReport({ ...ledger({ debtorOver: { status: 'paid' }, debts: [debt('a', 1, 1, 100000, '2026-11-10')] }), mode: 'month', month: '2026-11', today: TODAY });
    assert.ok(paid.summary[1].text.includes('0,00'));
    assert.equal(paid.debtor.statusLabel, 'Quitado');
  });
  it('mês sem parcelas: relatório vazio, mas válido', () => {
    const empty = buildDebtorReport({ ...data, mode: 'month', month: '2026-01', today: TODAY });
    assert.deepEqual([empty.empty, empty.groups.length, empty.totals.count], [true, 0, 0]);
    const { pages, streams } = inspectPdf(renderDebtorReportPdf(empty));
    assert.equal(pages, 1);
    assert.ok(drawnText(streams[0]).some((t) => /Nenhuma parcela encontrada/.test(t)));
  });
});

describe('total em aberto', () => {
  const data = ledger({
    debtorOver: { lentCents: 500000, receivedCents: 100000 },
    debts: [debt('a', 1, 3, 100000, '2026-10-10'), debt('b', 2, 3, 100000, '2026-12-10'), debt('c', 3, 3, 100000, '2026-11-10'), debt('d', 1, 1, 50000, '2026-09-10', 'paid')],
    payments: [{ id: 'r1', debtId: 'a', amountCents: 40000 }, { id: 'r2', debtId: 'd', amountCents: 50000 }],
  });
  const report = buildDebtorReport({ ...data, mode: REPORT_MODES.OPEN, today: TODAY });

  it('todas as parcelas com restante, agrupadas por mês em ordem cronológica; pagas ficam de fora', () => {
    assert.deepEqual(report.groups.map((g) => g.label), ['Outubro de 2026', 'Novembro de 2026', 'Dezembro de 2026']);
    assert.deepEqual(report.groups.map((g) => g.rows.map((r) => r.id)), [['a'], ['c'], ['b']]);
    assert.equal(report.totals.remainingCents, 60000 + 100000 + 100000);
    assert.equal(report.groups[0].totals.remainingCents, 60000);
    assert.equal(report.title, 'Total em aberto');
  });
  it('resumo e nota de saldo sem parcelas detalhadas', () => {
    assert.deepEqual(report.summary.map((s) => s.label), ['Total em aberto', 'Emprestado', 'Recebido', 'Parcelas em aberto']);
    assert.equal(report.summary[3].text, '3');
    assert.ok(report.summary[1].text.includes('5.000,00'));
    // total em aberto do devedor (4.000,00) maior que a soma das parcelas (2.600,00): 1.400,00 sem detalhamento
    assert.ok(report.notes.some((n) => /1\.400,00 em aberto sem parcelas detalhadas/.test(n)), report.notes.join(' | '));
  });
  it('nome de arquivo seguro', () => {
    assert.equal(report.filename, 'dividas-joao-alvaro-em-aberto-2026-11-27.pdf');
    assert.equal(debtorReportFilename('Maria  da Silva/Souza!', 'month', '2026-11', TODAY), 'dividas-maria-da-silva-souza-2026-11.pdf');
    assert.equal(debtorReportFilename('???', 'open', null, TODAY), 'dividas-devedor-em-aberto-2026-11-27.pdf');
    assert.ok(debtorReportFilename('x'.repeat(200), 'open', null, TODAY).length < 80);
  });
});

describe('entradas inválidas', () => {
  it('exige devedor, modo e mês válidos', () => {
    const { debtor: d, obligations } = ledger({ debts: [] });
    assert.throws(() => buildDebtorReport({ obligations, mode: 'open', today: TODAY }), /Devedor/);
    assert.throws(() => buildDebtorReport({ debtor: d, obligations, mode: 'ano', today: TODAY }), /Modo/);
    assert.throws(() => buildDebtorReport({ debtor: d, obligations, mode: 'month', month: '11/2026', today: TODAY }), /Mês/);
    assert.equal(buildDebtorReport({ debtor: d, obligations: { items: [], openCents: 0 }, mode: 'open', today: TODAY }).empty, true);
  });
});

describe('PDF gerado', () => {
  const many = Array.from({ length: 70 }, (_, i) => debt(`k${i}`, i + 1, 70, 10000 + i, `2026-${String((i % 12) + 1).padStart(2, '0')}-10`));
  const data = ledger({ debtorOver: { lentCents: 900000, receivedCents: 0 }, debts: many });

  it('estrutura válida, várias páginas com cabeçalho repetido, rodapé "Página i de N" e acentos', () => {
    const report = buildDebtorReport({ ...data, mode: 'open', today: TODAY });
    const bytes = renderDebtorReportPdf(report, { now: new Date('2026-11-27T10:00:00Z') });
    const { pages, streams, text } = inspectPdf(bytes);
    assert.ok(pages >= 3, `esperava ≥ 3 páginas, veio ${pages}`);
    const all = streams.map(drawnText);
    assert.ok(all[0].includes('Total em aberto') && all[0].includes('Jo\xe3o \xc1lvaro'), 'título e nome com acento');
    for (let i = 1; i < pages; i += 1) assert.ok(all[i].some((t) => /continua\xe7\xe3o/.test(t)) && all[i].includes('Vencimento'), `página ${i + 1}: continuação + cabeçalho da tabela`);
    all.forEach((texts, i) => assert.ok(texts.includes(`P\xe1gina ${i + 1} de ${pages}`), `rodapé da página ${i + 1}`));
    assert.ok(text.includes('/Title <FEFF'));
    assert.ok(all.flat().includes('Total (70 parcelas)'));
  });
  it('valores gigantes não vazam da coluna (fonte reduzida) e nada quebra com descrição enorme', () => {
    const huge = ledger({ debtorOver: { lentCents: 99999999999 }, debts: [debt('h', 1, 1, 99999999999, '2026-11-10', 'pending', { description: 'D'.repeat(300) })] });
    const bytes = renderDebtorReportPdf(buildDebtorReport({ ...huge, mode: 'month', month: '2026-11', today: TODAY }));
    const { streams } = inspectPdf(bytes);
    assert.ok(drawnText(streams[0]).some((t) => t.includes('999.999.999,99')));
  });
});

describe('meses e datas por texto — independem do fuso do navegador (regressão: mês/dia saíam 1 a menos no Brasil)', () => {
  it('monthLabel e isoDateText', () => {
    const names = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    names.forEach((n, i) => assert.equal(monthLabel(`2026-${String(i + 1).padStart(2, '0')}`), `${n} de 2026`));
    for (const bad of [null, '', '2026-13', '2026-00', '26-12', '2026-12-01', 'x']) assert.equal(monthLabel(bad), 'Sem mês definido', String(bad));
    assert.equal(isoDateText('2026-12-05'), '05/12/2026');
    assert.equal(isoDateText('2026-01-31'), '31/01/2026');
    for (const bad of [null, '', '2026-12', '05/12/2026']) assert.equal(isoDateText(bad), '—', String(bad));
  });

  it('o MESMO relatório em fusos de UTC−11 a UTC+14: título, grupo, vencimento e emissão corretos', () => {
    const url = new URL('../../js/core/debtorReport.js', import.meta.url).href;
    const modelUrl = new URL('../../js/core/model/debtors.js', import.meta.url).href;
    const code = `
      const { buildDebtorReport } = await import(${JSON.stringify(url)});
      const { debtorObligations } = await import(${JSON.stringify(modelUrl)});
      const debtor = { id: 'd', name: 'Roberta', status: 'open', lentCents: 100000, receivedCents: 0 };
      const debts = [{ id: 'a', description: 'Empréstimo', installmentNumber: 5, installmentsTotal: 10, principalCents: 23000, dueDate: '2026-12-10', status: 'pending', debtGroupId: 'g' }];
      const obligations = debtorObligations({ debtor, debts });
      const month = buildDebtorReport({ debtor, obligations, mode: 'month', month: '2026-12', today: '2026-11-26' });
      const open = buildDebtorReport({ debtor, obligations, mode: 'open', today: '2026-11-26' });
      console.info(JSON.stringify({ title: month.title, period: month.periodLabel, label: month.summary[1].label, due: month.groups[0].rows[0].dueText, issued: month.issuedText, group: open.groups[0].label, file: month.filename }));`;
    const expected = { title: 'Dívidas do mês — Dezembro de 2026', period: 'Parcelas com vencimento em Dezembro de 2026 (compras no cartão: mês da fatura).', label: 'A receber em Dezembro de 2026', due: '10/12/2026', issued: '26/11/2026', group: 'Dezembro de 2026', file: 'dividas-roberta-2026-12.pdf' };
    for (const TZ of ['UTC', 'America/Sao_Paulo', 'America/Noronha', 'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(out), expected, `TZ=${TZ}`);
    }
  });
});
