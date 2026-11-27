/**
 * Relatório de dívidas de um devedor em PDF (VF-FEAT-01) — PURO (sem DOM, rede ou Firebase).
 *
 * Duas visões, sempre a partir das MESMAS obrigações que a tela de parcelas mostra (`debtorObligations`):
 *  - `month`: parcelas do mês de referência (dívidas pelo mês do vencimento; compras no cartão pelo mês da fatura),
 *    pagas ou não, com o que falta receber no mês;
 *  - `open` : tudo que ainda está em aberto (restante > 0), de todos os meses, agrupado por mês.
 *
 * `buildDebtorReport` monta os dados (números e textos já formatados); `renderDebtorReportPdf` desenha o PDF com
 * `js/utils/pdf.js`. Dinheiro em centavos inteiros; nada é gravado.
 */
import { formatCents } from '../utils/money.js';
import { formatDateBR, formatMonthBR } from '../utils/dates.js';
import { PdfDocument, PAGE_A4 } from '../utils/pdf.js';
import { debtorPendingCents } from './model/debtors.js';

export const REPORT_MODES = Object.freeze({ MONTH: 'month', OPEN: 'open' });

const STATE_LABELS = Object.freeze({ paid: 'Paga', partial: 'Parcial', late: 'Atrasada', pending: 'Pendente', cancelled: 'Cancelada' });
const KIND_LABELS = Object.freeze({ cash: 'Dívida à vista', installment: 'Dívida parcelada', legacy: 'Parcela de empréstimo', card: 'Compra no cartão' });
const INVOICE_LABELS = Object.freeze({ open: 'fatura aberta', closed: 'fatura fechada', paid: 'fatura paga' });
const DEBTOR_STATUS_LABELS = Object.freeze({ open: 'Em aberto', paid: 'Quitado', cancelled: 'Cancelado' });

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const monthLabel = (month) => (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? capitalize(formatMonthBR(month)) : 'Sem mês definido');
const sum = (rows, key) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);

/** Situação exibida da parcela (derivada; nada é gravado): parcial > paga > cancelada > atrasada > pendente. */
export function reportState(item, today) {
  if (item.paymentState === 'cancelled' || item.status === 'cancelled') return 'cancelled';
  if (item.paymentState === 'partial') return 'partial';
  if (item.paymentState === 'paid' || item.status === 'paid') return 'paid';
  return typeof item.dueDate === 'string' && typeof today === 'string' && item.dueDate < today ? 'late' : 'pending';
}

function toRow(item, today) {
  const state = reportState(item, today);
  const detailParts = [KIND_LABELS[item.kind] ?? 'Parcela'];
  if (item.source === 'card') {
    if (item.cardName) detailParts.push(`Cartão ${item.cardName}`);
    if (INVOICE_LABELS[item.invoiceStatus]) detailParts.push(INVOICE_LABELS[item.invoiceStatus]);
  }
  const total = Number(item.installmentsTotal) || null;
  const number = Number(item.installmentNumber) || null;
  return {
    id: item.id,
    referenceMonth: item.referenceMonth ?? null,
    dueDate: typeof item.dueDate === 'string' ? item.dueDate : null,
    dueText: typeof item.dueDate === 'string' ? formatDateBR(item.dueDate) : '—',
    description: String(item.description ?? 'Sem descrição'),
    detail: detailParts.join(' · '),
    installment: number && total ? `${number}/${total}` : number ? String(number) : '—',
    amountCents: Number(item.amountCents) || 0,
    receivedCents: Number(item.receivedCents) || 0,
    remainingCents: Number(item.remainingCents) || 0,
    state,
    stateLabel: STATE_LABELS[state],
  };
}

/** Nome de arquivo seguro: `dividas-<nome>-<mes|em-aberto-AAAA-MM-DD>.pdf`. */
export function debtorReportFilename(debtorName, mode, month, today) {
  const slug = String(debtorName ?? 'devedor').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'devedor';
  return `dividas-${slug}-${mode === REPORT_MODES.MONTH ? month : `em-aberto-${today}`}.pdf`;
}

/**
 * Monta os dados do relatório.
 * @param {{ debtor: object, obligations: { items: object[], openCents: number, listedCents?: number, unlistedCents?: number },
 *   mode: 'month'|'open', month?: string, today: string }} input  `today` = AAAA-MM-DD (atraso e data de emissão).
 * @returns {{ mode, title, periodLabel, filename, debtor: {name, statusLabel}, issuedText, summary: {label, text}[],
 *   groups: {label, rows: object[], totals: object}[], totals: {amountCents, receivedCents, remainingCents, count},
 *   notes: string[], empty: boolean }}
 */
export function buildDebtorReport({ debtor, obligations, mode, month, today } = {}) {
  if (!debtor) throw new Error('Devedor obrigatório.');
  if (![REPORT_MODES.MONTH, REPORT_MODES.OPEN].includes(mode)) throw new Error('Modo de relatório inválido.');
  if (mode === REPORT_MODES.MONTH && !/^\d{4}-\d{2}$/.test(String(month ?? ''))) throw new Error('Mês de referência inválido (AAAA-MM).');
  const items = (obligations?.items ?? []).filter((i) => i.status !== 'cancelled' && i.paymentState !== 'cancelled');
  const selected = mode === REPORT_MODES.MONTH
    ? items.filter((i) => i.referenceMonth === month)
    : items.filter((i) => (Number(i.remainingCents) || 0) > 0);
  const rows = selected.map((i) => toRow(i, today));

  const byMonth = new Map();
  for (const row of rows) {
    if (!byMonth.has(row.referenceMonth)) byMonth.set(row.referenceMonth, []);
    byMonth.get(row.referenceMonth).push(row);
  }
  const groups = [...byMonth.entries()]
    .sort(([a], [b]) => String(a ?? '9999').localeCompare(String(b ?? '9999')))
    .map(([key, list]) => ({
      label: monthLabel(key),
      rows: list,
      totals: { amountCents: sum(list, 'amountCents'), receivedCents: sum(list, 'receivedCents'), remainingCents: sum(list, 'remainingCents'), count: list.length },
    }));
  const totals = { amountCents: sum(rows, 'amountCents'), receivedCents: sum(rows, 'receivedCents'), remainingCents: sum(rows, 'remainingCents'), count: rows.length };

  const openCents = Number.isInteger(obligations?.openCents) ? obligations.openCents : debtorPendingCents(debtor);
  const unlistedCents = Number(obligations?.unlistedCents) || 0;
  const isOpenDebtor = debtor.status === 'open';
  const notes = [];
  let summary;
  let title;
  let periodLabel;
  if (mode === REPORT_MODES.MONTH) {
    const label = monthLabel(month);
    // Mesmo critério do fechamento do mês na tela: só devedor em aberto, limitado ao total em aberto.
    const toReceiveCents = isOpenDebtor ? Math.min(totals.remainingCents, openCents) : 0;
    title = `Dívidas do mês — ${label}`;
    periodLabel = `Parcelas com vencimento em ${label} (compras no cartão: mês da fatura).`;
    summary = [
      { label: 'Total em aberto do devedor', text: formatCents(openCents) },
      { label: `A receber em ${label}`, text: formatCents(toReceiveCents) },
      { label: 'Valor das parcelas do mês', text: formatCents(totals.amountCents) },
      { label: 'Recebido nas parcelas do mês', text: formatCents(totals.receivedCents) },
    ];
    if (isOpenDebtor && totals.remainingCents > openCents) notes.push('O valor a receber no mês foi limitado ao total em aberto do devedor.');
  } else {
    title = 'Total em aberto';
    periodLabel = 'Todas as parcelas ainda não recebidas, de todos os meses.';
    summary = [
      { label: 'Total em aberto', text: formatCents(openCents) },
      { label: 'Emprestado', text: formatCents(Number(debtor.lentCents) || 0) },
      { label: 'Recebido', text: formatCents(Number(debtor.receivedCents) || 0) },
      { label: 'Parcelas em aberto', text: String(totals.count) },
    ];
    if (unlistedCents > 0) notes.push(`Há ${formatCents(unlistedCents)} em aberto sem parcelas detalhadas (valor informado sem parcelamento); por isso o total em aberto é maior que a soma das parcelas.`);
  }
  if (rows.some((r) => r.detail.includes('Compra no cartão'))) notes.push('Compra no cartão: o vencimento exibido é o da fatura; "—" indica fatura sem data de vencimento.');
  notes.push('"Atrasada": parcela pendente com vencimento anterior à data de emissão. Valores em reais (R$).');

  return {
    mode, title, periodLabel,
    filename: debtorReportFilename(debtor.name, mode, month, today),
    debtor: { name: String(debtor.name ?? 'Devedor'), statusLabel: DEBTOR_STATUS_LABELS[debtor.status] ?? '—' },
    issuedText: formatDateBR(today),
    summary, groups, totals, notes, empty: rows.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------------------------

const COLORS = Object.freeze({
  brand: '#1f7a5c', text: '#16202a', muted: '#5c6b7a', border: '#e3e8ee', zebra: '#f8fafb', band: '#eef2f5',
  paid: '#17794f', partial: '#b7791f', late: '#c0392b', pending: '#16202a', cancelled: '#5c6b7a', white: '#ffffff',
});
const M = Object.freeze({ left: 36, right: 36, top: 40, bottom: 48 });
const CONTENT_W = PAGE_A4.width - M.left - M.right;
const PAD = 4;
const COLS = Object.freeze([
  { key: 'dueText', label: 'Vencimento', w: 52, align: 'left' },
  { key: 'description', label: 'Descrição', w: 181, align: 'left' },
  { key: 'installment', label: 'Parc.', w: 34, align: 'center' },
  { key: 'amountCents', label: 'Valor', w: 64, align: 'right', money: true },
  { key: 'receivedCents', label: 'Recebido', w: 64, align: 'right', money: true },
  { key: 'remainingCents', label: 'Restante', w: 64, align: 'right', money: true },
  { key: 'stateLabel', label: 'Situação', w: 64, align: 'left' },
]);
const colX = (index) => M.left + COLS.slice(0, index).reduce((t, c) => t + c.w, 0);
const cellAnchor = (col, x) => (col.align === 'right' ? x + col.w - PAD : col.align === 'center' ? x + col.w / 2 : x + PAD);

/** Reduz a fonte até o texto caber na largura (mínimo 6 pt) — valores muito grandes não vazam da coluna. */
function fitSize(doc, text, maxWidth, size, bold) {
  let s = size;
  while (s > 6 && doc.measure(text, { size: s, bold }) > maxWidth) s -= 0.5;
  return s;
}

/**
 * Desenha o relatório e devolve os bytes do PDF (A4 retrato, várias páginas, cabeçalho da tabela repetido e rodapé
 * "Página i de N"). `now`: data de criação nos metadados (padrão: agora).
 */
export function renderDebtorReportPdf(report, { now = new Date() } = {}) {
  const doc = new PdfDocument({ title: `${report.title} — ${report.debtor.name}`, author: 'Vault Finance', now });
  const pageBottom = PAGE_A4.height - M.bottom;
  let y = 0;

  const drawTableHead = () => {
    doc.rect(M.left, y, CONTENT_W, 16, { fill: COLORS.brand });
    COLS.forEach((col, i) => doc.text(col.label, cellAnchor(col, colX(i)), y + 11, { size: 8, bold: true, color: COLORS.white, align: col.align }));
    y += 16;
  };
  const newPage = () => {
    doc.addPage();
    y = M.top;
    doc.text(`${report.title} — ${report.debtor.name} (continuação)`, M.left, y + 8, { size: 9, bold: true, color: COLORS.muted });
    y += 20;
    drawTableHead();
  };
  const ensure = (height) => { if (y + height > pageBottom) newPage(); };

  // --- primeira página: faixa, devedor, resumo -----------------------------------------------------------------
  doc.addPage();
  doc.rect(0, 0, PAGE_A4.width, 60, { fill: COLORS.brand });
  doc.text('Vault Finance', M.left, 24, { size: 9, color: COLORS.white });
  doc.text(report.title, M.left, 46, { size: 16, bold: true, color: COLORS.white });
  doc.text(`Emitido em ${report.issuedText}`, PAGE_A4.width - M.right, 24, { size: 8.5, color: COLORS.white, align: 'right' });

  doc.text('DEVEDOR', M.left, 84, { size: 7.5, color: COLORS.muted });
  doc.text(report.debtor.name, M.left, 101, { size: fitSize(doc, report.debtor.name, 330, 14, true), bold: true, color: COLORS.text });
  doc.text('SITUAÇÃO DO DEVEDOR', PAGE_A4.width - M.right, 84, { size: 7.5, color: COLORS.muted, align: 'right' });
  doc.text(report.debtor.statusLabel, PAGE_A4.width - M.right, 101, { size: 11, bold: true, color: COLORS.text, align: 'right' });
  doc.text(report.periodLabel, M.left, 120, { size: 9, color: COLORS.muted });

  const gap = 8;
  const cardW = (CONTENT_W - gap * (report.summary.length - 1)) / report.summary.length;
  report.summary.forEach((card, i) => {
    const x = M.left + i * (cardW + gap);
    doc.rect(x, 132, cardW, 50, { fill: COLORS.zebra, stroke: COLORS.border });
    doc.wrap(card.label, cardW - 12, { size: 7.5 }).slice(0, 2).forEach((line, n) => doc.text(line, x + 6, 144 + n * 9, { size: 7.5, color: COLORS.muted }));
    doc.text(card.text, x + 6, 175, { size: fitSize(doc, card.text, cardW - 12, 12, true), bold: true, color: COLORS.text });
  });

  y = 204;
  doc.text(report.mode === REPORT_MODES.MONTH ? 'Parcelas do mês' : 'Parcelas em aberto', M.left, y, { size: 11, bold: true, color: COLORS.text });
  y += 8;
  drawTableHead();

  // --- tabela --------------------------------------------------------------------------------------------------
  if (report.empty) {
    ensure(28);
    doc.text('Nenhuma parcela encontrada para este período.', M.left + PAD, y + 18, { size: 9, color: COLORS.muted });
    y += 28;
  }
  let zebra = false;
  for (const group of report.groups) {
    if (report.groups.length > 1) {
      ensure(16 + 24);
      doc.rect(M.left, y, CONTENT_W, 16, { fill: COLORS.band });
      doc.text(group.label, M.left + PAD, y + 11, { size: 8.5, bold: true, color: COLORS.text });
      doc.text(`Restante do mês: ${formatCents(group.totals.remainingCents)}`, M.left + CONTENT_W - PAD, y + 11, { size: 8, bold: true, color: COLORS.text, align: 'right' });
      y += 16;
    }
    for (const row of group.rows) {
      const descLines = doc.wrap(row.description, COLS[1].w - 2 * PAD, { size: 8 });
      const detailLines = row.detail ? doc.wrap(row.detail, COLS[1].w - 2 * PAD, { size: 7 }) : [];
      const height = 4 + descLines.length * 10 + detailLines.length * 9 + 3;
      ensure(height);
      if (zebra) doc.rect(M.left, y, CONTENT_W, height, { fill: COLORS.zebra });
      zebra = !zebra;
      const base = y + 11;
      COLS.forEach((col, i) => {
        const x = colX(i);
        if (col.key === 'description') {
          descLines.forEach((line, n) => doc.text(line, x + PAD, base + n * 10, { size: 8, color: COLORS.text }));
          detailLines.forEach((line, n) => doc.text(line, x + PAD, base + descLines.length * 10 + n * 9 - 1, { size: 7, color: COLORS.muted }));
        } else if (col.key === 'stateLabel') {
          doc.text(row.stateLabel, cellAnchor(col, x), base, { size: 8, bold: true, color: COLORS[row.state] ?? COLORS.text });
        } else if (col.money) {
          const text = formatCents(row[col.key]);
          doc.text(text, cellAnchor(col, x), base, { size: fitSize(doc, text, col.w - 2 * PAD, 8, false), color: COLORS.text, align: 'right' });
        } else {
          doc.text(row[col.key], cellAnchor(col, x), base, { size: 8, color: COLORS.text, align: col.align });
        }
      });
      doc.line(M.left, y + height, M.left + CONTENT_W, y + height, { color: COLORS.border, width: 0.4 });
      y += height;
    }
  }

  // --- totais ---------------------------------------------------------------------------------------------------
  if (!report.empty) {
    ensure(22);
    doc.rect(M.left, y + 2, CONTENT_W, 18, { fill: COLORS.band });
    doc.text(`Total (${report.totals.count} parcela${report.totals.count === 1 ? '' : 's'})`, M.left + PAD, y + 14, { size: 8.5, bold: true, color: COLORS.text });
    COLS.forEach((col, i) => {
      if (!col.money) return;
      const text = formatCents(report.totals[col.key]);
      doc.text(text, cellAnchor(col, colX(i)), y + 14, { size: fitSize(doc, text, col.w - 2 * PAD, 8.5, true), bold: true, color: COLORS.text, align: 'right' });
    });
    y += 26;
  }

  // --- observações ----------------------------------------------------------------------------------------------
  y += 8;
  for (const note of report.notes) {
    const lines = doc.wrap(note, CONTENT_W, { size: 7.5 });
    ensure(lines.length * 10 + 4);
    lines.forEach((line, n) => doc.text(line, M.left, y + 8 + n * 10, { size: 7.5, color: COLORS.muted }));
    y += lines.length * 10 + 4;
  }

  // --- rodapé em todas as páginas -------------------------------------------------------------------------------
  const total = doc.pageCount;
  for (let i = 0; i < total; i += 1) {
    doc.setPage(i);
    doc.line(M.left, PAGE_A4.height - 34, PAGE_A4.width - M.right, PAGE_A4.height - 34, { color: COLORS.border });
    doc.text(`Vault Finance — ${report.debtor.name} — ${report.title}`, M.left, PAGE_A4.height - 22, { size: 7.5, color: COLORS.muted });
    doc.text(`Página ${i + 1} de ${total}`, PAGE_A4.width - M.right, PAGE_A4.height - 22, { size: 7.5, color: COLORS.muted, align: 'right' });
  }
  return doc.toBytes();
}
