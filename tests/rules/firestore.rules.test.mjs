/**
 * Testes das Security Rules no Firebase Emulator Suite.
 *
 * Executar:  npm run test:rules
 * (sobe Firestore + Auth no emulador, roda os testes e derruba)
 *
 * Cobre, no mínimo, exigido na Fase 2:
 *  1. leitura de dados de outro usuário negada
 *  2. escrita em documento de outro usuário negada
 *  3. valor fracionário/negativo negado
 *  4. campo não previsto negado
 *  5. sem login negado
 *  6. criação/leitura válidas permitidas
 *  7. update/delete de auditLog negados
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before, after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  writeBatch,
  collectionGroup,
  getDocs,
  query,
  limit,
} from 'firebase/firestore';
import { serverTimestamp, deleteField, increment } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '..', '..', 'firestore.rules'), 'utf8');

const PROJECT_ID = 'demo-vault-finance';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let testEnv;

/** Contexto autenticado como um usuário. */
const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const asAnonymous = () => testEnv.unauthenticatedContext().firestore();

/** Grava documentos como a camada confiável (Admin SDK ignora as Rules): semeia estados que o cliente não pode criar. */
const seedDoc = (path, data) => testEnv.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01'), ...data }); });

/** Recebimento + total do devedor no MESMO lote (as Rules exigem que andem juntos: não existe recebimento solto). */
function receive(db, paymentRef, payload, debtorRef, incrementBy = payload.amountCents) {
  const batch = writeBatch(db);
  batch.set(paymentRef, payload);
  batch.update(debtorRef, { receivedCents: increment(incrementBy), updatedAt: serverTimestamp() });
  return batch.commit();
}

const account = {
  institution: 'Banco Exemplo',
  name: 'Conta principal',
  type: 'checking',
  initialBalanceCents: 150000,
  color: '#1f7a5c',
  status: 'active',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
};

const category = {
  name: 'Casa',
  kind: 'expense',
  color: '#c0392b',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
};

function expensePayload(overrides = {}) {
  return {
    description: 'Conta de luz',
    categoryId: 'cat-casa',
    amountCents: 12990,
    accountId: 'acc-main',
    purchaseDate: new Date('2026-11-01'),
    dueDate: new Date('2026-11-10'),
    status: 'pending',
    recurrence: 'monthly',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Semeia documentos referenciados sem passar pelas Rules (setup de teste).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'), account);
    await setDoc(doc(db, 'users', ALICE, 'categories', 'cat-casa'), category);
    await setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main2'), {
      ...account,
      name: 'Reserva',
      type: 'savings',
    });
    await setDoc(doc(db, 'users', BOB, 'accounts', 'acc-bob'), account);
    await setDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1'), {
      action: 'create',
      entity: 'accounts',
      entityId: 'acc-main',
      actorUid: ALICE,
      createdAt: new Date('2026-11-01'),
    });
  });
});

describe('Sem autenticação', () => {
  it('nega leitura da própria árvore', async () => {
    const db = asAnonymous();
    await assertFails(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
  });

  it('nega escrita em qualquer coleção', async () => {
    const db = asAnonymous();
    await assertFails(setDoc(doc(db, 'users', ALICE, 'accounts', 'novo'), account));
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload())
    );
  });
});

describe('Isolamento entre usuários', () => {
  it('nega leitura de dados de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
    await assertFails(getDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('nega escrita em documento de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'invasao'), account)
    );
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'), { ...account, name: 'Hackeada' })
    );
  });

  it('nega consulta à coleção raiz users', async () => {
    const db = asUser(ALICE);
    await assertFails(getDoc(doc(db, 'users', ALICE)));
  });
});

describe('Validação de valores monetários e campos', () => {
  it('nega valor fracionário (centavos devem ser inteiros)', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: 129.9 }))
    );
  });

  it('nega valor negativo', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: -5000 }))
    );
  });

  it('nega zero em movimentação', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ amountCents: 0 }))
    );
  });

  it('nega campo não previsto', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(
        collection(db, 'users', ALICE, 'expenses'),
        expensePayload({ saldoGravado: 999999 }) // snapshot de saldo é proibido por decisão de arquitetura
      )
    );
  });

  it('nega tipo de conta inválido', async () => {
    const db = asUser(ALICE);
    await assertFails(
      setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-x'), { ...account, type: 'conta-hacker' })
    );
  });

  it('nega status inválido', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload({ status: 'quitada' }))
    );
  });
});

describe('Operações válidas', () => {
  it('permite leitura dos próprios dados', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
  });

  // VF-1-02: as Rules não têm como contar vínculos na exclusão; a integridade
  // referencial de contas é garantida por services/accounts.js (fail-closed).
  // Este teste documenta o contrato: o dono exclui; terceiros não.
  it('exclusão de conta: o CLIENTE não exclui (nem o dono): só a camada confiável (account.delete) com checagem de histórico', async () => {
    await assertFails(deleteDoc(doc(asUser(BOB), 'users', ALICE, 'accounts', 'acc-main')));
    await assertFails(deleteDoc(doc(asUser(ALICE), 'users', ALICE, 'accounts', 'acc-main')));
  });

  it('permite criar despesa com centavos inteiros e referências válidas', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload())
    );
  });

  it('permite criar transferência PENDENTE entre contas distintas; CONFIRMADA só nasce na camada confiável (negada ao cliente)', async () => {
    const db = asUser(ALICE);
    const base = {
      fromAccountId: 'acc-main',
      toAccountId: 'acc-main2',
      amountCents: 5000,
      date: new Date('2026-11-02'),
      reason: 'Reserva',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await assertSucceeds(addDoc(collection(db, 'users', ALICE, 'transfers'), { ...base, status: 'pending' }));
    await assertFails(addDoc(collection(db, 'users', ALICE, 'transfers'), { ...base, status: 'confirmed' }));
  });

  it('nega transferência para a mesma conta', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'transfers'), {
        fromAccountId: 'acc-main',
        toAccountId: 'acc-main',
        amountCents: 5000,
        date: new Date('2026-11-02'),
        reason: 'Erro',
        status: 'confirmed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('nega referência a documento inexistente', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(
        collection(db, 'users', ALICE, 'expenses'),
        expensePayload({ accountId: 'acc-fantasma' })
      )
    );
  });

  it('nega referência a documento de outro usuário', async () => {
    const db = asUser(BOB);
    await assertFails(
      addDoc(
        collection(db, 'users', BOB, 'expenses'),
        expensePayload({ accountId: 'acc-main' }) // pertence a Alice
      )
    );
  });
});

describe('Separação de privilégios: usuário comum × administrador (VF-2-03w)', () => {
  const ADMIN = 'root-uid';
  const asAdmin = () => testEnv.authenticatedContext(ADMIN, { admin: true }).firestore();
  const accountOf = (db, uid, id) => doc(db, 'users', uid, 'accounts', id);
  const DOMAIN = ['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'subscriptions', 'debtors', 'debts', 'debtPayments', 'goals', 'goalTransactions', 'creditCards', 'cardPurchases', 'invoices', 'budgets'];

  it('(a) usuário comum NÃO apaga, lê nem lista dados de outro uid (permission-denied)', async () => {
    const alice = asUser(ALICE);
    await assertFails(deleteDoc(accountOf(alice, BOB, 'acc-bob')));
    await assertFails(getDoc(accountOf(alice, BOB, 'acc-bob')));
    await assertFails(getDocs(collection(alice, 'users', BOB, 'accounts')));
    await assertFails(writeBatch(alice).delete(accountOf(alice, BOB, 'acc-bob')).commit());
    // ...e (VF-ARQ-02) nem o PRÓPRIO: conta é excluída/arquivada pela camada confiável (preserva histórico)
    await assertFails(deleteDoc(accountOf(alice, ALICE, 'acc-main2')));
    // e não executa limpeza global (consulta de grupo) nem se declarar admin no cliente
    await assertFails(getDocs(query(collectionGroup(alice, 'accounts'), limit(10))));
  });

  it('claim admin ausente, falsa ou textual não concede poder (só `admin == true` booleano)', async () => {
    for (const claims of [{}, { admin: false }, { admin: 'true' }, { admin: 1 }, { role: 'admin' }]) {
      const db = testEnv.authenticatedContext('x-uid', claims).firestore();
      await assertFails(deleteDoc(accountOf(db, BOB, 'acc-bob')));
      await assertFails(getDoc(accountOf(db, BOB, 'acc-bob')));
    }
    await assertFails(deleteDoc(accountOf(testEnv.unauthenticatedContext().firestore(), BOB, 'acc-bob')));
  });

  it('(b) administrador apaga os dados de um uid específico (sem a conta dele), em lote e documento a documento', async () => {
    const admin = asAdmin();
    const snap = await assertSucceeds(getDocs(collection(admin, 'users', BOB, 'accounts'))); // leitura necessária para listar o que apagar
    assert.equal(snap.size, 1);
    await assertSucceeds(deleteDoc(accountOf(admin, BOB, 'acc-bob')));
    const afterwards = await getDocs(collection(testEnv.authenticatedContext(BOB).firestore(), 'users', BOB, 'accounts'));
    assert.equal(afterwards.size, 0);
    // lote de exclusão em várias coleções do domínio
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.firestore();
      for (const c of DOMAIN) await setDoc(doc(adminDb, 'users', BOB, c, 'seed'), { x: 1 });
    });
    const batch = writeBatch(admin);
    for (const c of DOMAIN) batch.delete(doc(admin, 'users', BOB, c, 'seed'));
    await assertSucceeds(batch.commit());
  });

  it('administrador executa limpeza global: consulta de grupo lê docs de todos os usuários e apaga', async () => {
    const admin = asAdmin();
    const found = await assertSucceeds(getDocs(query(collectionGroup(admin, 'accounts'), limit(50))));
    assert.ok(found.docs.some((d) => d.ref.path.startsWith(`users/${ALICE}/`)) && found.docs.some((d) => d.ref.path.startsWith(`users/${BOB}/`)));
    const batch = writeBatch(admin);
    found.docs.forEach((d) => batch.delete(d.ref));
    await assertSucceeds(batch.commit());
    assert.equal((await getDocs(query(collectionGroup(admin, 'accounts'), limit(50)))).size, 0);
  });

  it('poderes do administrador são MÍNIMOS: não cria, não edita, não toca perfil/configurações e nunca apaga auditLog', async () => {
    const admin = asAdmin();
    await assertFails(setDoc(accountOf(admin, BOB, 'novo'), { ...account, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(accountOf(admin, BOB, 'acc-bob'), { name: 'x', updatedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(admin, 'users', BOB, 'profile', 'main')));
    await assertFails(deleteDoc(doc(admin, 'users', BOB, 'settings', 'main')));
    await assertFails(getDoc(doc(admin, 'users', ALICE, 'auditLog', 'entry-1')));
    await assertFails(deleteDoc(doc(admin, 'users', ALICE, 'auditLog', 'entry-1'))); // auditoria imutável também para o admin
    await assertFails(getDocs(query(collectionGroup(admin, 'auditLog'), limit(5))));
    // o admin grava auditoria só no PRÓPRIO log (create-only), como qualquer usuário
    await assertSucceeds(addDoc(collection(admin, 'users', ADMIN, 'auditLog'), { action: 'maintenance_clear_all_users', entity: 'maintenance', entityId: 'all', actorUid: ADMIN, createdAt: serverTimestamp() }));
    await assertFails(addDoc(collection(admin, 'users', BOB, 'auditLog'), { action: 'x', entity: 'x', entityId: 'x', actorUid: ADMIN, createdAt: serverTimestamp() }));
  });
});

describe('Promoção de administradores (VF-2-03aa): claims só no servidor; Rules sem caminho de auto-promoção', () => {
  const ADMIN = 'root-uid';
  const asAdmin = () => testEnv.authenticatedContext(ADMIN, { admin: true }).firestore();
  const stamps = () => ({ createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  const grantAudit = (actor, target = 'alvo-uid') => ({
    action: 'maintenance_admin_grant', entity: 'maintenance', entityId: target,
    after: { adminUid: actor, targetUid: target, targetEmail: 'alvo@x.com', admin: true, previousAdmin: false }, actorUid: actor, createdAt: serverTimestamp(),
  });

  it('auditoria da promoção: o ADMIN grava no PRÓPRIO log; não grava no log de outro nem em nome de outro; é imutável', async () => {
    const admin = asAdmin();
    const ref = await assertSucceeds(addDoc(collection(admin, 'users', ADMIN, 'auditLog'), grantAudit(ADMIN)));
    await assertFails(addDoc(collection(admin, 'users', BOB, 'auditLog'), grantAudit(ADMIN))); // log alheio
    await assertFails(addDoc(collection(admin, 'users', ADMIN, 'auditLog'), grantAudit(BOB))); // actorUid forjado
    await assertFails(updateDoc(ref, { action: 'x' }));
    await assertFails(deleteDoc(ref));
  });

  it('usuário comum NÃO tem caminho no Firestore para virar admin: nem coleção de admins, nem campo `admin` no perfil/configurações', async () => {
    const alice = asUser(ALICE);
    await assertFails(setDoc(doc(alice, 'admins', ALICE), { admin: true }));
    await assertFails(setDoc(doc(alice, 'users', ALICE, 'admins', 'x'), { admin: true, ...stamps() }));
    await assertFails(setDoc(doc(alice, 'users', ALICE, 'claims', 'x'), { admin: true }));
    const profile = { name: 'Ana', email: 'ana@exemplo.com', currency: 'BRL', locale: 'pt-BR', ...stamps() };
    await assertSucceeds(setDoc(doc(alice, 'users', ALICE, 'profile', 'main'), profile)); // perfil válido: ok
    await assertFails(setDoc(doc(alice, 'users', ALICE, 'profile', 'main'), { ...profile, admin: true })); // campo extra: negado
    await assertFails(setDoc(doc(alice, 'users', ALICE, 'settings', 'main'), { theme: 'dark', admin: true, ...stamps() }));
  });

  it('claim admin NÃO é concedida por documento: admin do token não cria/edita coleções de promoção e usuário comum não finge ser admin', async () => {
    const admin = asAdmin();
    await assertFails(setDoc(doc(admin, 'admins', 'alvo-uid'), { admin: true })); // nem o admin promove via Firestore
    const fake = testEnv.authenticatedContext('falso-uid', { admin: 'true', role: 'admin' }).firestore();
    await assertFails(getDocs(collection(fake, 'users', BOB, 'accounts')));
    await assertFails(deleteDoc(doc(fake, 'users', BOB, 'accounts', 'acc-bob')));
  });
});

describe('auditLog imutável', () => {
  it('permite leitura do próprio log', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('exclusão atômica (VF-2-03o): delete do lançamento + entrada de auditoria com `before` no MESMO lote; auditoria continua imutável', async () => {
    const db = asUser(ALICE);
    const ref = await addDoc(collection(db, 'users', ALICE, 'expenses'), expensePayload());
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', ALICE, 'expenses', ref.id));
    batch.set(doc(collection(db, 'users', ALICE, 'auditLog')), {
      action: 'delete', entity: 'expenses', entityId: ref.id, before: { id: ref.id, amountCents: 5000, status: 'paid' },
      actorUid: ALICE, createdAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
    assert.equal((await getDoc(doc(db, 'users', ALICE, 'expenses', ref.id))).exists(), false);
  });

  it('permite criar entrada com actorUid correto', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        entity: 'expenses',
        entityId: 'exp-1',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('permite entrada com before e after (payload do writeAudit)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'update',
        entity: 'accounts',
        entityId: 'acc-main',
        before: { name: 'Antes', initialBalanceCents: 100 },
        after: { name: 'Depois', initialBalanceCents: 200 },
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega before/after que não sejam mapa', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'update',
        entity: 'accounts',
        entityId: 'acc-main',
        after: 'texto',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega campos fora do schema (formato antigo collection/docId)', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        collection: 'accounts',
        docId: 'acc-main',
        actorUid: ALICE,
        createdAt: serverTimestamp(),
      })
    );
  });

  it('nega update', async () => {
    const db = asUser(ALICE);
    await assertFails(
      updateDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1'), { action: 'adulterado' })
    );
  });

  it('nega delete', async () => {
    const db = asUser(ALICE);
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'auditLog', 'entry-1')));
  });

  it('nega entrada com actorUid de outro usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(
      addDoc(collection(db, 'users', ALICE, 'auditLog'), {
        action: 'create',
        entity: 'expenses',
        entityId: 'exp-2',
        actorUid: BOB,
        createdAt: serverTimestamp(),
      })
    );
  });
});

describe('Negação padrão', () => {
  it('nega coleção não prevista', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'users', ALICE, 'colecaoInventada', 'x'), { a: 1 }));
  });

  it('nega coleção fora da árvore do usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'publico', 'x'), { a: 1 }));
  });
});

describe('Perfil e configurações (VF-2-02)', () => {
  const profileDoc = (db) => doc(db, 'users', ALICE, 'profile', 'main');
  const settingsDoc = (db) => doc(db, 'users', ALICE, 'settings', 'main');
  const profile = () => ({
    name: 'Ana',
    email: 'ana@exemplo.com',
    currency: 'BRL',
    locale: 'pt-BR',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const settings = (overrides = {}) => ({
    theme: 'dark',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar perfil válido e atualizar o nome via merge (como o service)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(profileDoc(db), profile(), { merge: true }));
    await assertSucceeds(
      setDoc(profileDoc(db), { name: 'Ana Maria', updatedAt: serverTimestamp() }, { merge: true })
    );
  });

  it('nega perfil com moeda/idioma diferentes, nome vazio ou campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(profileDoc(db), { ...profile(), currency: 'USD' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), locale: 'en-US' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), name: '' }));
    await assertFails(setDoc(profileDoc(db), { ...profile(), admin: true }));
  });

  it('nega alterar createdAt do perfil e excluir perfil', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(profileDoc(db), profile()));
    await assertFails(
      setDoc(profileDoc(db), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() }, { merge: true })
    );
    await assertFails(deleteDoc(profileDoc(db)));
  });

  it('permite criar configurações e trocar tema via merge sem reenviar createdAt', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(settingsDoc(db), settings(), { merge: true }));
    await assertSucceeds(
      setDoc(settingsDoc(db), { theme: 'light', updatedAt: serverTimestamp() }, { merge: true })
    );
  });

  it('nega tema inválido, firstWeekday fora de 0–6, hideValues não booleano e campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(settingsDoc(db), settings({ theme: 'neon' })));
    await assertFails(setDoc(settingsDoc(db), settings({ firstWeekday: 7 })));
    await assertFails(setDoc(settingsDoc(db), settings({ hideValues: 'sim' })));
    await assertFails(setDoc(settingsDoc(db), settings({ extra: 1 })));
  });

  it('nega alterar createdAt das configurações e excluí-las', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(settingsDoc(db), settings()));
    await assertFails(
      setDoc(settingsDoc(db), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() }, { merge: true })
    );
    await assertFails(deleteDoc(settingsDoc(db)));
  });

  it('isola perfil/configurações entre usuários', async () => {
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'settings', 'main'), settings()));
    await assertFails(getDoc(doc(asUser(BOB), 'users', ALICE, 'profile', 'main')));
  });
});

describe('Assinaturas (VF-2-03a)', () => {
  const subDoc = (db, id = 'sub1') => doc(db, 'users', ALICE, 'subscriptions', id);
  // Payload equivalente ao gravado por js/services/subscriptions.js (datas = meio-dia UTC).
  const sub = (overrides = {}) => ({
    name: 'Netflix',
    amountCents: 3990,
    periodicity: 'monthly',
    nextChargeDate: new Date('2026-12-05T12:00:00.000Z'),
    accountId: 'acc-main',
    categoryId: 'cat-casa',
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar, pausar (patch de status) e excluir', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(subDoc(db), sub({ notes: 'plano padrão' })));
    await assertSucceeds(updateDoc(subDoc(db), { status: 'paused', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(subDoc(db)));
  });

  it('VF-COR-07: conta OPCIONAL e devedor opcional; referências inexistentes/inválidas/de outro usuário seguem negadas; vínculos podem ser removidos', async () => {
    const db = asUser(ALICE);
    const { accountId: _omit, ...semConta } = sub();
    await assertSucceeds(setDoc(subDoc(db, 'sem-conta'), semConta)); // antes: conta obrigatória
    await assertFails(setDoc(subDoc(db, 'x1'), sub({ accountId: 'zzz' })));
    await assertFails(setDoc(subDoc(db, 'x2'), sub({ accountId: 5 })));
    await assertFails(setDoc(subDoc(db, 'x3'), sub({ accountId: '' })));
    await assertFails(setDoc(subDoc(db, 'x4'), sub({ debtorId: 'zzz' })));
    await assertFails(setDoc(subDoc(db, 'x5'), { ...semConta, debtorId: 7 }));
    await seedDoc(`users/${ALICE}/debtors/dv`, { name: 'Roberta', loanDate: new Date('2026-11-10T12:00:00.000Z'), lentCents: 0, receivedCents: 0, status: 'open' });
    await seedDoc(`users/${BOB}/debtors/dv-bob`, { name: 'Do Bob', loanDate: new Date('2026-11-10T12:00:00.000Z'), lentCents: 0, receivedCents: 0, status: 'open' });
    await assertSucceeds(setDoc(subDoc(db, 'com-devedor'), sub({ debtorId: 'dv' })));
    await assertSucceeds(setDoc(subDoc(db, 'so-devedor'), { ...semConta, debtorId: 'dv' })); // sem conta e sem cartão
    await assertFails(setDoc(subDoc(db, 'x6'), sub({ debtorId: 'dv-bob' }))); // devedor de OUTRO usuário
    await assertFails(setDoc(subDoc(db, 'x7'), sub({ extra: 1 }))); // schema continua fechado
    await assertSucceeds(updateDoc(subDoc(db, 'com-devedor'), { debtorId: deleteField(), accountId: deleteField(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(subDoc(db, 'com-devedor'), { debtorId: 'dv-bob', updatedAt: serverTimestamp() }));
  });

  it('VF-COR-07: regravar o MESMO id de cobrança (dívida ou compra da assinatura) é negado — lote repetido/concorrente falha inteiro e não duplica nem soma no devedor', async () => {
    const db = asUser(ALICE);
    const stamps = () => ({ createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await seedDoc(`users/${ALICE}/debtors/dv`, { name: 'Roberta', loanDate: new Date('2026-11-10T12:00:00.000Z'), lentCents: 0, receivedCents: 0, status: 'open' });
    const debt = (extra = {}) => ({ debtorId: 'dv', description: 'Netflix', principalCents: 5590, dueDate: new Date('2026-12-05T12:00:00.000Z'), installmentNumber: 1, installmentsTotal: 1, debtGroupId: 'g1', status: 'pending', ...stamps(), ...extra });
    const debtRef = doc(db, 'users', ALICE, 'debts', 'sub_sub1_2026-12-05');
    await assertSucceeds(setDoc(debtRef, debt())); // 1ª cobrança daquela data
    await assertFails(setDoc(debtRef, debt({ debtGroupId: 'g2' }))); // 2ª: regravar o id = update, negado
    const batch = writeBatch(db); // lote completo da 2ª tentativa: dívida repetida + soma no devedor
    batch.set(debtRef, debt({ debtGroupId: 'g3' }));
    batch.update(doc(db, 'users', ALICE, 'debtors', 'dv'), { lentCents: 11180, updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(db, 'users', ALICE, 'debtors', 'dv'))).data().lentCents, 0); // devedor intacto
    // compra no cartão da assinatura: mesmo princípio
    await seedDoc(`users/${ALICE}/creditCards/cx`, { name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active' });
    await seedDoc(`users/${ALICE}/invoices/cx_2026-12`, { cardId: 'cx', referenceMonth: '2026-12', closingDate: new Date('2026-12-10T12:00:00.000Z'), dueDate: new Date('2026-12-17T12:00:00.000Z'), status: 'open' });
    const purchase = (extra = {}) => ({ cardId: 'cx', description: 'Netflix', amountCents: 5590, purchaseDate: new Date('2026-12-05T12:00:00.000Z'), installmentsTotal: 1, installmentNumber: 1, categoryId: 'cat-casa', invoiceId: 'cx_2026-12', notes: 'Assinatura', ...stamps(), ...extra });
    const buyRef = doc(db, 'users', ALICE, 'cardPurchases', 'sub_sub1_2026-12-05');
    await assertSucceeds(setDoc(buyRef, purchase()));
    await assertFails(setDoc(buyRef, purchase({ description: 'Netflix de novo' })));
  });

  it('assinatura no cartão (VF-2-03r): cardId opcional existente; nega cartão inexistente; remove o vínculo; cobrança = parcela + avanço da data no MESMO lote', async () => {
    const db = asUser(ALICE);
    const stamps = () => ({ createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'creditCards', 'cx'), { name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active', ...stamps() }));
    await assertFails(setDoc(subDoc(db), sub({ cardId: 'zzz' })));
    await assertFails(setDoc(subDoc(db), sub({ cardId: 5 })));
    await assertSucceeds(setDoc(subDoc(db), sub({ cardId: 'cx' })));
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'invoices', 'cx_2026-12'), { cardId: 'cx', referenceMonth: '2026-12', closingDate: new Date('2026-12-10T12:00:00.000Z'), dueDate: new Date('2026-12-17T12:00:00.000Z'), status: 'open', ...stamps() }));
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', ALICE, 'cardPurchases', 'p1'), {
      cardId: 'cx', description: 'Netflix', amountCents: 3990, purchaseDate: new Date('2026-12-05T12:00:00.000Z'), installmentsTotal: 1, installmentNumber: 1,
      categoryId: 'cat-casa', invoiceId: 'cx_2026-12', notes: 'Assinatura', ...stamps(),
    });
    batch.update(subDoc(db), { nextChargeDate: new Date('2027-01-05T12:00:00.000Z'), updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    await assertSucceeds(updateDoc(subDoc(db), { cardId: deleteField(), updatedAt: serverTimestamp() })); // volta à cobrança direta na conta
  });

  it('permite avançar nextChargeDate (patch de registerSubscriptionCharge) e nega data string', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(subDoc(db), sub()));
    await assertSucceeds(updateDoc(subDoc(db), { nextChargeDate: new Date('2027-01-05T12:00:00.000Z'), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(subDoc(db), { nextChargeDate: '2027-02-05', updatedAt: serverTimestamp() }));
  });

  it('nega valor não positivo/fracionário, periodicidade e status inválidos, campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(subDoc(db), sub({ amountCents: 0 })));
    await assertFails(setDoc(subDoc(db), sub({ amountCents: 39.9 })));
    await assertFails(setDoc(subDoc(db), sub({ periodicity: 'daily' })));
    await assertFails(setDoc(subDoc(db), sub({ status: 'none' })));
    await assertFails(setDoc(subDoc(db), sub({ extra: 1 })));
  });

  it('nega data como string, conta/categoria inexistentes e conta de outro usuário', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(subDoc(db), sub({ nextChargeDate: '2026-12-05' })));
    await assertFails(setDoc(subDoc(db), sub({ accountId: 'nao-existe' })));
    await assertFails(setDoc(subDoc(db), sub({ categoryId: 'nao-existe' })));
    await assertFails(setDoc(subDoc(db), sub({ accountId: 'acc-bob' })));
  });

  it('nega alterar createdAt e acesso de outro usuário/anônimo', async () => {
    await assertSucceeds(setDoc(subDoc(asUser(ALICE)), sub()));
    await assertFails(
      updateDoc(subDoc(asUser(ALICE)), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() })
    );
    await assertFails(getDoc(subDoc(asUser(BOB))));
    await assertFails(setDoc(subDoc(asUser(BOB), 'sub2'), sub()));
    await assertFails(getDoc(subDoc(asAnonymous())));
  });
});

describe('Devedores (VF-2-03b)', () => {
  const debtorDoc = (db, id = 'dev1') => doc(db, 'users', ALICE, 'debtors', id);
  // Payload equivalente ao gravado por js/services/debtors.js (loanDate = meio-dia UTC).
  const debtor = (overrides = {}) => ({
    name: 'João',
    loanDate: new Date('2026-11-10T12:00:00.000Z'),
    lentCents: 100000,
    receivedCents: 0,
    status: 'open',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  });

  it('permite criar, editar valor emprestado, cancelar (patch) e excluir', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(debtorDoc(db), debtor({ notes: 'amigo' })));
    await assertSucceeds(updateDoc(debtorDoc(db), { lentCents: 50000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(debtorDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(debtorDoc(db))); // VF-ARQ-02: exclusão/arquivamento só pela camada confiável
  });

  it('permite emprestado 0 (VF-2-03l); nega negativo/fracionário, recebido negativo ou maior que emprestado', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(debtorDoc(db, 'zero'), debtor({ lentCents: 0 })));
    await assertSucceeds(updateDoc(debtorDoc(db, 'zero'), { lentCents: 30000, updatedAt: serverTimestamp() })); // compra de cartão soma aqui
    await assertFails(setDoc(debtorDoc(db), debtor({ lentCents: -1 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ lentCents: 0, receivedCents: 1 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ lentCents: 10.5 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ receivedCents: -1 })));
    await assertFails(setDoc(debtorDoc(db), debtor({ receivedCents: 100001 })));
    // VF-ARQ-02: o recebido nasce 0 e só a camada confiável o altera; `paid` também é dela
    await assertFails(setDoc(debtorDoc(db), debtor({ receivedCents: 100000, status: 'paid' })));
    await assertFails(setDoc(debtorDoc(db), debtor({ status: 'paid' })));
  });

  it('nega reduzir emprestado abaixo do recebido (patch)', async () => {
    const db = asUser(ALICE);
    await seedDoc(`users/${ALICE}/debtors/dev1`, { name: 'João', loanDate: new Date('2026-11-10T12:00:00.000Z'), lentCents: 100000, receivedCents: 30000, status: 'open' });
    await assertFails(updateDoc(debtorDoc(db), { lentCents: 20000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(debtorDoc(db), { lentCents: 30000, updatedAt: serverTimestamp() }));
  });

  it('nega status inválido, data como string e campo extra', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(debtorDoc(db), debtor({ status: 'late' })));
    await assertFails(setDoc(debtorDoc(db), debtor({ loanDate: '2026-11-10' })));
    await assertFails(setDoc(debtorDoc(db), debtor({ extra: 1 })));
  });

  it('nega alterar createdAt e acesso de outro usuário/anônimo', async () => {
    await assertSucceeds(setDoc(debtorDoc(asUser(ALICE)), debtor()));
    await assertFails(
      updateDoc(debtorDoc(asUser(ALICE)), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() })
    );
    await assertFails(getDoc(debtorDoc(asUser(BOB))));
    await assertFails(setDoc(debtorDoc(asUser(BOB), 'dev2'), debtor()));
    await assertFails(getDoc(debtorDoc(asAnonymous())));
  });
});

describe('Parcelas e recebimentos de devedores (VF-2-03b2)', () => {
  const debtorDoc = (db) => doc(db, 'users', ALICE, 'debtors', 'dev1');
  const debtDoc = (db, id = 'd1') => doc(db, 'users', ALICE, 'debts', id);
  const payDoc = (db, id = 'p1') => doc(db, 'users', ALICE, 'debtPayments', id);
  const accountDoc = (db) => doc(db, 'users', ALICE, 'accounts', 'acc1');
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  // Payloads equivalentes aos gravados por js/services/debtPayments.js (datas = meio-dia UTC).
  const debt = (o = {}) => ({
    debtorId: 'dev1', description: 'Parcela 1', principalCents: 50000, dueDate: noon('2026-12-10'),
    installmentNumber: 1, status: 'pending', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  const payment = (o = {}) => ({
    debtId: 'd1', debtorId: 'dev1', amountCents: 20000, date: noon('2026-11-18'), accountId: 'acc1',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });

  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(accountDoc(db), account));
    await assertSucceeds(setDoc(debtorDoc(db), {
      name: 'João', loanDate: noon('2026-11-10'), lentCents: 50000, receivedCents: 0, status: 'open',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(debtDoc(db), debt()));
    return db;
  }

  it('dívida à vista/parcelada (VF-2-03m): parcelas com installmentsTotal/debtGroupId + lentCents do devedor no MESMO lote', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(debtDoc(db, 'g1'), debt({ installmentNumber: 1, installmentsTotal: 3, debtGroupId: 'grp1' }));
    batch.set(debtDoc(db, 'g2'), debt({ installmentNumber: 2, installmentsTotal: 3, debtGroupId: 'grp1', dueDate: noon('2027-01-10') }));
    batch.set(debtDoc(db, 'g3'), debt({ installmentNumber: 3, installmentsTotal: 3, debtGroupId: 'grp1', dueDate: noon('2027-02-10') }));
    batch.set(debtDoc(db, 'cash'), debt({ installmentNumber: 1, installmentsTotal: 1, debtGroupId: 'grp2' }));
    batch.update(debtorDoc(db), { lentCents: 200000, updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
  });

  it('quitar dívida (VF-2-03n / VF-ARQ-02): o CLIENTE não grava recebimentos, não paga parcelas nem soma no devedor (op debt.settleBatch)', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(debtDoc(db, 'q2'), debt({ installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g' })));
    const batch = writeBatch(db);
    batch.set(payDoc(db, 'pa'), payment({ debtId: 'd1', amountCents: 50000 }));
    batch.set(payDoc(db, 'pb'), payment({ debtId: 'q2', amountCents: 50000 }));
    batch.update(debtDoc(db, 'd1'), { status: 'paid', updatedAt: serverTimestamp() });
    batch.update(debtDoc(db, 'q2'), { status: 'paid', updatedAt: serverTimestamp() });
    batch.update(debtorDoc(db), { receivedCents: 50000, status: 'paid', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    // as partes isoladas também: parcela não vira paid nem é editada pelo cliente
    await assertFails(updateDoc(debtDoc(db, 'd1'), { status: 'paid', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(debtorDoc(db), { receivedCents: 50000, updatedAt: serverTimestamp() }));
  });

  it('dívida: nega installmentsTotal inválido (< parcela, 0, > 360, não inteiro), debtGroupId longo/não texto e campo extra', async () => {
    const db = await seed();
    for (const bad of [{ installmentNumber: 3, installmentsTotal: 2 }, { installmentsTotal: 0 }, { installmentsTotal: 361 }, { installmentsTotal: 2.5 },
      { installmentsTotal: '3' }, { debtGroupId: 'x'.repeat(129) }, { debtGroupId: 7 }, { extra: 1 }]) {
      await assertFails(setDoc(debtDoc(db, 'bad'), debt(bad)));
    }
  });

  it('recebimento (pagamento + parcela paga + devedor quitado) NÃO é aceito do cliente em nenhum formato', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(payDoc(db), payment({ amountCents: 50000, notes: 'pix' }));
    batch.update(debtDoc(db), { status: 'paid', updatedAt: serverTimestamp() });
    batch.update(debtorDoc(db), { receivedCents: 50000, status: 'paid', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    await assertFails(setDoc(payDoc(db, 'solto'), payment()));
    const snap = await getDoc(payDoc(db));
    if (snap.exists()) throw new Error('nenhum recebimento deveria ter sido gravado');
  });

  it('lote inteiro falha se o recebimento excede o emprestado (nada gravado)', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(payDoc(db), payment());
    batch.update(debtorDoc(db), { receivedCents: 50001, updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    const snap = await getDoc(payDoc(db));
    if (snap.exists()) throw new Error('o recebimento não deveria ter sido gravado (lote não atômico)');
  });

  it('parcelas: valida schema (principal, número 1..360, status, data, devedor existente)', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(debtDoc(db, 'd2'), debt({ installmentNumber: 360 })));
    await assertFails(setDoc(debtDoc(db, 'd2b'), debt({ status: 'late' }))); // parcela nasce pendente; atraso/pagamento são derivados/do servidor
    await assertFails(setDoc(debtDoc(db, 'd2c'), debt({ status: 'paid' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ principalCents: 0 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ installmentNumber: 361 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ installmentNumber: 1.5 })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ status: 'open' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ dueDate: '2026-12-10' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ debtorId: 'inexistente' })));
    await assertFails(setDoc(debtDoc(db, 'd3'), debt({ extra: 1 })));
    await assertFails(updateDoc(debtDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() })); // cancelar é op debt.cancel
  });

  it('recebimentos: o cliente NÃO cria/edita/exclui (só lê os próprios); isolamento por usuário', async () => {
    const db = await seed();
    await assertFails(receive(db, payDoc(db), payment(), debtorDoc(db)));
    await seedDoc(`users/${ALICE}/debtPayments/p1`, { debtId: 'd1', debtorId: 'dev1', amountCents: 10000, date: new Date('2026-11-18T12:00:00.000Z'), accountId: 'acc1' });
    await assertSucceeds(getDoc(payDoc(db, 'p1')));
    await assertFails(updateDoc(payDoc(db, 'p1'), { amountCents: 1, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(payDoc(db, 'p1')));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ amountCents: 0 })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ amountCents: 10.5 })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ date: '2026-11-18' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ debtId: 'zzz' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ accountId: 'zzz' })));
    await assertFails(setDoc(payDoc(db, 'p2'), payment({ extra: 1 })));
    await assertFails(getDoc(payDoc(asUser(BOB))));
    await assertFails(setDoc(payDoc(asUser(BOB), 'p3'), payment()));
    await assertFails(getDoc(payDoc(asAnonymous())));
  });
});

describe('Metas e movimentações (VF-2-03c)', () => {
  const goalDoc = (db, id = 'g1') => doc(db, 'users', ALICE, 'goals', id);
  const txDoc = (db, id = 't1') => doc(db, 'users', ALICE, 'goalTransactions', id);
  const accountDoc = (db) => doc(db, 'users', ALICE, 'accounts', 'acc1');
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  // Payloads equivalentes aos gravados por js/services/goals.js (datas = meio-dia UTC).
  const goal = (o = {}) => ({
    name: 'Viagem', targetCents: 100000, deadline: noon('2027-01-10'), accountId: 'acc1', status: 'active',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  const tx = (o = {}) => ({
    goalId: 'g1', type: 'deposit', amountCents: 30000, date: noon('2026-11-18'), accountId: 'acc1',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });
  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(accountDoc(db), account));
    await assertSucceeds(setDoc(goalDoc(db), goal()));
    return db;
  }

  it('metas: cria (com e sem opcionais), edita, cancela e exclui', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(goalDoc(db, 'g2'), { name: 'Reserva', targetCents: 5000, status: 'active', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(goalDoc(db), { targetCents: 200000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(goalDoc(db), { status: 'cancelled', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(goalDoc(db, 'g2')));
  });

  it('metas (VF-2-03q): fluxo COMPLETO do createGoal — meta com conta/prazo/descrição + auditLog (after com prazo em string) — é aceito', async () => {
    const db = await seed();
    const data = { name: 'Caixinha', targetCents: 100000, deadline: '2027-01-10', accountId: 'acc1', description: 'Nubank' };
    await assertSucceeds(setDoc(goalDoc(db, 'cx'), goal({ name: 'Caixinha', description: 'Nubank', deadline: noon('2027-01-10') })));
    await assertSucceeds(addDoc(collection(db, 'users', ALICE, 'auditLog'), {
      action: 'create', entity: 'goals', entityId: 'cx', after: { ...data, status: 'active' }, actorUid: ALICE, createdAt: serverTimestamp(),
    }));
    // mesmo conjunto, em um único lote (como o commitAtomic faria)
    const batch = writeBatch(db);
    batch.set(goalDoc(db, 'cx2'), goal({ name: 'Caixinha 2' }));
    batch.set(doc(collection(db, 'users', ALICE, 'auditLog')), { action: 'create', entity: 'goals', entityId: 'cx2', after: { ...data, status: 'active' }, actorUid: ALICE, createdAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
  });

  it('metas: nega alvo <= 0, status inválido, prazo string, conta inexistente e campo extra', async () => {
    const db = await seed();
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ targetCents: 0 })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ status: 'paid' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ deadline: '2027-01-10' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ accountId: 'zzz' })));
    await assertFails(setDoc(goalDoc(db, 'g3'), goal({ extra: 1 })));
  });

  it('aporte/resgate (VF-ARQ-02): o CLIENTE não grava movimentações (op goal.deposit/withdraw), nem em lote com a meta', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(txDoc(db), tx({ amountCents: 100000, notes: 'bônus' }));
    batch.update(goalDoc(db), { status: 'completed', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    const resgate = writeBatch(db);
    resgate.set(txDoc(db, 't2'), tx({ type: 'withdraw', amountCents: 1000 }));
    await assertFails(resgate.commit());
    assert.equal((await getDoc(txDoc(db))).exists(), false);
  });

  it('lote inteiro falha se uma operação é inválida (nada gravado)', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(txDoc(db), tx());
    batch.update(goalDoc(db), { status: 'paid', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    if ((await getDoc(txDoc(db))).exists()) throw new Error('movimentação gravada apesar do lote inválido');
  });

  it('movimentações: só leitura ao dono; sem criar/editar/excluir; isolamento por usuário', async () => {
    const db = await seed();
    await assertFails(setDoc(txDoc(db), tx()));
    await seedDoc(`users/${ALICE}/goalTransactions/t1`, { goalId: 'g1', type: 'deposit', amountCents: 30000, date: noon('2026-11-18'), accountId: 'acc1' });
    await assertSucceeds(getDoc(txDoc(db)));
    await assertFails(updateDoc(txDoc(db), { amountCents: 1, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(txDoc(db)));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ type: 'transfer' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ amountCents: 0 })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ amountCents: 10.5 })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ date: '2026-11-18' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ goalId: 'zzz' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ accountId: 'zzz' })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ notes: 'x'.repeat(301) })));
    await assertFails(setDoc(txDoc(db, 't2'), tx({ extra: 1 })));
    await assertFails(getDoc(txDoc(asUser(BOB))));
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'goalTransactions', 't9'), tx()));
    await assertFails(getDoc(txDoc(asAnonymous())));
  });
});

describe('Cartões, compras e faturas (VF-2-03d)', () => {
  const cardDoc = (db, id = 'c1') => doc(db, 'users', ALICE, 'creditCards', id);
  const invDoc = (db, id = 'c1_2026-11') => doc(db, 'users', ALICE, 'invoices', id);
  const buyDoc = (db, id = 'p1') => doc(db, 'users', ALICE, 'cardPurchases', id);
  const accountDoc = (db) => doc(db, 'users', ALICE, 'accounts', 'acc1');
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  const stamps = () => ({ createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  // Payloads equivalentes aos gravados por js/services/creditCards.js (datas = meio-dia UTC).
  const card = (o = {}) => ({ name: 'Nubank', brand: 'Mastercard', limitCents: 500000, closingDay: 10, dueDay: 17, accountId: 'acc1', status: 'active', ...stamps(), ...o });
  const invoice = (o = {}) => ({ cardId: 'c1', referenceMonth: '2026-11', closingDate: noon('2026-11-10'), dueDate: noon('2026-11-17'), status: 'open', ...stamps(), ...o });
  const purchase = (o = {}) => ({ cardId: 'c1', description: 'Notebook', amountCents: 33334, purchaseDate: noon('2026-11-05'), installmentsTotal: 3, installmentNumber: 1, invoiceId: 'c1_2026-11', ...stamps(), ...o });
  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(accountDoc(db), account));
    await assertSucceeds(setDoc(cardDoc(db), card()));
    return db;
  }

  it('cartão: cria (com e sem opcionais), bloqueia (patch) e exclui', async () => {
    const db = await seed();
    const { accountId, ...semConta } = card();
    await assertSucceeds(setDoc(cardDoc(db, 'c2'), { ...semConta, color: '#fff' }));
    await assertSucceeds(updateDoc(cardDoc(db), { status: 'blocked', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(cardDoc(db), { limitCents: 800000, updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(cardDoc(db, 'c2')));
  });

  it('cartão: nega limite <= 0, dias fora de 1..31/fracionários, status inválido, conta inexistente, extra', async () => {
    const db = await seed();
    for (const bad of [{ limitCents: 0 }, { closingDay: 0 }, { closingDay: 32 }, { dueDay: 10.5 }, { status: 'paid' }, { accountId: 'zzz' }, { extra: 1 }]) {
      await assertFails(setDoc(cardDoc(db, 'c9'), card(bad)));
    }
  });

  it('compra parcelada em 2 lotes: 1) faturas novas, 2) parcelas referenciando-as', async () => {
    const db = await seed();
    const faturas = writeBatch(db);
    faturas.set(invDoc(db), invoice());
    faturas.set(invDoc(db, 'c1_2026-12'), invoice({ referenceMonth: '2026-12', closingDate: noon('2026-12-10'), dueDate: noon('2026-12-17') }));
    await assertSucceeds(faturas.commit());
    const parcelas = writeBatch(db);
    parcelas.set(buyDoc(db, 'p1'), purchase());
    parcelas.set(buyDoc(db, 'p2'), purchase({ installmentNumber: 2, amountCents: 33333, invoiceId: 'c1_2026-12', notes: 'x' }));
    await assertSucceeds(parcelas.commit());
  });

  it('contrato: parcela NÃO pode referenciar fatura criada no mesmo lote (exists() vê o estado anterior)', async () => {
    const db = await seed();
    const batch = writeBatch(db);
    batch.set(invDoc(db), invoice());
    batch.set(buyDoc(db), purchase());
    await assertFails(batch.commit());
  });

  it('excluir cartão com faturas vazias/canceladas (VF-2-03t): delete das faturas + cartão + auditorias no MESMO lote; excluir fatura avulsa', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice({ status: 'cancelled' })));
    await assertSucceeds(setDoc(invDoc(db, 'c1_2026-12'), invoice({ referenceMonth: '2026-12', closingDate: noon('2026-12-10'), dueDate: noon('2026-12-17') })));
    await assertSucceeds(deleteDoc(invDoc(db, 'c1_2026-12'))); // fatura vazia excluída isoladamente
    const audit = (entity, id) => ({ action: 'delete', entity, entityId: id, before: { id }, actorUid: ALICE, createdAt: serverTimestamp() });
    const batch = writeBatch(db);
    batch.delete(invDoc(db));
    batch.set(doc(collection(db, 'users', ALICE, 'auditLog')), audit('invoices', 'c1_2026-11'));
    batch.delete(cardDoc(db));
    batch.set(doc(collection(db, 'users', ALICE, 'auditLog')), audit('creditCards', 'c1'));
    await assertSucceeds(batch.commit());
  });

  it('pagar fatura com conta (VF-2-03p): patch status/totalCents/paidCents/accountId/paidAt; nega conta inexistente, paidAt string e extra; cancelar fatura vazia', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    await assertSucceeds(setDoc(invDoc(db, 'c1_2026-12'), invoice({ referenceMonth: '2026-12', closingDate: noon('2026-12-10'), dueDate: noon('2026-12-17') })));
    await assertFails(updateDoc(invDoc(db), { status: 'paid', paidCents: 3000, accountId: 'zzz', paidAt: noon('2026-11-20'), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(invDoc(db), { status: 'paid', paidCents: 3000, accountId: 'acc1', paidAt: '2026-11-20', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(invDoc(db), { status: 'paid', paidCents: 3000, accountId: 'acc1', extra: 1, updatedAt: serverTimestamp() }));
    // VF-ARQ-02: o pagamento da fatura (status paid + conta + valor) só é gravado pela camada confiável (op invoice.pay)
    await assertFails(updateDoc(invDoc(db), { status: 'paid', totalCents: 3000, paidCents: 3000, accountId: 'acc1', paidAt: noon('2026-11-20'), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(invDoc(db), { paidCents: 3000, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(invDoc(db, 'c1_2026-12'), { status: 'cancelled', updatedAt: serverTimestamp() }));
  });

  it('compra para devedor (VF-2-03i): parcelas com debtorId + lentCents do devedor no MESMO lote; nega devedor inexistente', async () => {
    const db = await seed();
    const dev = doc(db, 'users', ALICE, 'debtors', 'dev1');
    await seedDoc(`users/${ALICE}/debtors/dev1`, { name: 'João', loanDate: noon('2026-11-10'), lentCents: 100000, receivedCents: 20000, status: 'open' });
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    const batch = writeBatch(db);
    batch.set(buyDoc(db, 'p1'), purchase({ debtorId: 'dev1' }));
    batch.set(buyDoc(db, 'p2'), purchase({ debtorId: 'dev1', installmentNumber: 2 }));
    batch.update(dev, { lentCents: 130000, updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    await assertFails(setDoc(buyDoc(db, 'p3'), purchase({ debtorId: 'zzz' })));
    await assertFails(setDoc(buyDoc(db, 'p4'), purchase({ debtorId: 5 })));
  });

  it('lote de parcelas falha inteiro se uma parcela é inválida (nada gravado)', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    const batch = writeBatch(db);
    batch.set(buyDoc(db, 'p1'), purchase());
    batch.set(buyDoc(db, 'p2'), purchase({ installmentNumber: 4 })); // > installmentsTotal
    await assertFails(batch.commit());
    if ((await getDoc(buyDoc(db, 'p1'))).exists()) throw new Error('parcela gravada apesar do lote inválido');
  });

  it('compras: valida parcelas, valor, data, referências e campo extra', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    await assertSucceeds(setDoc(buyDoc(db), purchase()));
    for (const bad of [{ amountCents: 0 }, { amountCents: 10.5 }, { installmentsTotal: 49 }, { installmentsTotal: 0 }, { installmentNumber: 0 },
      { installmentNumber: 4 }, { purchaseDate: '2026-11-05' }, { cardId: 'zzz' }, { invoiceId: 'zzz' }, { categoryId: 'zzz' }, { notes: 'x'.repeat(301) }, { extra: 1 }]) {
      await assertFails(setDoc(buyDoc(db, 'p9'), purchase(bad)));
    }
  });

  it('faturas: cria sem total, fecha (patch com total) e paga; valida mês, status, datas e valores', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    await assertSucceeds(updateDoc(invDoc(db), { status: 'closed', totalCents: 33334, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(invDoc(db), { status: 'paid', paidCents: 33334, updatedAt: serverTimestamp() })); // pagar = servidor
    for (const bad of [{ referenceMonth: '2026-13' }, { referenceMonth: '2026-1' }, { status: 'late' }, { dueDate: '2026-11-17' }, { closingDate: '2026-11-10' },
      { totalCents: -1 }, { paidCents: 1.5 }, { cardId: 'zzz' }, { extra: 1 }]) {
      await assertFails(setDoc(invDoc(db, 'c1_9'), invoice(bad)));
    }
  });

  it('isolamento: outro usuário e anônimo não leem nem escrevem', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(invDoc(db), invoice()));
    await assertFails(getDoc(invDoc(asUser(BOB))));
    await assertFails(getDoc(cardDoc(asAnonymous())));
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'cardPurchases', 'px'), purchase()));
  });
});

describe('Orçamentos (VF-2-03e)', () => {
  const budgetDoc = (db, id = 'b1') => doc(db, 'users', ALICE, 'budgets', id);
  const catDoc = (db) => doc(db, 'users', ALICE, 'categories', 'cat1');
  // Payload equivalente ao gravado por js/services/budgets.js.
  const budget = (o = {}) => ({ categoryId: 'cat1', month: '2026-11', limitCents: 50000, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o });
  async function seed() {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(catDoc(db), category));
    return db;
  }

  it('cria, edita só o limite (patch) e exclui', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(budgetDoc(db), budget()));
    await assertSucceeds(updateDoc(budgetDoc(db), { limitCents: 80000, updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(budgetDoc(db)));
  });

  it('nega limite <= 0/fracionário, mês inválido, categoria inexistente e campo extra', async () => {
    const db = await seed();
    for (const bad of [{ limitCents: 0 }, { limitCents: 10.5 }, { month: '2026-13' }, { month: '2026-1' }, { month: 202611 }, { categoryId: 'zzz' }, { extra: 1 }]) {
      await assertFails(setDoc(budgetDoc(db, 'b9'), budget(bad)));
    }
  });

  it('isolamento: outro usuário e anônimo negados; createdAt imutável', async () => {
    const db = await seed();
    await assertSucceeds(setDoc(budgetDoc(db), budget()));
    await assertFails(updateDoc(budgetDoc(db), { createdAt: new Date('2000-01-01'), updatedAt: serverTimestamp() }));
    await assertFails(getDoc(budgetDoc(asUser(BOB))));
    await assertFails(getDoc(budgetDoc(asAnonymous())));
  });
});

describe('Contas: `name` opcional (Bancos) e receitas só com accountId', () => {
  const { name: _omit, ...nameless } = account;
  const incomePayload = (overrides = {}) => ({
    description: 'Salário', categoryId: 'cat-casa', amountCents: 500000, accountId: 'acc-sem-nome',
    expectedDate: new Date('2026-12-05'), status: 'pending', recurrence: 'none',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...overrides,
  });

  it('cria conta SEM `name` (só instituição)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-sem-nome'), nameless));
  });

  it('continua negando `name` vazio ou não-string, e instituição ausente', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'users', ALICE, 'accounts', 'x1'), { ...account, name: '' }));
    await assertFails(setDoc(doc(db, 'users', ALICE, 'accounts', 'x2'), { ...account, name: 42 }));
    const { institution: _i, ...noInstitution } = account;
    await assertFails(setDoc(doc(db, 'users', ALICE, 'accounts', 'x3'), noInstitution));
  });

  it('conta antiga (com name) segue válida; editar removendo `name` (deleteField) é aceito', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main')));
    await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'), { name: deleteField(), updatedAt: serverTimestamp() }));
    const snap = await getDoc(doc(db, 'users', ALICE, 'accounts', 'acc-main'));
    assert.equal('name' in snap.data(), false);
    assert.equal(snap.data().institution, 'Banco Exemplo');
  });

  it('receita referencia a conta sem nome só por accountId; persiste exatamente esse documento', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'users', ALICE, 'accounts', 'acc-sem-nome'), nameless));
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'incomes', 'r1'), incomePayload()));
    const stored = (await getDoc(doc(db, 'users', ALICE, 'incomes', 'r1'))).data();
    assert.deepEqual(Object.keys(stored).sort(), ['accountId', 'amountCents', 'categoryId', 'createdAt', 'description', 'expectedDate', 'recurrence', 'status', 'updatedAt']);
    assert.equal(stored.accountId, 'acc-sem-nome');
  });

  it('receita NÃO aceita institution/name da conta como campos próprios', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'users', ALICE, 'incomes', 'r2'), incomePayload({ accountId: 'acc-main', institution: 'Banco Exemplo' })));
    await assertFails(setDoc(doc(db, 'users', ALICE, 'incomes', 'r3'), incomePayload({ accountId: 'acc-main', name: 'Conta principal' })));
  });

  it('receita com conta inexistente é negada; editar mantém accountId', async () => {
    const db = asUser(ALICE);
    await assertFails(setDoc(doc(db, 'users', ALICE, 'incomes', 'r4'), incomePayload({ accountId: 'nao-existe' })));
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'incomes', 'r5'), incomePayload({ accountId: 'acc-main' })));
    await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'incomes', 'r5'), { description: 'Salário editado', updatedAt: serverTimestamp() }));
    assert.equal((await getDoc(doc(db, 'users', ALICE, 'incomes', 'r5'))).data().accountId, 'acc-main');
  });

  it('conta sem nome pode ser criada pelo dono; a exclusão (mesmo sem histórico) é da camada confiável (account.delete)', async () => {
    const db = asUser(ALICE);
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'accounts', 'acc-del'), nameless));
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'accounts', 'acc-del')));
  });
});

describe('Contas: saldo de abertura e data de abertura (VF-2-03ai)', () => {
  const dbA = () => asUser(ALICE);
  const accRef = (id) => doc(dbA(), 'users', ALICE, 'accounts', id);

  it('aceita conta com openingDate (timestamp) e saldo de abertura', async () => {
    await assertSucceeds(setDoc(accRef('acc-ab'), { ...account, openingDate: new Date('2026-11-01') }));
  });

  it('nega openingDate que não seja timestamp (string, número)', async () => {
    await assertFails(setDoc(accRef('acc-x1'), { ...account, openingDate: '2026-11-01' }));
    await assertFails(setDoc(accRef('acc-x2'), { ...account, openingDate: 20261101 }));
  });

  it('conta antiga sem openingDate segue válida; o AJUSTE de abertura é só da camada confiável (op account.adjustOpening)', async () => {
    const before = (await getDoc(accRef('acc-main'))).data().initialBalanceCents;
    await assertFails(updateDoc(accRef('acc-main'), { initialBalanceCents: 987654, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(accRef('acc-main'), { initialBalanceCents: 100, openingDate: new Date('2026-11-06'), updatedAt: serverTimestamp() }));
    assert.equal((await getDoc(accRef('acc-main'))).data().initialBalanceCents, before);
    // editar os demais campos segue permitido
    await assertSucceeds(updateDoc(accRef('acc-main'), { color: '#123456', updatedAt: serverTimestamp() }));
  });

  it('data de abertura não é removida/alterada pelo cliente; saldo de abertura não inteiro segue negado; `ledgerSeq` não nasce do cliente', async () => {
    await assertSucceeds(setDoc(accRef('acc-ab2'), { ...account, openingDate: new Date('2026-11-01') }));
    await assertFails(updateDoc(accRef('acc-ab2'), { openingDate: deleteField(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(accRef('acc-ab2'), { openingDate: new Date('2026-12-01'), updatedAt: serverTimestamp() }));
    assert.equal('openingDate' in (await getDoc(accRef('acc-ab2'))).data(), true);
    await assertFails(updateDoc(accRef('acc-main'), { initialBalanceCents: 10.5, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(accRef('acc-seq'), { ...account, ledgerSeq: 7 }));
    await assertFails(updateDoc(accRef('acc-main'), { ledgerSeq: 99, updatedAt: serverTimestamp() }));
  });

  it('outro usuário não ajusta o saldo de abertura alheio', async () => {
    await assertFails(updateDoc(doc(asUser(BOB), 'users', ALICE, 'accounts', 'acc-main'), { initialBalanceCents: 1, updatedAt: serverTimestamp() }));
  });
});

describe('Recebimentos (VF-ARQ-02): o cliente NUNCA grava; só a camada confiável (Admin SDK) — ex-VF-2-03ak/03al', () => {
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  const debtorDoc = (db) => doc(db, 'users', ALICE, 'debtors', 'dev1');
  const debtDoc = (db, id = 'd1') => doc(db, 'users', ALICE, 'debts', id);
  const payDoc = (db, id) => doc(db, 'users', ALICE, 'debtPayments', id);
  const payment = (o = {}) => ({
    debtId: 'd1', debtorId: 'dev1', amountCents: 4000, date: noon('2026-12-06'), accountId: 'acc1',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...o,
  });

  async function seedAll() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01') };
      await setDoc(doc(db, 'users', ALICE, 'accounts', 'acc1'), { ...account, ...base });
      await setDoc(doc(db, 'users', ALICE, 'debtors', 'dev1'), { name: 'Renan', loanDate: noon('2026-11-10'), lentCents: 23100, receivedCents: 4000, status: 'open', ...base });
      await setDoc(doc(db, 'users', ALICE, 'creditCards', 'card1'), { name: 'Nubank', ...base });
      await setDoc(doc(db, 'users', ALICE, 'cardPurchases', 'pc1'), { cardId: 'card1', description: 'Água', amountCents: 2500, purchaseDate: noon('2026-11-20'), installmentsTotal: 1, installmentNumber: 1, debtorId: 'dev1', ...base });
      await setDoc(doc(db, 'users', ALICE, 'debts', 'd1'), { debtorId: 'dev1', description: 'Parcela', principalCents: 10000, dueDate: noon('2026-12-30'), installmentNumber: 1, installmentsTotal: 1, debtGroupId: 'g', status: 'pending', ...base });
      await setDoc(doc(db, 'users', ALICE, 'debtPayments', 'pay-d1-1'), { debtId: 'd1', debtorId: 'dev1', amountCents: 4000, date: noon('2026-12-06'), accountId: 'acc1', ...base });
    });
    return asUser(ALICE);
  }

  it('o dono LÊ os recebimentos; não cria em nenhum formato (dívida, cartão, lote, increment, ID sequencial ou determinístico)', async () => {
    const db = await seedAll();
    await assertSucceeds(getDoc(payDoc(db, 'pay-d1-1')));
    await assertFails(setDoc(payDoc(db, 'novo'), payment()));
    const { debtId: _omit, ...cardPayment } = payment({ purchaseId: 'pc1', amountCents: 2500 });
    await assertFails(setDoc(payDoc(db, 'novo-cartao'), cardPayment));
    const batch = writeBatch(db);
    batch.set(payDoc(db, 'pay-d1-2'), payment({ amountCents: 6000 }));
    batch.update(debtDoc(db), { status: 'paid', updatedAt: serverTimestamp() });
    batch.update(debtorDoc(db), { receivedCents: increment(6000), status: 'paid', updatedAt: serverTimestamp() });
    await assertFails(batch.commit());
    const only = writeBatch(db);
    only.set(payDoc(db, 'pay-d1-3'), payment({ amountCents: 100 }));
    only.update(debtorDoc(db), { receivedCents: increment(100), updatedAt: serverTimestamp() });
    await assertFails(only.commit());
    assert.equal((await getDoc(debtorDoc(db))).data().receivedCents, 4000);
    assert.equal((await getDoc(debtDoc(db))).data().status, 'pending');
  });

  it('HISTÓRICO IMUTÁVEL: nem valor, data, conta, parcela, operationId, notas; nem regravar o mesmo ID; nem excluir', async () => {
    const db = await seedAll();
    for (const patch of [{ amountCents: 9999 }, { date: noon('2026-01-01') }, { accountId: 'acc1' }, { debtId: 'd1' }, { operationId: 'x' }, { notes: 'y' }]) {
      await assertFails(updateDoc(payDoc(db, 'pay-d1-1'), { ...patch, updatedAt: serverTimestamp() }));
    }
    await assertFails(setDoc(payDoc(db, 'pay-d1-1'), payment({ amountCents: 6000 })));
    await assertFails(deleteDoc(payDoc(db, 'pay-d1-1')));
    assert.equal((await getDoc(payDoc(db, 'pay-d1-1'))).data().amountCents, 4000);
  });

  it('o total do devedor e o status da parcela não são alterados pelo cliente (nem para cima, nem para baixo)', async () => {
    const db = await seedAll();
    for (const patch of [{ receivedCents: 5000 }, { receivedCents: 3999 }, { receivedCents: 0 }, { receivedCents: increment(1) }, { status: 'paid' }]) {
      await assertFails(updateDoc(debtorDoc(db), { ...patch, updatedAt: serverTimestamp() }));
    }
    for (const status of ['paid', 'cancelled', 'late']) await assertFails(updateDoc(debtDoc(db), { status, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(debtorDoc(db), { name: 'Renan Silva', updatedAt: serverTimestamp() })); // dados cadastrais seguem editáveis
  });

  it('outro usuário não lê nem registra recebimento no devedor alheio', async () => {
    await seedAll();
    await assertFails(getDoc(payDoc(asUser(BOB), 'pay-d1-1')));
    await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, 'debtPayments', 'bob'), payment()));
    await assertFails(updateDoc(doc(asUser(BOB), 'users', ALICE, 'debtors', 'dev1'), { receivedCents: 1, updatedAt: serverTimestamp() }));
  });

  it('coleções SÓ-SERVIDOR (reversals, operations, batches): o dono lê; ninguém do cliente cria, edita ou apaga; chave de OUTRO usuário é ilegível', async () => {
    const db = await seedAll();
    for (const coll of ['reversals', 'operations', 'batches']) {
      await seedDoc(`users/${ALICE}/${coll}/x1`, { op: 'seed' });
      await assertSucceeds(getDoc(doc(db, 'users', ALICE, coll, 'x1')));
      await assertFails(setDoc(doc(db, 'users', ALICE, coll, 'novo'), { op: 'forjado', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, 'users', ALICE, coll, 'x1'), { op: 'alterado', updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(doc(db, 'users', ALICE, coll, 'x1')));
      await assertFails(getDoc(doc(asUser(BOB), 'users', ALICE, coll, 'x1')));
      await assertFails(setDoc(doc(asUser(BOB), 'users', ALICE, coll, 'bob'), { op: 'x' }));
    }
  });

  it('despesa/receita/transferência: o cliente não liquida nem exclui o liquidado (pago/recebido/confirmado: só estorno do servidor)', async () => {
    const db = await seedAll();
    await seedDoc(`users/${ALICE}/accounts/acc2`, { ...account });
    await seedDoc(`users/${ALICE}/categories/cat-casa`, { name: 'Casa', kind: 'both', color: '#000000' });
    await seedDoc(`users/${ALICE}/expenses/ePaid`, { description: 'x', categoryId: 'cat-casa', amountCents: 100, accountId: 'acc1', purchaseDate: noon('2026-11-01'), dueDate: noon('2026-11-10'), status: 'paid', paidDate: noon('2026-11-10'), recurrence: 'none' });
    await seedDoc(`users/${ALICE}/expenses/ePend`, { description: 'x', categoryId: 'cat-casa', amountCents: 100, accountId: 'acc1', purchaseDate: noon('2026-11-01'), dueDate: noon('2026-11-10'), status: 'pending', recurrence: 'none' });
    await assertFails(updateDoc(doc(db, 'users', ALICE, 'expenses', 'ePaid'), { amountCents: 1, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'expenses', 'ePaid')));
    await assertFails(updateDoc(doc(db, 'users', ALICE, 'expenses', 'ePend'), { status: 'paid', paidDate: noon('2026-11-10'), updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'expenses', 'ePend'), { description: 'editada', updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(doc(db, 'users', ALICE, 'expenses', 'ePend')));
    await seedDoc(`users/${ALICE}/transfers/tConf`, { fromAccountId: 'acc1', toAccountId: 'acc2', amountCents: 100, date: noon('2026-11-02'), reason: 'x', status: 'confirmed' });
    await assertFails(updateDoc(doc(db, 'users', ALICE, 'transfers', 'tConf'), { status: 'cancelled', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'transfers', 'tConf')));
  });
});

describe('Devedor quitado recebe nova dívida e volta a open (VF-2-03am)', () => {
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  const debtorDoc = (db) => doc(db, 'users', ALICE, 'debtors', 'dev1');
  const debtDoc = (db, id) => doc(db, 'users', ALICE, 'debts', id);

  async function seedPaid() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01') };
      await setDoc(doc(db, 'users', ALICE, 'debtors', 'dev1'), { name: 'Renan', loanDate: noon('2026-11-10'), lentCents: 10000, receivedCents: 10000, status: 'paid', ...base });
    });
    return asUser(ALICE);
  }

  it('lote: novas parcelas + lentCents por increment + status open (devedor quitado reaberto)', async () => {
    const db = await seedPaid();
    const batch = writeBatch(db);
    batch.set(debtDoc(db, 'n1'), { debtorId: 'dev1', description: 'Nova', principalCents: 3000, dueDate: noon('2026-12-10'), installmentNumber: 1, installmentsTotal: 1, debtGroupId: 'g', status: 'pending', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    batch.update(debtorDoc(db), { lentCents: increment(3000), status: 'open', updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    const d = (await getDoc(debtorDoc(db))).data();
    assert.deepEqual([d.lentCents, d.receivedCents, d.status], [13000, 10000, 'open']);
  });

  it('continua negando recebido acima do emprestado mesmo reaberto, e editar nome de quitado é aceito', async () => {
    const db = await seedPaid();
    await assertFails(updateDoc(debtorDoc(db), { receivedCents: increment(1), updatedAt: serverTimestamp() })); // 10001 > 10000
    await assertSucceeds(updateDoc(debtorDoc(db), { name: 'Renan Silva', updatedAt: serverTimestamp() }));
    assert.equal((await getDoc(debtorDoc(db))).data().status, 'paid');
  });
});

describe('Auditoria VF-2-03ao: proteção do histórico financeiro (recebimentos, parcelas, compras, faturas)', () => {
  const noon = (d) => new Date(`${d}T12:00:00.000Z`);
  const asAdmin = () => testEnv.authenticatedContext('admin-uid', { admin: true }).firestore();
  const U = (db, c, id) => doc(db, 'users', ALICE, c, id);
  const stamps = () => ({ createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  const pay = (o = {}) => ({ debtId: 'd1', debtorId: 'dev1', amountCents: 5000, date: noon('2026-12-06'), accountId: 'acc1', ...stamps(), ...o });
  const payCard = (purchaseId, o = {}) => ({ purchaseId, debtorId: 'dev1', amountCents: 5000, date: noon('2026-12-06'), accountId: 'acc1', ...stamps(), ...o });

  async function seedWorld() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01') };
      await setDoc(U(db, 'accounts', 'acc1'), { ...account, ...base });
      for (const id of ['dev1', 'dev2']) await setDoc(U(db, 'debtors', id), { name: id, loanDate: noon('2026-11-10'), lentCents: 100000, receivedCents: 0, status: 'open', ...base });
      await setDoc(U(db, 'debts', 'd1'), { debtorId: 'dev1', description: 'P', principalCents: 5000, dueDate: noon('2026-12-10'), installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', status: 'pending', ...base });
      await setDoc(U(db, 'debts', 'd2'), { debtorId: 'dev2', description: 'Q', principalCents: 5000, dueDate: noon('2026-12-10'), installmentNumber: 1, status: 'pending', ...base });
      await setDoc(U(db, 'debts', 'dpaid'), { debtorId: 'dev1', description: 'Z', principalCents: 5000, dueDate: noon('2026-12-10'), installmentNumber: 2, status: 'paid', ...base });
      await setDoc(U(db, 'creditCards', 'card1'), { name: 'N', ...base });
      await setDoc(U(db, 'cardPurchases', 'pc1'), { cardId: 'card1', description: 'Água', amountCents: 5000, purchaseDate: noon('2026-11-20'), installmentsTotal: 1, installmentNumber: 1, debtorId: 'dev1', ...base });
      await setDoc(U(db, 'cardPurchases', 'pcOwn'), { cardId: 'card1', description: 'Minha', amountCents: 900, purchaseDate: noon('2026-11-20'), installmentsTotal: 1, installmentNumber: 1, ...base });
      await setDoc(U(db, 'invoices', 'invPaid'), { cardId: 'card1', referenceMonth: '2026-12', dueDate: noon('2026-12-06'), status: 'paid', totalCents: 5000, paidCents: 5000, accountId: 'acc1', paidAt: noon('2026-12-06'), ...base });
      await setDoc(U(db, 'invoices', 'invOpen'), { cardId: 'card1', referenceMonth: '2027-01', dueDate: noon('2027-01-06'), status: 'open', ...base });
      for (let i = 0; i < 40; i += 1) await setDoc(U(db, 'debts', `m${i}`), { debtorId: 'dev1', description: 'M', principalCents: 100, dueDate: noon('2026-12-10'), installmentNumber: i + 1, status: 'pending', ...base });
    });
    return asUser(ALICE);
  }

  describe('recebimentos (debtPayments)', () => {
    it('VF-ARQ-02: nenhum recebimento nasce do cliente (solto, em lote, no limite ou acima) e o histórico existente é intocável', async () => {
      const db = await seedWorld();
      await assertFails(setDoc(U(db, 'debtPayments', 'pay-d1-1'), pay()));
      await assertFails(receive(db, U(db, 'debtPayments', 'pay-d1-1'), pay(), U(db, 'debtors', 'dev1')));
      await assertFails(receive(db, U(db, 'debtPayments', 'a3'), payCard('pc1', { amountCents: 5000 }), U(db, 'debtors', 'dev1')));
      await assertFails(receive(db, U(db, 'debtPayments', 'b1'), pay({ debtId: 'd2' }), U(db, 'debtors', 'dev1')));
      const b = writeBatch(db);
      for (let i = 0; i < 10; i += 1) b.set(U(db, 'debtPayments', `pay-m${i}-1`), pay({ debtId: `m${i}`, amountCents: 100 }));
      b.update(U(db, 'debtors', 'dev1'), { receivedCents: increment(1000), updatedAt: serverTimestamp() });
      await assertFails(b.commit());
      assert.equal((await getDoc(U(db, 'debtors', 'dev1'))).data().receivedCents, 0);
    });

    it('EXCLUSÃO: só o administrador apaga recebimento (o dono não, mesmo sem devedor); o dono lê', async () => {
      const db = await seedWorld();
      await seedDoc(`users/${ALICE}/debtPayments/pay-d1-1`, { debtId: 'd1', debtorId: 'dev1', amountCents: 5000, date: noon('2026-12-06'), accountId: 'acc1' });
      await assertSucceeds(getDoc(U(db, 'debtPayments', 'pay-d1-1')));
      await assertFails(deleteDoc(U(db, 'debtPayments', 'pay-d1-1')));
      await assertFails(deleteDoc(doc(asUser(BOB), 'users', ALICE, 'debtPayments', 'pay-d1-1')));
      await assertFails(deleteDoc(U(db, 'debtors', 'dev1'))); // nem o devedor (histórico): arquivar/excluir é do servidor
      await assertFails(deleteDoc(U(db, 'debtPayments', 'pay-d1-1')));
      await assertSucceeds(deleteDoc(doc(asAdmin(), 'users', ALICE, 'debtPayments', 'pay-d1-1')));
    });
  });

  describe('devedores, parcelas, compras e faturas', () => {
    it('devedor: o total recebido NÃO é alterado pelo cliente (nem sobe, nem desce, nem passa do emprestado)', async () => {
      const db = await seedWorld();
      for (const receivedCents of [5000, 1, 4999, 100001]) await assertFails(updateDoc(U(db, 'debtors', 'dev1'), { receivedCents, updatedAt: serverTimestamp() }));
      assert.equal((await getDoc(U(db, 'debtors', 'dev1'))).data().receivedCents, 0);
    });

    it('parcela de dívida: valor, vencimento, número, descrição e devedor são imutáveis; só o status muda', async () => {
      const db = await seedWorld();
      for (const patch of [{ principalCents: 1 }, { dueDate: noon('2030-01-01') }, { installmentNumber: 9 }, { description: 'outra' }, { debtorId: 'dev2' }, { installmentsTotal: 9 }, { debtGroupId: 'x' }]) {
        await assertFails(updateDoc(U(db, 'debts', 'd1'), { ...patch, updatedAt: serverTimestamp() }));
      }
      await assertFails(updateDoc(U(db, 'debts', 'd1'), { status: 'paid', updatedAt: serverTimestamp() })); // VF-ARQ-02: só o servidor altera parcelas
    });

    it('parcela de dívida não é excluída pelo dono (histórico; só administrador ou o servidor); a criação é só `pending`', async () => {
      const db = await seedWorld();
      await assertFails(deleteDoc(U(db, 'debts', 'dpaid')));
      await assertFails(deleteDoc(U(db, 'debts', 'd2')));
      await assertSucceeds(deleteDoc(doc(asAdmin(), 'users', ALICE, 'debts', 'dpaid')));
    });

    it('compra de cartão: imutável depois de lançada; compra de DEVEDOR não é excluída pelo dono; compra própria pode', async () => {
      const db = await seedWorld();
      for (const patch of [{ amountCents: 1 }, { debtorId: 'dev2' }, { invoiceId: 'invOpen' }]) {
        await assertFails(updateDoc(U(db, 'cardPurchases', 'pc1'), { ...patch, updatedAt: serverTimestamp() }));
      }
      await assertFails(deleteDoc(U(db, 'cardPurchases', 'pc1')));
      await assertSucceeds(deleteDoc(U(db, 'cardPurchases', 'pcOwn')));
      await assertSucceeds(deleteDoc(doc(asAdmin(), 'users', ALICE, 'cardPurchases', 'pc1')));
    });

    it('fatura PAGA: valor, conta e status não mudam e ela não é excluída pelo dono; aberta/fechada pode ser paga', async () => {
      const db = await seedWorld();
      for (const patch of [{ paidCents: 1 }, { accountId: 'acc1' }, { status: 'open' }, { status: 'cancelled' }, { totalCents: 1 }]) {
        await assertFails(updateDoc(U(db, 'invoices', 'invPaid'), { ...patch, updatedAt: serverTimestamp() }));
      }
      await assertFails(deleteDoc(U(db, 'invoices', 'invPaid')));
      // VF-ARQ-02: pagar é do servidor (op invoice.pay): o cliente não consegue marcar a fatura como paga
      await assertFails(updateDoc(U(db, 'invoices', 'invOpen'), { status: 'paid', totalCents: 900, paidCents: 900, accountId: 'acc1', paidAt: noon('2027-01-06'), updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(U(db, 'invoices', 'invOpen'), { paidCents: 1, updatedAt: serverTimestamp() }));
      await assertSucceeds(deleteDoc(doc(asAdmin(), 'users', ALICE, 'invoices', 'invPaid')));
    });
  });
});

describe('Auditoria final VF-ARQ-02: terceiros e originais estornados', () => {
  const COLLECTIONS = ['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'subscriptions', 'debtors', 'debts', 'debtPayments', 'goals',
    'goalTransactions', 'creditCards', 'cardPurchases', 'invoices', 'budgets', 'reversals', 'operations', 'batches', 'auditLog', 'profile', 'settings'];

  it('VARREDURA: outro usuário (e anônimo) NÃO lê, cria, edita nem apaga documento de NENHUMA coleção do dono', async () => {
    for (const coll of COLLECTIONS) await seedDoc(`users/${ALICE}/${coll}/alvo`, { description: 'x', amountCents: 100, status: 'pending' });
    const owner = asUser(ALICE); // o dono lê as próprias coleções: serve de testemunha do estado
    const sizeBefore = {};
    for (const coll of COLLECTIONS) sizeBefore[coll] = (await getDocs(collection(owner, 'users', ALICE, coll))).size;
    for (const [label, db] of [['bob', asUser(BOB)], ['anônimo', asAnonymous()]]) {
      for (const coll of COLLECTIONS) {
        const ref = doc(db, 'users', ALICE, coll, 'alvo');
        await assertFails(getDoc(ref));
        await assertFails(setDoc(doc(db, 'users', ALICE, coll, 'novo'), { description: 'x', amountCents: 100, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
        await assertFails(updateDoc(ref, { amountCents: 1, updatedAt: serverTimestamp() }));
        await assertFails(deleteDoc(ref));
        await assertFails(getDocs(collection(db, 'users', ALICE, coll)));
      }
      assert.ok(label);
    }
    // nada foi alterado/criado/removido
    for (const coll of COLLECTIONS) {
      const snap = await getDocs(collection(owner, 'users', ALICE, coll));
      assert.equal(snap.size, sizeBefore[coll], coll); // nenhum documento criado/removido
      assert.equal(snap.docs.find((d) => d.id === 'alvo').data().amountCents, 100, coll); // nenhum alterado
    }
  });

  it('original ESTORNADO não é apagado pelo dono (despesa, receita, transferência, fatura); sem estorno, o pendente continua apagável', async () => {
    const base = { description: 'x', categoryId: 'c', amountCents: 100, accountId: 'a' };
    await seedDoc(`users/${ALICE}/expenses/e1`, { ...base, status: 'pending', purchaseDate: new Date(), dueDate: new Date(), recurrence: 'none' });
    await seedDoc(`users/${ALICE}/expenses/e2`, { ...base, status: 'pending', purchaseDate: new Date(), dueDate: new Date(), recurrence: 'none' });
    await seedDoc(`users/${ALICE}/incomes/i1`, { ...base, status: 'pending', expectedDate: new Date(), recurrence: 'none' });
    await seedDoc(`users/${ALICE}/transfers/t1`, { fromAccountId: 'a', toAccountId: 'b', amountCents: 100, date: new Date(), reason: 'x', status: 'cancelled' });
    await seedDoc(`users/${ALICE}/creditCards/card`, { name: 'N' });
    await seedDoc(`users/${ALICE}/invoices/inv1`, { cardId: 'card', referenceMonth: '2026-12', status: 'closed', totalCents: 100 });
    for (const [coll, id] of [['expenses', 'e1'], ['incomes', 'i1'], ['transfers', 't1'], ['invoices', 'inv1']]) {
      await seedDoc(`users/${ALICE}/reversals/${coll}_${id}`, { kind: 'x', targetCollection: coll, targetId: id, amountCents: 100 });
    }
    const db = asUser(ALICE);
    for (const [coll, id] of [['expenses', 'e1'], ['incomes', 'i1'], ['transfers', 't1'], ['invoices', 'inv1']]) {
      await assertFails(deleteDoc(doc(db, 'users', ALICE, coll, id)));
      assert.equal((await getDoc(doc(db, 'users', ALICE, coll, id))).exists(), true, `${coll}/${id} preservado`);
    }
    await assertSucceeds(deleteDoc(doc(db, 'users', ALICE, 'expenses', 'e2'))); // pendente SEM estorno segue apagável
  });
});

describe('Auditoria final: compras de fatura fechada/paga e total editado', () => {
  it('o dono não apaga compra de fatura FECHADA nem PAGA; compra de fatura ABERTA continua apagável; não edita o total de fatura paga', async () => {
    await seedDoc(`users/${ALICE}/creditCards/card`, { name: 'N' });
    for (const [id, status] of [['invOpen', 'open'], ['invClosed', 'closed'], ['invPaid', 'paid']]) {
      await seedDoc(`users/${ALICE}/invoices/${id}`, { cardId: 'card', referenceMonth: '2026-12', status, totalCents: 500, ...(status === 'paid' ? { paidCents: 500, accountId: 'acc-main', paidAt: new Date() } : {}) });
      await seedDoc(`users/${ALICE}/cardPurchases/p_${id}`, { cardId: 'card', description: 'x', amountCents: 500, purchaseDate: new Date(), installmentsTotal: 1, installmentNumber: 1, invoiceId: id });
    }
    const db = asUser(ALICE);
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'cardPurchases', 'p_invClosed')));
    await assertFails(deleteDoc(doc(db, 'users', ALICE, 'cardPurchases', 'p_invPaid')));
    await assertSucceeds(deleteDoc(doc(db, 'users', ALICE, 'cardPurchases', 'p_invOpen')));
    await assertFails(updateDoc(doc(db, 'users', ALICE, 'invoices', 'invPaid'), { totalCents: 1, paidCents: 1, updatedAt: serverTimestamp() }));
  });
});
