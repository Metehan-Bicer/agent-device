import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findSessionStateWrites,
  SESSION_STATE_FIELD_OWNERS,
  sessionStateWritePressure,
} from './session-state.ts';

const OWNER = 'src/daemon/app-log-session-resource.ts';
const FIELDS = ['appLog', 'appLogFailure', 'lease', 'lastPerfProfile'];
function scan(source: string, file = OWNER) {
  return findSessionStateWrites(new Map([[file, source]]), FIELDS);
}

test('explicit owner patches name their writes and retain direct assignment checks', () => {
  assert.deepEqual(
    scan('store.update(ref, { appLogFailure: undefined });\nsession.appLog = log;').map((w) => [
      w.field,
      w.line,
    ]),
    [
      ['appLogFailure', 1],
      ['appLog', 2],
    ],
  );
  assert.ok(SESSION_STATE_FIELD_OWNERS.appLogFailure!.includes(OWNER));
  const foreign = scan(
    'sessionStore.update(ref, { appLogFailure: error });',
    'src/daemon/handlers/probe.ts',
  )[0]!;
  assert.equal(foreign.field, 'appLogFailure');
  assert.ok(!SESSION_STATE_FIELD_OWNERS[foreign.field]!.includes(foreign.file));
});

test('inline synchronous patches can derive named fields with nested value spreads', () => {
  for (const patch of [
    '(current) => ({ lease: { ...current.lease, expiresAt: 10 } })',
    '(current) => { const expiresAt = 10; return { lease: { ...current.lease, expiresAt } }; }',
    'function(current) { return { lease: { ...current.lease, expiresAt: 10 } }; }',
  ])
    assert.deepEqual(
      scan(`store.update(ref, ${patch});`).map((w) => w.field),
      ['lease'],
      patch,
    );
});

for (const patch of [
  '{ [key]: value }',
  '{ ...changes }',
  'changes',
  'rebuild',
  'async (current) => ({ appLogFailure: undefined })',
  '(current) => changes',
  '(current) => { if (test) return changes; return { appLogFailure: undefined }; }',
  '{ get appLogFailure() { return error; } }',
]) {
  test(`update rejects unattributable patch ${patch}`, () => {
    assert.ok(scan(`store.update(ref, ${patch});`).some((w) => w.field === '[patch-shape]'));
  });
}

test('patch callbacks cannot call back into the session store', () => {
  const writes = scan(
    'store.update(ref, (current) => { store.retire(ref); return { appLogFailure: undefined }; });',
  );
  assert.ok(writes.some((w) => w.field === '[reentrant-patch]'));
  assert.ok(writes.some((w) => w.field === 'appLogFailure'));
});

test('the historical app-log whole-record spread is refused and counted fairly', () => {
  const writes = scan(
    'const session = sessionStore.get(address); sessionStore.set(address, { ...session, appLogFailure: error });',
  );
  assert.deepEqual(
    writes.map((w) => w.field),
    ['[whole-record-spread]', 'appLogFailure'],
  );
});

test('record copies through a read alias or captured ref remain visible', () => {
  for (const source of [
    'const refreshed = params.sessionStore.get(address) ?? session; return { ...refreshed, lastPerfProfile: profile };',
    'const previous: SessionState = value; return { ...previous, lastPerfProfile: profile };',
    'return { ...ref.session, lastPerfProfile: profile };',
  ])
    assert.deepEqual(
      scan(source).map((w) => w.field),
      ['[whole-record-spread]', 'lastPerfProfile'],
      source,
    );
});

test('typed store aliases enforce the same explicit patch contract', () => {
  assert.deepEqual(
    scan(
      'function update(storage: SessionStore) { storage.update(ref, { appLogFailure: error }); }',
    ).map((w) => w.field),
    ['appLogFailure'],
  );
  assert.deepEqual(
    scan('function update(storage: SessionStore) { storage.update(ref, changes); }').map(
      (w) => w.field,
    ),
    ['[patch-shape]'],
  );
});

test('plain store and record aliases retain their owning identity', () => {
  assert.deepEqual(
    scan('const storage = sessionStore; storage.update(ref, { appLogFailure: error });').map(
      (w) => w.field,
    ),
    ['appLogFailure'],
  );
  for (const source of [
    'const current = ref.session; return { ...current };',
    'const current = session; return { ...current };',
  ]) {
    assert.deepEqual(
      scan(source).map((w) => w.field),
      ['[whole-record-spread]'],
      source,
    );
  }
});

test('destructuring preserves store and record aliases', () => {
  for (const pattern of ['{ session: current }', '{ session: current = fallback }']) {
    assert.deepEqual(
      scan(`const ${pattern} = ref; return { ...current, appLogFailure: error };`).map(
        (w) => w.field,
      ),
      ['[whole-record-spread]', 'appLogFailure'],
    );
  }
  assert.deepEqual(
    scan('function copy({ session: current }: SessionRef) { return { ...current }; }').map(
      (w) => w.field,
    ),
    ['[whole-record-spread]'],
  );
  assert.deepEqual(
    scan('const { sessionStore: storage } = params; storage.update(ref, changes);').map(
      (w) => w.field,
    ),
    ['[patch-shape]'],
  );
});

test('alias declarations and patch parameters are collected before checking writes', () => {
  assert.deepEqual(
    scan(
      'function patch() { const nested = storage; nested.update(ref, changes); } const storage = sessionStore;',
    ).map((w) => w.field),
    ['[patch-shape]'],
  );
  assert.deepEqual(
    scan(
      'store.update(ref, (current) => { const entry = current; entry.lastPerfProfile = profile; return { appLogFailure: undefined }; });',
    ).map((w) => w.field),
    ['appLogFailure', 'lastPerfProfile'],
  );
});

test('draft exceptions cover only the declared constructors and fresh open publication', () => {
  for (const [file, constructor] of [
    ['src/daemon/snapshot-session.ts', 'createSnapshotSession'],
    ['src/daemon/handlers/record-runtime.ts', 'createRecordOnlySession'],
  ]) {
    assert.deepEqual(
      scan(
        `function ${constructor}(session: SessionState) { return { ...session, appLogFailure: undefined }; }`,
        file,
      ),
      [],
    );
    assert.ok(
      scan('function updateSession(session: SessionState) { return { ...session }; }', file).some(
        (w) => w.field === '[whole-record-spread]',
      ),
    );
  }
  const open = 'src/daemon/session-lifecycle/internal/session-open-state.ts';
  assert.deepEqual(
    scan(
      'function publishOpenSession(session: SessionState) { return store.publish(address, { ...session }); }',
      open,
    ),
    [],
  );
  assert.ok(
    scan(
      'function publishOpenSession(session: SessionState) { return store.update(ref, { ...session }); }',
      open,
    ).some((w) => w.field === '[patch-shape]'),
  );
  assert.ok(
    scan(
      'function publishOpenSession(session: SessionState) { const next = { ...session }; return next; }',
      open,
    ).some((w) => w.field === '[whole-record-spread]'),
  );
});

test('the owning store can merge records, while unrelated updates and platform sessions are excluded', () => {
  assert.deepEqual(
    scan(
      'sessionStore.update(ref, changes); session.appLogFailure = error;',
      'src/daemon/session-store.ts',
    ),
    [],
  );
  assert.deepEqual(scan('coordinator.update((session) => ({})); hash.update(data);'), []);
  assert.deepEqual(
    scan('return { ...session, appLogFailure: error };', 'packages/platform-apple/src/session.ts'),
    [],
  );
});

test('pressure counts capture-kit record replacement and daemon patches with the same syntax rules', () => {
  const declaration =
    'export type SessionState = {\n  appLogFailure?: Error;\n  lease?: object;\n};';
  const baseline = new Map([
    ['src/daemon/session-state.ts', declaration],
    ['src/daemon/owner.ts', 'session.appLogFailure = error;'],
    [
      'packages/capture-kit/src/capture-admission/owner.ts',
      'const next = { ...session, appLogFailure: error };',
    ],
  ]);
  const current = new Map([
    ['src/daemon/session-state.ts', declaration],
    [OWNER, 'store.update(ref, { appLogFailure: error });'],
    ['src/daemon/invalid.ts', 'store.update(ref, changes);'],
  ]);
  assert.deepEqual(sessionStateWritePressure(baseline), {
    writerOwnedFields: 1,
    ownerFileClaims: 2,
  });
  assert.deepEqual(sessionStateWritePressure(current), {
    writerOwnedFields: 1,
    ownerFileClaims: 1,
  });
});
