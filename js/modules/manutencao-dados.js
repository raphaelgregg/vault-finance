/**
 * Manutenção de dados (VF-2-03u): limpeza, massa de testes e importação/exportação CSV. Rota dedicada
 * `/manutencao-dados`, aberta a QUALQUER usuário autenticado (ações pessoais, restritas ao próprio uid pelas Rules);
 * os escopos "usuário específico" e "banco inteiro" só aparecem com a claim `admin === true`. Toda ação destrutiva
 * exige confirmação digitada.
 */
import { el, $, toast, refreshIcons } from '../components/dom.js';
import { field, mount, emptyBlock } from '../components/form-kit.js';
import { canAccessMaintenance, CONFIRM_PHRASES } from '../utils/maintenance-config.js';
import { setAdminClaim, parseAdminTarget, listAdminUsers, buildAdminUserRows } from '../services/adminClaims.js';
import { clearOwnData, clearScope, discoverUsers, isAdminUser, SCOPES } from '../services/maintenance.js';
import { seedFullTestSuite, MAX_VOLUME } from '../services/seed.js';
import {
  IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS,
  templateCsv, unifiedTemplateCsv, loadImportData, dryRunImport, applyImport, exportCsv, exportAllCsv, exportUnifiedCsv, UNIFIED_KEY, UNIFIED_COLUMN,
} from '../services/importer.js';

export const meta = { title: 'Manutenção de dados', icon: 'wrench' };

let user = null;
let lastPlan = null; // resultado do dry-run da última validação
let lastPlanText = null;

function downloadText(filename, text) {
  downloadBlob(filename, text, 'text/csv;charset=utf-8');
}

function downloadBlob(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Área de log: uma linha por evento; `permission-denied` fica em destaque. */
function makeLog(id) {
  const box = el('div', { id, class: 'maint-log', role: 'log', 'aria-live': 'polite' });
  const write = (text, kind = 'info') => {
    const denied = /permission-denied/i.test(text);
    const line = el('div', { class: `maint-log__line maint-log__line--${denied ? 'denied' : kind}` });
    line.textContent = denied ? `⚠ PERMISSION-DENIED — ${text}` : text;
    box.append(line);
    box.scrollTop = box.scrollHeight;
  };
  return { box, write, clear: () => box.replaceChildren() };
}

export async function render(container, ctx) {
  user = ctx.user;
  if (!canAccessMaintenance(user)) {
    mount(container, el('section', { class: 'panel' }, [
      el('div', { class: 'panel__body' }, [emptyBlock('lock', 'Sessão necessária', 'Entre na sua conta para acessar a manutenção de dados.')]),
    ]));
    refreshIcons();
    return;
  }

  const admin = await isAdminUser(user);
  const cleanLog = makeLog('clean-log');
  const seedLog = makeLog('seed-log');
  const importLog = makeLog('import-log');
  const busy = new Set();
  const guard = (button, fn) => async () => {
    if (busy.size) { toast('Aguarde a operação em andamento.'); return; }
    busy.add(button);
    button.disabled = true;
    try { await fn(); } finally { busy.delete(button); button.disabled = false; }
  };

  // ---------------- Limpeza (escopos own | target_uid | all_users) ----------------
  const radio = (id, value, checked = false) => el('input', { type: 'radio', id, name: 'clean-mode', value, checked });
  const modeOwn = radio('mode-own', SCOPES.OWN, true);
  const modeTarget = admin ? radio('mode-target', SCOPES.TARGET) : null;
  const modeAll = admin ? radio('mode-all', SCOPES.ALL) : null;
  const targetUid = el('input', { type: 'text', id: 'target-uid', autocomplete: 'off', placeholder: 'uid do usuário alvo' });
  const detected = el('select', { id: 'detected-users', 'aria-label': 'Usuários detectados' }, [el('option', { value: '' }, '— usuários detectados —')]);
  detected.addEventListener('change', () => { if (detected.value) targetUid.value = detected.value; });
  const detectBtn = el('button', { type: 'button', id: 'btn-detect', class: 'btn btn--secondary', text: 'Detectar usuários (amostra)' });
  const cleanPhrase = el('input', { type: 'text', id: 'clean-phrase', autocomplete: 'off' });
  const cleanBtn = el('button', { type: 'button', id: 'btn-clean', class: 'btn btn--danger', text: 'Limpar' });
  const currentScope = () => (modeAll?.checked ? SCOPES.ALL : modeTarget?.checked ? SCOPES.TARGET : SCOPES.OWN);
  const phraseOf = (scope) => ({ [SCOPES.OWN]: CONFIRM_PHRASES.user, [SCOPES.TARGET]: CONFIRM_PHRASES.target, [SCOPES.ALL]: CONFIRM_PHRASES.database })[scope];
  const updatePlaceholder = () => { cleanPhrase.placeholder = `Digite: ${phraseOf(currentScope())}`; };
  for (const r of [modeOwn, modeTarget, modeAll]) r?.addEventListener('change', updatePlaceholder);
  updatePlaceholder();

  const logClear = (r) => {
    const base = `${r.collection}: ${r.deleted} apagado(s) em ${r.batches ?? 0} lote(s)${r.byUid && Object.keys(r.byUid).length ? ` (usuários: ${Object.keys(r.byUid).length})` : ''}`;
    if (r.error) cleanLog.write(`${base} — FALHA: ${r.error}${r.collection === 'auditLog' ? ' (auditLog é imutável por regra: create-only, inclusive para o administrador)' : ''}`, 'error');
    else cleanLog.write(base, 'ok');
  };
  detectBtn?.addEventListener('click', guard(detectBtn, async () => {
    cleanLog.write('Detectando usuários por consulta de grupo (amostra de até 500 documentos por coleção)…');
    const res = await discoverUsers();
    detected.replaceChildren(el('option', { value: '' }, `— ${res.users.length} usuário(s) detectado(s) —`), ...res.users.map((u) => el('option', { value: u.uid }, `${u.uid} · ${u.docs} doc(s) · ${u.collections.join(', ')}`)));
    for (const e of res.errors) cleanLog.write(`${e.collection}: FALHA ao detectar — ${e.error}`, 'error');
    cleanLog.write(`${res.users.length} usuário(s) detectado(s) (amostra; não existe lista oficial de usuários).`, 'ok');
  }));
  cleanBtn.addEventListener('click', guard(cleanBtn, async () => {
    const scope = currentScope();
    const phrase = phraseOf(scope);
    if (cleanPhrase.value.trim() !== phrase) { toast(`Confirmação inválida. Digite exatamente: ${phrase}`, 5000); return; }
    const target = targetUid.value.trim();
    if (scope === SCOPES.TARGET && !target) { toast('Informe ou selecione o uid alvo.', 4000); return; }
    cleanLog.clear();
    cleanLog.write(`Executor (adminUid): ${user.uid} · escopo: ${scope}${scope === SCOPES.TARGET ? ` · targetUid: ${target}` : ''}`);
    const res = await clearScope({ scope, adminUid: user.uid, targetUid: target, admin, onLog: logClear });
    if (res.error && res.deleted === undefined) { cleanLog.write(`Recusado: ${res.error}`, 'error'); return; }
    cleanLog.write(`Concluído [${res.scope}]${res.targetUid ? ` alvo ${res.targetUid}` : ''}: ${res.deleted} documento(s) apagado(s); ${res.failures} coleção(ões) com falha${res.permissionDenied ? ` (${res.permissionDenied} permission-denied)` : ''}.`, res.failures ? 'error' : 'ok');
    if (res.byUid) cleanLog.write(`Por usuário: ${Object.entries(res.byUid).map(([u, n]) => `${u}=${n}`).join(', ') || 'nenhum documento encontrado'}`);
    cleanLog.write(res.auditError ? `Auditoria-resumo NÃO gravada: ${res.auditError}` : 'Auditoria-resumo gravada no log do executor.', res.auditError ? 'error' : 'info');
    cleanPhrase.value = '';
  }));

  const cleanPanel = el('section', { class: 'panel', id: 'panel-clean' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Limpeza' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'notice', role: 'alert', text: `Apaga dados REAIS do Firestore. Executor: ${user.uid}${admin ? ' (ADMINISTRADOR — claim admin ativa)' : ''}.` }),
      el('label', {}, [modeOwn, ' Limpar meus dados — só o meu uid (coleções de domínio; tenta auditLog, que é imutável)']),
      ...(admin
        ? [
          el('label', {}, [modeTarget, ' Limpar usuário específico (admin) — sem entrar na conta dele']),
          el('div', { id: 'admin-target', class: 'form__row' }, [field('uid alvo', 'target-uid', targetUid), field('Usuários detectados', 'detected-users', detected), detectBtn]),
          el('label', {}, [modeAll, ' Limpar banco inteiro — TODOS os usuários (admin)']),
        ]
        : [el('p', { class: 'card__hint', id: 'admin-unavailable', text: 'Escopos administrativos (usuário específico / todos os usuários) indisponíveis: seu token não tem a claim admin. Configure-a pelo Admin SDK (ver PLAN.md, VF-2-03w).' })]),
      field('Confirmação digitada *', 'clean-phrase', cleanPhrase),
      cleanBtn,
      cleanLog.box,
    ]),
  ]);

  // ---------------- Administradores (só com a claim admin) ----------------
  let adminPanel = null;
  if (admin) {
    const adminTarget = el('input', { type: 'text', id: 'admin-target-input', autocomplete: 'off', placeholder: 'uid ou e-mail do usuário', maxlength: 128 });
    const adminAction = el('select', { id: 'admin-action', 'aria-label': 'Ação' }, [
      el('option', { value: 'grant' }, 'Tornar administrador'),
      el('option', { value: 'revoke' }, 'Revogar administrador'),
    ]);
    const adminPhrase = el('input', { type: 'text', id: 'admin-phrase', autocomplete: 'off' });
    const adminResult = el('div', { id: 'admin-result', class: 'card__hint', role: 'status' });
    const adminBtn = el('button', { type: 'button', id: 'btn-admin-claim', class: 'btn btn--danger', text: 'Aplicar' });
    const phraseFor = () => (adminAction.value === 'revoke' ? CONFIRM_PHRASES.revokeAdmin : CONFIRM_PHRASES.grantAdmin);
    const refreshPhrase = () => { adminPhrase.placeholder = `Digite: ${phraseFor()}`; };
    adminAction.addEventListener('change', refreshPhrase);
    refreshPhrase();
    // Lista de usuários/administradores (GET /api/admin-claims) com ação rápida que preenche o formulário.
    const usersBox = el('div', { id: 'admin-users' });
    const usersSummary = el('p', { class: 'card__hint', id: 'admin-users-summary', role: 'status' });
    const refreshBtn = el('button', { type: 'button', id: 'btn-admin-refresh', class: 'btn btn--secondary', text: 'Atualizar lista' });
    const loadUsers = async () => {
      usersSummary.textContent = 'Carregando usuários…';
      const res = await listAdminUsers(user);
      if (!res.ok) { usersSummary.textContent = `Falha ao listar: ${res.error}`; usersBox.replaceChildren(); return; }
      const { rows, admins, others } = buildAdminUserRows(res.users, res.me);
      usersSummary.textContent = `${admins} administrador(es) e ${others} outro(s) usuário(s)${res.truncated ? ' — lista truncada em 5.000' : ''}.`;
      const pick = (row) => {
        adminTarget.value = row.uid;
        adminAction.value = row.action === 'revoke' ? 'revoke' : 'grant';
        refreshPhrase();
        adminPhrase.value = '';
        adminPhrase.focus();
        adminResult.textContent = `Alvo selecionado: ${row.label}. Digite a frase de confirmação (${phraseFor()}) e clique em Aplicar.`;
      };
      usersBox.replaceChildren(el('div', { class: 'table-wrap' }, [el('table', { class: 'table', id: 'admin-users-table' }, [
        el('thead', {}, [el('tr', {}, ['Usuário', 'Nome', 'Papel', 'Situação', 'Ação'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows.map((row) => el('tr', { 'data-uid': row.uid, 'data-admin': String(row.admin) }, [
          el('td', { text: `${row.label}${row.isMe ? ' (você)' : ''}` }),
          el('td', { text: row.displayName ?? '—' }),
          el('td', {}, [el('strong', { text: row.admin ? 'Administrador' : 'Usuário' })]),
          el('td', { text: row.disabled ? 'Desativado' : 'Ativo' }),
          el('td', {}, row.action
            ? [el('button', { type: 'button', class: row.action === 'revoke' ? 'btn btn--danger' : 'btn btn--secondary', 'aria-label': `${row.action === 'revoke' ? 'Revogar admin de' : 'Promover a admin'} ${row.label}`, onClick: () => pick(row), text: row.action === 'revoke' ? 'Revogar admin' : 'Promover a admin' })]
            : [row.isMe ? '—' : '']),
        ]))),
      ])]));
    };
    refreshBtn.addEventListener('click', guard(refreshBtn, loadUsers));
    queueMicrotask(() => { loadUsers(); });
    adminBtn.addEventListener('click', guard(adminBtn, async () => {
      const parsed = parseAdminTarget(adminTarget.value);
      if (!parsed.ok) { adminResult.textContent = parsed.error; return; }
      if (adminPhrase.value.trim() !== phraseFor()) { toast(`Confirmação inválida. Digite exatamente: ${phraseFor()}`, 5000); return; }
      adminResult.textContent = 'Aplicando…';
      const res = await setAdminClaim(user, { target: parsed.target, admin: adminAction.value === 'grant' });
      if (!res.ok) { adminResult.textContent = `Falha: ${res.error}`; toast(res.error, 6000); return; }
      adminResult.textContent = `${res.admin ? 'PROMOVIDO' : 'REVOGADO'}: ${res.target.email ?? res.target.uid} (uid ${res.target.uid}). ${res.note}${res.previousAdmin === res.admin ? ' (já estava neste estado)' : ''}${res.auditError ? ` Auditoria não gravada: ${res.auditError}` : ' Ação registrada no auditLog.'}`;
      toast(res.admin ? 'Administrador promovido.' : 'Administrador revogado.');
      adminPhrase.value = '';
      await loadUsers(); // lista atualizada com o novo papel
    }));
    adminPanel = el('section', { class: 'panel', id: 'panel-admins' }, [
      el('div', { class: 'panel__header' }, [el('h2', { text: 'Administradores' })]),
      el('div', { class: 'panel__body' }, [
        el('p', { class: 'notice', role: 'alert', text: 'Concede ou retira a claim `admin` (leitura e exclusão de dados de TODOS os usuários). A alteração é feita no servidor; o usuário precisa sair e entrar de novo (ou renovar o token; até 1 hora) para valer. Você não pode revogar a si mesmo.' }),
        field('Usuário (uid ou e-mail) *', 'admin-target-input', adminTarget),
        field('Ação', 'admin-action', adminAction),
        field('Confirmação digitada *', 'admin-phrase', adminPhrase),
        adminBtn,
        adminResult,
        el('h3', { text: 'Usuários e administradores' }),
        refreshBtn,
        usersSummary,
        usersBox,
      ]),
    ]);
  }

  // ---------------- Massa de testes ----------------
  const volume = el('input', { type: 'number', id: 'seed-volume', min: 0, max: MAX_VOLUME, value: 0 });
  const seedBtn = el('button', { type: 'button', id: 'btn-seed', class: 'btn btn--primary', text: 'Gerar massa de testes' });
  const resetPhrase = el('input', { type: 'text', id: 'reset-phrase', autocomplete: 'off', placeholder: `Digite: ${CONFIRM_PHRASES.reset}` });
  const resetBtn = el('button', { type: 'button', id: 'btn-reset', class: 'btn btn--danger', text: 'Resetar + Gerar massa' });
  const runSeed = async () => {
    seedLog.write(`Gerando pacote de testes (volume ×${Number(volume.value) || 0})…`);
    const res = await seedFullTestSuite(user.uid, {
      volume: Number(volume.value) || 0,
      onLog: (s) => seedLog.write(`${s.ok ? '✔' : '✖'} ${s.name}${s.ok ? ` — ${s.detail ?? ''}` : ` — ${s.error}`}`, s.ok ? 'ok' : 'error'),
    });
    seedLog.write(`Fim: ${res.ok} etapa(s) ok, ${res.failed} com falha.`);
    return res;
  };
  seedBtn.addEventListener('click', guard(seedBtn, async () => { seedLog.clear(); await runSeed(); }));
  resetBtn.addEventListener('click', guard(resetBtn, async () => {
    if (resetPhrase.value.trim() !== CONFIRM_PHRASES.reset) { toast(`Confirmação inválida. Digite exatamente: ${CONFIRM_PHRASES.reset}`, 5000); return; }
    seedLog.clear();
    seedLog.write('Limpando meu usuário antes de gerar…');
    const res = await clearOwnData(user.uid, { onLog: (r) => seedLog.write(`${r.collection}: ${r.deleted} apagado(s)${r.error ? ` — FALHA: ${r.error}` : ''}`, r.error ? 'error' : 'ok') });
    if (res.failures) { seedLog.write('Limpeza com falhas: geração cancelada.', 'error'); return; }
    await runSeed();
    resetPhrase.value = '';
  }));
  const seedPanel = el('section', { class: 'panel', id: 'panel-seed' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Massa de testes' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: 'Contas, caixinha/metas, receitas, despesas, orçamentos (ok/atenção/estourado), cartões e faturas (aberta, fechada, paga, cancelada, consolidada), assinaturas, devedores e dívidas — pelos services do app.' }),
      field(`Volume (0–${MAX_VOLUME}; cada unidade = 20 despesas + 20 receitas)`, 'seed-volume', volume),
      seedBtn,
      field('Confirmação para resetar *', 'reset-phrase', resetPhrase),
      resetBtn,
      seedLog.box,
    ]),
  ]);

  // ---------------- Importação / exportação ----------------
  const entitySelect = el('select', { id: 'import-entity', 'aria-label': 'Entidade' }, [
    el('option', { value: UNIFIED_KEY }, 'Todas as entidades (CSV unificado)'),
    ...IMPORT_ENTITY_KEYS.map((k) => el('option', { value: k }, IMPORT_ENTITIES[k].label)),
  ]);
  entitySelect.value = IMPORT_ENTITY_KEYS[0]; // padrão: uma entidade; "Todas" é opt-in
  const isUnified = () => entitySelect.value === UNIFIED_KEY;
  const entityLabel = () => (isUnified() ? 'Todas as entidades' : IMPORT_ENTITIES[entitySelect.value].label);
  const delimSelect = el('select', { id: 'import-delim', 'aria-label': 'Delimitador do modelo' }, [el('option', { value: ';' }, 'Ponto e vírgula (;)'), el('option', { value: ',' }, 'Vírgula (,)')]);
  const csvText = el('textarea', { id: 'import-text', rows: 8, placeholder: 'Cole o CSV aqui (UTF-8, ; ou ,) ou escolha um arquivo', 'aria-label': 'Conteúdo CSV' });
  const fileInput = el('input', { type: 'file', id: 'import-file', accept: '.csv,text/csv,text/plain' });
  fileInput.addEventListener('change', async () => { const f = fileInput.files?.[0]; if (f) { csvText.value = await f.text(); invalidatePlan(); } });
  csvText.addEventListener('input', invalidatePlan);
  const summary = el('div', { id: 'import-summary', class: 'card__hint', role: 'status' });
  const rowsBox = el('div', { id: 'import-rows' });
  const validateBtn = el('button', { type: 'button', id: 'btn-validate', class: 'btn btn--secondary', text: 'Validar (dry-run, não grava)' });
  const applyBtn = el('button', { type: 'button', id: 'btn-apply', class: 'btn btn--primary', text: 'Importar linhas válidas', disabled: true });

  function invalidatePlan() { lastPlan = null; lastPlanText = null; applyBtn.disabled = true; }

  const renderPlan = (plan) => {
    const c = plan.counts ?? { create: plan.valid, merge: 0, duplicate: 0 };
    summary.textContent = `${plan.total} linha(s) lida(s): ${plan.valid} válida(s), ${plan.invalid} com erro, ${plan.warnings} aviso(s). Novas: ${c.create} · a atualizar: ${c.merge} · duplicadas (ignoradas): ${c.duplicate}. Delimitador "${plan.delimiter}".`;
    const problems = [
      ...plan.fileErrors.map((e) => `Arquivo${e.line ? ` (linha ${e.line})` : ''}: ${e.message}`),
      ...plan.rows.flatMap((r) => [
        ...Object.entries(r.errors).map(([c, m]) => `Linha ${r.line}${r.entity && isUnified() ? ` [${r.entity}]` : ''} · ${c}: ${m}`),
        ...r.warnings.map((w) => `Linha ${r.line} · aviso: ${w}`),
      ]),
    ];
    rowsBox.replaceChildren(problems.length
      ? el('ul', { class: 'maint-problems' }, problems.map((p) => el('li', { text: p })))
      : el('p', { class: 'card__hint', text: 'Nenhum erro ou aviso.' }));
  };

  validateBtn.addEventListener('click', guard(validateBtn, async () => {
    importLog.clear();
    const data = await loadImportData(user.uid); // sempre o uid AUTENTICADO (mesmo para administrador)
    const plan = dryRunImport(entitySelect.value, csvText.value, data);
    renderPlan(plan);
    lastPlan = plan;
    lastPlanText = csvText.value;
    applyBtn.disabled = !((plan.counts?.create ?? 0) + (plan.counts?.merge ?? 0) > 0 && !plan.missingColumns.length);
    importLog.write(`Dry-run de "${entityLabel()}": nada foi gravado.`);
  }));
  applyBtn.addEventListener('click', guard(applyBtn, async () => {
    if (!lastPlan || lastPlanText !== csvText.value) { toast('Valide o conteúdo atual antes de importar.', 4000); return; }
    importLog.clear();
    importLog.write(`Importando "${entityLabel()}" para o usuário ${user.uid}: ${lastPlan.counts.create} nova(s), ${lastPlan.counts.merge} a atualizar, ${lastPlan.counts.duplicate} duplicada(s) serão ignoradas…`);
    const LABEL = { created: 'criada', merged: 'atualizada', ignored: 'ignorada (duplicidade)', failed: 'FALHA' };
    const res = await applyImport(user.uid, lastPlan, {
      onLog: (e) => importLog.write(`Linha ${e.line} [${e.entity}]: ${LABEL[e.action]}${e.id ? ` (${e.id})` : ''}${e.message ? ` — ${e.message}` : ''}${e.changed?.length ? ` (campos: ${e.changed.join(', ')})` : ''}`, e.action === 'failed' ? 'error' : e.action === 'ignored' ? 'info' : 'ok'),
    });
    importLog.write(`Fim: ${res.created} criada(s), ${res.merged} atualizada(s), ${res.ignored} ignorada(s) por duplicidade, ${res.failed} falha(s)${res.permissionDenied ? ` (${res.permissionDenied} permission-denied)` : ''}.`, res.failed ? 'error' : 'ok');
    invalidatePlan();
  }));

  const templateBtn = el('button', { type: 'button', id: 'btn-template', class: 'btn btn--secondary', text: 'Baixar modelo CSV (vazio — só cabeçalhos)' });
  templateBtn.addEventListener('click', () => {
    if (isUnified()) {
      downloadText('modelo-todas-entidades.csv', unifiedTemplateCsv({ delimiter: delimSelect.value }));
      importLog.write(`Modelo UNIFICADO baixado: cabeçalho (coluna "${UNIFIED_COLUMN}" + colunas) e 1 linha-modelo por entidade, na ordem de dependência. Nenhum dado seu.`);
      return;
    }
    downloadText(`modelo-${entitySelect.value}.csv`, templateCsv(entitySelect.value, { delimiter: delimSelect.value }));
    importLog.write(`Modelo VAZIO de "${entityLabel()}" baixado (somente cabeçalhos, nenhum dado).`);
  });
  const exportBtn = el('button', { type: 'button', id: 'btn-export', class: 'btn btn--secondary', text: 'Exportar CSV da base atual (registros existentes)' });
  exportBtn.addEventListener('click', guard(exportBtn, async () => {
    if (isUnified()) {
      importLog.clear();
      importLog.write(`Exportando a base do usuário ${user.uid} (todas as entidades, 1 CSV)…`);
      const r = await exportUnifiedCsv(user.uid, {
        delimiter: delimSelect.value,
        onLog: (x) => importLog.write(x.ok ? `✔ ${x.label}: ${x.rowCount} registro(s)` : `✖ ${x.label}: FALHA — ${x.error}`, x.ok ? 'ok' : 'error'),
      });
      if (r.exported) downloadText(r.filename, r.text);
      importLog.write(`Fim: ${r.exported}/${r.results.length} entidade(s), ${r.totalRows} registro(s) no total${r.failed ? `, ${r.failed} com falha (fora do arquivo)` : ''}${r.exported ? ` — ${r.filename}` : ''}.`, r.failed ? 'error' : 'ok');
      return;
    }
    const r = await exportCsv(user.uid, entitySelect.value, { delimiter: delimSelect.value });
    downloadText(r.filename, r.text);
    importLog.write(`Exportados ${r.rowCount} registro(s) existente(s) de "${entityLabel()}" (${r.filename}).`, 'ok');
  }));
  const exportAllBtn = el('button', { type: 'button', id: 'btn-export-all', class: 'btn btn--primary', text: 'Exportar TODAS as entidades (.zip, 1 CSV por entidade)' });
  exportAllBtn.addEventListener('click', guard(exportAllBtn, async () => {
    importLog.clear();
    importLog.write(`Exportando as ${IMPORT_ENTITY_KEYS.length} entidades (registros existentes)…`);
    const res = await exportAllCsv(user.uid, {
      delimiter: delimSelect.value,
      onLog: (r) => importLog.write(r.ok ? `✔ ${r.label}: ${r.rowCount} registro(s) → ${r.filename}` : `✖ ${r.label}: FALHA — ${r.error}`, r.ok ? 'ok' : 'error'),
    });
    if (res.exported) downloadBlob(res.filename, res.zip, 'application/zip');
    importLog.write(`Fim: ${res.exported}/${IMPORT_ENTITY_KEYS.length} entidade(s) exportada(s), ${res.totalRows} registro(s) no total${res.failed ? `, ${res.failed} com falha (fora do pacote)` : ''}${res.exported ? ` — arquivo ${res.filename}` : ''}.`, res.failed ? 'error' : 'ok');
  }));

  const hint = () => (isUnified()
    ? `CSV unificado: 1ª coluna "${UNIFIED_COLUMN}" (${IMPORT_ENTITY_KEYS.join(', ')}) + as colunas de cada entidade; cada linha preenche só as colunas da sua entidade. Pode vir fora de ordem: é processado em contas → categorias → cartões → devedores → demais, e linhas podem citar (por nome) registros criados no próprio arquivo. Contas: a coluna "conta" traz só o nome da conta e "instituicao" a instituição (obrigatória quando o nome existe em mais de uma).`
    : IMPORT_ENTITIES[entitySelect.value].columns.map((c) => `${c.name}${c.required ? '*' : ''}${c.help ? ` (${c.help})` : ''}`).join(' · '));
  const explain = () => (isUnified()
    ? 'Modelo UNIFICADO = cabeçalho + 1 linha-modelo por entidade (nenhum dado seu). Exportar base populada = TODOS os registros do SEU usuário, de todas as entidades, em 1 CSV reimportável. Importar é idempotente: registros que já existem para você são ignorados (ou atualizados se o CSV trouxer campos diferentes).'
    : 'Modelo CSV = arquivo VAZIO, só com os cabeçalhos da entidade (nenhum dado). Exportar CSV da base atual = os REGISTROS JÁ EXISTENTES da entidade selecionada. "Exportar todas" gera um .zip com um CSV por entidade (as 11) mais _resumo.txt.');
  const columnsHint = el('p', { class: 'card__hint', id: 'import-columns', text: hint() });
  const explainEl = el('p', { class: 'card__hint', id: 'import-explain', text: explain() });
  const syncLabels = () => {
    columnsHint.textContent = hint();
    explainEl.textContent = explain();
    templateBtn.textContent = isUnified() ? 'Baixar modelo UNIFICADO (cabeçalho + 1 linha-modelo por entidade)' : 'Baixar modelo CSV (vazio — só cabeçalhos)';
    exportBtn.textContent = isUnified() ? 'Exportar base populada (todas as entidades, 1 CSV)' : 'Exportar CSV da base atual (registros existentes)';
  };
  entitySelect.addEventListener('change', () => { syncLabels(); invalidatePlan(); });

  const importPanel = el('section', { class: 'panel', id: 'panel-import' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Importação e exportação CSV' })]),
    el('div', { class: 'panel__body' }, [
      el('p', { class: 'card__hint', text: `Datas AAAA-MM-DD; valores em reais (1234,56 / 1.234,56) convertidos para centavos inteiros; referências por NOME (conta, categoria, cartão, devedor). Máx. ${MAX_IMPORT_ROWS} linhas por importação. Importar/exportar vale SEMPRE só para o seu usuário (mesmo sendo administrador). Reimportar não duplica.` }),
      field('Entidade', 'import-entity', entitySelect),
      columnsHint,
      field('Delimitador do modelo/exportação', 'import-delim', delimSelect),
      explainEl,
      el('div', {}, [templateBtn, ' ', exportBtn, ' ', exportAllBtn]),
      field('Arquivo CSV', 'import-file', fileInput),
      field('Ou cole o CSV', 'import-text', csvText),
      el('div', {}, [validateBtn, ' ', applyBtn]),
      summary,
      rowsBox,
      importLog.box,
    ]),
  ]);

  mount(container,
    el('section', { class: 'panel' }, [el('div', { class: 'panel__header' }, [el('div', {}, [el('h2', { text: 'Manutenção de dados' }), el('p', { class: 'card__hint', text: 'Limpeza, massa de testes e importação/exportação CSV.' }), el('p', { class: 'card__hint', id: 'maint-role', text: admin ? 'Seu acesso: ADMINISTRADOR (claim admin) — além dos seus dados, pode limpar um usuário específico ou todo o banco.' : 'Seu acesso: usuário comum — todas as ações valem apenas para os seus próprios dados.' })])])]),
    cleanPanel, adminPanel, seedPanel, importPanel, await loadValidationCenter(admin));
  refreshIcons();
}

/**
 * Central de validação do sistema (VF-UI-02): seção INDEPENDENTE, só para administradores. Carregada sob demanda e
 * isolada: qualquer falha aqui NUNCA impede os demais painéis (retorna null). O acesso real é decidido pelo servidor.
 */
async function loadValidationCenter(admin) {
  if (admin !== true) return null;
  try {
    const { createValidationCenter } = await import('../components/validation-center.js');
    return createValidationCenter();
  } catch (error) {
    console.error('[manutencao] central de validação indisponível', error);
    return null;
  }
}
