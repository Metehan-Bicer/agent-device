/** SessionState field ownership for assignments, named patches and record copies. */

import { parseSync } from 'oxc-parser';
import { memberName, memberPath, propertyName, visitAst } from './layering-ast.ts';
import path from 'node:path';

export type SessionStateWrite = {
  file: string;
  line: number;
  field: string;
};

/**
 * Which modules may write each `SessionState` field, as paths under `src/`. A field whose
 * owner list has one entry is a field only that module can get wrong.
 */
export const SESSION_STATE_FIELD_OWNERS: Readonly<Record<string, readonly string[]>> = {
  // ADR 0014 ref frame. The four frame fields this row replaced moved together or the frame was
  // incoherent, and only this table said so; `RefFrame` is now a nominal type (`#`-private
  // fields) that no other module can construct, edit, or spread into a new frame, and the
  // transitions replace it whole. The row stays because the type cannot judge a whole frame
  // moved unchanged: assigning `undefined` (a reset to the pristine frame) and assigning a
  // frame read off another session.
  refFrame: ['src/daemon/ref-frame.ts'],
  // Scoped-snapshot lineage is cleared at two distinct events: crossing a device side-effect
  // seam (ref-frame.ts) and replacing the stored observation (session-snapshot.ts).
  snapshotScopeSource: ['src/daemon/ref-frame.ts', 'src/daemon/session-snapshot.ts'],
  snapshot: ['src/daemon/session-snapshot.ts'],
  snapshotGeneration: ['src/daemon/session-snapshot.ts'],
  lastComparisonSafeSnapshot: ['src/daemon/session-snapshot.ts'],
  androidSnapshotFreshness: ['src/daemon/session-snapshot-freshness.ts'],
  // One-shot deferred-warning latch (#1587 follow-up): the transition function is the only
  // writer, so the latch's window semantics live in a single module.
  recoveredSnapshotWarningLatch: ['src/daemon/snapshot-quality-latch.ts'],

  // #1478 P4a script publication. The tagged aggregate replaced the eight co-resident
  // `saveScript*`/`scriptRecordingState`/`repair*` fields; its ONLY writers are the two
  // daemon-private projections (`session-replay-transaction.ts`,
  // `session-script-publication-capability.ts`) and the writer's commit transition.
  // It also absorbed `recordSession`, whose separate ownership let handler surfaces arm
  // recording without moving the lifecycle that authorized it (#1533). Recording is now derived
  // (`isRecordingPublication`), so there is no second field to keep in step.
  scriptPublication: [
    'src/daemon/session-replay-transaction.ts',
    'src/daemon/session-script-publication-capability.ts',
    'src/daemon/session-script-writer.ts',
  ],
  // #1478 P4b: moved from `session-replay-resume.ts` into the `ReplayCoordinator`
  // (`session-replay-coordinator.ts`) — the one locked gateway a native replay request uses to
  // reach both this watermark and the P4a `scriptPublication` transitions above.
  pendingRecordAndHeal: ['src/daemon/session-replay-coordinator.ts'],

  trace: ['src/daemon/handlers/trace-runtime.ts'],
  postGestureStabilization: ['src/daemon/deferred-interaction-outcome.ts'],

  // App identity follows open, deployment and observation through named patches.
  appName: [
    'src/daemon/handlers/session-app-deployment.ts',
    'src/daemon/session-lifecycle/internal/session-open-state.ts',
    'src/daemon/snapshot-command-runtime.ts',
  ],
  appBundleId: [
    'src/daemon/handlers/session-app-deployment.ts',
    'src/daemon/handlers/session-selector-dispatch.ts',
    'src/daemon/session-lifecycle/internal/session-open-state.ts',
  ],
  appLog: ['src/daemon/app-log-session-resource.ts'],
  appLogFailure: ['src/daemon/app-log-session-resource.ts'],
  audioProbe: ['src/daemon/session-capture-binding.ts'],
  perfCapture: ['src/daemon/session-capture-binding.ts'],
  screenRecording: ['src/daemon/session-capture-binding.ts'],
  lastPerfProfile: ['src/daemon/session-observability/internal/session-perf-runtime.ts'],
  device: ['src/daemon/session-lifecycle/internal/session-open-state.ts'],
  surface: ['src/daemon/session-lifecycle/internal/session-open-state.ts'],
  // Open execution owns the paired lease/claim transition after the handler has admitted one
  // lifecycle binding. Keeping the records together prevents request-policy routing from gaining
  // a second durable owner as the execution seam stays package-bound.
  lease: [
    'src/daemon/lease-lifecycle.ts',
    'src/daemon/session-lifecycle/internal/session-open-state.ts',
  ],
  deviceClaim: ['src/daemon/session-lifecycle/internal/session-open-state.ts'],

  // #1398 (ADR 0017 session-scoped echo protection amendment): the ephemeral
  // literal->placeholder registry is populated and consulted only at the
  // recorder's single choke point.
  recordedFillLiterals: ['src/daemon/session-action-recorder.ts'],
};

/**
 * Fields no daemon module writes through a session binding: they are set when the record is
 * constructed (an object literal, not a field assignment) or inside `session-store.ts`, which
 * owns the record and is excluded from the scan.
 *
 * This list exists so the classification is EXHAUSTIVE. Without it, a new `SessionState` field
 * that happened to have no direct write would satisfy the gate by being invisible to it, and R7
 * would silently stop covering part of the type it claims to cover. Being here is a positive
 * claim — "the store establishes this, nothing mutates it later" — so acquiring a direct write
 * fails the gate until the field is moved into `SESSION_STATE_FIELD_OWNERS` with a real owner.
 */
export const STORE_OWNED_SESSION_STATE_FIELDS: ReadonlySet<string> = new Set([
  'actions',
  'createdAt',
  // #2833: the request path reports session activity through `SessionStore.noteSessionActivity`, so
  // the only writer of this field is the store that owns the record.
  'lastActivityAtMs',
  'name',
  'recordOnlySession',
  'sessionScope',
  'snapshotDiagnostics',
]);

export function sessionStateFieldCount(): number {
  return Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size;
}

export type FieldClassificationDrift = {
  field: string;
  problem: 'unclassified' | 'both' | 'not-a-field';
};

/**
 * Where the two ownership tables disagree with `SessionState` itself. Empty means every declared
 * field is classified exactly once and neither table names a field that no longer exists.
 */
export function fieldClassificationDrift(fields: readonly string[]): FieldClassificationDrift[] {
  const declared = new Set(fields);
  const owned = new Set(Object.keys(SESSION_STATE_FIELD_OWNERS));
  const drift: FieldClassificationDrift[] = [];

  for (const field of fields) {
    const inOwners = owned.has(field);
    const inStore = STORE_OWNED_SESSION_STATE_FIELDS.has(field);
    if (inOwners && inStore) drift.push({ field, problem: 'both' });
    else if (!inOwners && !inStore) drift.push({ field, problem: 'unclassified' });
  }
  for (const field of [...owned, ...STORE_OWNED_SESSION_STATE_FIELDS]) {
    if (!declared.has(field)) drift.push({ field, problem: 'not-a-field' });
  }

  return drift.sort((left, right) => left.field.localeCompare(right.field));
}

const SESSION_STATE_DECLARATION = /export type SessionState = \{([\s\S]*?)\n\};/;

/**
 * The daemon module that declares `SessionState`, found by the declaration rather than by a
 * recorded path. `sessionStateWritePressure` below measures the merge-base tree with the same
 * function, and that tree's declaration may still sit where this tree no longer has it — a
 * path constant would silently measure such a tree as zero pressure and bank the headroom.
 */
export function sessionStateDeclarationFile(
  sources: ReadonlyMap<string, string>,
): string | undefined {
  for (const [file, source] of sources) {
    if (file.startsWith('src/daemon/') && SESSION_STATE_DECLARATION.test(source)) return file;
  }
  return undefined;
}

/**
 * Field names declared by `SessionState` itself, so the scan cannot be fooled by a daemon
 * module with an unrelated local named `session` (a provider session, a runner session).
 */
export function sessionStateFields(typesSource: string): string[] {
  const declaration = SESSION_STATE_DECLARATION.exec(typesSource);
  if (!declaration) throw new Error('SessionState declaration not found');
  return [...declaration[1]!.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*)\??:/gm)].map(
    (match) => match[1]!,
  );
}

/**
 * Whether a binding holds a `SessionState`. The daemon names these records by role, not always
 * `session`: `nextSession`, `provisionalSession`, `completedSession`, `preRunSession`,
 * `preEntrySession`, `activeSession`. Matching only the literal name `session` is what let three
 * genuine foreign writes sit unreported — `nextSession.snapshotGeneration` in snapshot-runtime.ts
 * among them — while the gate claimed every write was inside its owner.
 *
 * There is no type information here, so this is a name test, and it is deliberately paired with
 * the declared-field filter in `findSessionStateWrites`: a binding must look like a session AND
 * the field must be one `SessionState` declares. A provider or runner session that happens to be
 * named `…Session` only registers if it also writes a field name `SessionState` owns, and the
 * remedy then is to declare the owner — the same remedy as for a real write.
 */
function isSessionBinding(name: string): boolean {
  return /session/i.test(name);
}

/** A member expression being assigned to, or updated with `++`/`--`. */
type WriteTarget = {
  object: string | undefined;
  field: string | undefined;
  computed: boolean;
  offset: number;
};

function writeTarget(node: Record<string, unknown>): WriteTarget | null {
  const type = node['type'];
  const member =
    type === 'AssignmentExpression'
      ? (node['left'] as Record<string, unknown> | undefined)
      : type === 'UpdateExpression'
        ? (node['argument'] as Record<string, unknown> | undefined)
        : undefined;
  if (!member || member['type'] !== 'MemberExpression') return null;
  const object = member['object'] as Record<string, unknown> | undefined;
  const property = member['property'] as Record<string, unknown> | undefined;
  return {
    // Only a direct `<identifier>.field` write is a session write; `a.b.c = …` writes into a
    // sub-object and its `object` is a MemberExpression, so it has no identifier name here.
    object: object?.['type'] === 'Identifier' ? (object['name'] as string) : undefined,
    field: property?.['type'] === 'Identifier' ? (property['name'] as string) : undefined,
    computed: member['computed'] === true,
    offset: typeof member['start'] === 'number' ? member['start'] : 0,
  };
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === '\n') line++;
  }
  return line;
}

type AstNode = Record<string, unknown>;

function astNode(value: unknown): AstNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function unwrapExpression(value: unknown): AstNode | undefined {
  let node = astNode(value);
  while (
    node &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'ParenthesizedExpression',
    ].includes(String(node.type))
  ) {
    node = astNode(node.expression);
  }
  return node;
}

function isSessionStoreReceiver(value: unknown, storeBindings: ReadonlySet<string>): boolean {
  const members = memberPath(value);
  return members !== undefined && storeBindings.has(members.at(-1)!);
}

function isSessionRecord(value: unknown, sessionBindings: ReadonlySet<string>): boolean {
  const node = unwrapExpression(value);
  return node?.type === 'Identifier'
    ? sessionBindings.has(String(node.name))
    : node?.type === 'MemberExpression' && memberName(node) === 'session';
}

function isSessionRead(value: unknown, storeBindings: ReadonlySet<string>): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (node.type === 'LogicalExpression') return isSessionRead(node.left, storeBindings);
  const callee = astNode(node.callee);
  return (
    node.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    ['get', 'requireCurrent', 'resolveCurrent'].includes(memberName(callee) ?? '') &&
    isSessionStoreReceiver(callee.object, storeBindings)
  );
}

function hasNamedType(node: AstNode, name: string): boolean {
  const annotation = astNode(astNode(node.typeAnnotation)?.typeAnnotation);
  return annotation?.type === 'TSTypeReference' && propertyName(annotation.typeName) === name;
}

function patchObjects(value: unknown): AstNode[] | undefined {
  const patch = unwrapExpression(value);
  if (!patch) return undefined;
  if (patch.type === 'ObjectExpression') return [patch];
  if (
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(String(patch.type)) ||
    patch.async === true
  )
    return undefined;
  const body = unwrapExpression(patch.body);
  if (body?.type === 'ObjectExpression') return [body];
  if (body?.type !== 'BlockStatement') return undefined;
  const returns: AstNode[] = [];
  visitAst(body, (node) => {
    if (node.type === 'ReturnStatement') returns.push(node);
  });
  if (returns.length !== 1 || !(body.body as AstNode[]).includes(returns[0]!)) return undefined;
  const result = unwrapExpression(returns[0]!.argument);
  return result?.type === 'ObjectExpression' ? [result] : undefined;
}

const SESSION_STATE_SCAN_ROOTS = ['src/daemon/', 'packages/capture-kit/src/capture-admission/'];
const SESSION_DRAFT_CONSTRUCTORS: Readonly<Record<string, string>> = {
  'src/daemon/session-lifecycle/internal/session-open-state.ts': 'publishOpenSession',
  'src/daemon/snapshot-session.ts': 'createSnapshotSession',
  'src/daemon/handlers/record-runtime.ts': 'createRecordOnlySession',
};

/** Assignments, named update keys and whole-record copies at the session ownership seam. */
export function findSessionStateWrites(
  sources: ReadonlyMap<string, string>,
  fields: readonly string[],
): SessionStateWrite[] {
  const declared = new Set(fields);
  const writes: SessionStateWrite[] = [];
  for (const [file, source] of sources) {
    if (!SESSION_STATE_SCAN_ROOTS.some((root) => file.startsWith(root))) continue;
    if (path.posix.basename(file) === 'session-store.ts') continue;
    const program = parseSync(file, source).program;
    const sessionBindings = new Set<string>();
    const storeBindings = new Set(['store', 'sessionStore']);
    const aliases: Array<readonly [string, unknown]> = [];
    const patches = new Set<AstNode>();
    const report = (node: AstNode, field: string): void => {
      writes.push({ file, line: lineOf(source, Number(node.start ?? 0)), field });
    };
    visitAst(program, (node) => {
      if (node.type === 'Identifier') {
        if (isSessionBinding(String(node.name)) || hasNamedType(node, 'SessionState'))
          sessionBindings.add(String(node.name));
        if (hasNamedType(node, 'SessionStore')) storeBindings.add(String(node.name));
      }
      if (node.type === 'VariableDeclarator') {
        const id = astNode(node.id);
        if (id?.type === 'Identifier') aliases.push([String(id.name), node.init]);
      }
      if (node.type === 'ObjectPattern') {
        for (const property of node.properties as AstNode[]) {
          if (property.type !== 'Property') continue;
          const field = propertyName(property.key);
          const value = astNode(property.value);
          const binding = value?.type === 'AssignmentPattern' ? astNode(value.left) : value;
          if (binding?.type !== 'Identifier') continue;
          if (field === 'session') sessionBindings.add(String(binding.name));
          if (field === 'store' || field === 'sessionStore')
            storeBindings.add(String(binding.name));
        }
      }
    });
    const inheritAliases = (): void => {
      let added: boolean;
      do {
        added = false;
        for (const [name, value] of aliases) {
          if (!storeBindings.has(name) && isSessionStoreReceiver(value, storeBindings)) {
            storeBindings.add(name);
            added = true;
          }
          if (
            !sessionBindings.has(name) &&
            (isSessionRecord(value, sessionBindings) || isSessionRead(value, storeBindings))
          ) {
            sessionBindings.add(name);
            added = true;
          }
        }
      } while (added);
    };
    inheritAliases();
    visitAst(program, (node) => {
      const callee = astNode(node.callee);
      const args = node.arguments as unknown[] | undefined;
      if (
        node.type !== 'CallExpression' ||
        callee?.type !== 'MemberExpression' ||
        memberName(callee) !== 'update' ||
        args?.length !== 2 ||
        !isSessionStoreReceiver(callee.object, storeBindings)
      )
        return;
      const patch = unwrapExpression(args[1]);
      const objects = patchObjects(args[1]);
      if (!objects) {
        report(patch ?? node, '[patch-shape]');
        return;
      }
      if (patch?.type !== 'ObjectExpression') {
        const binding = astNode((patch?.params as unknown[])?.[0]);
        if (binding?.type === 'Identifier') sessionBindings.add(String(binding.name));
        visitAst(patch?.body, (inner) => {
          const target = astNode(inner.callee);
          if (
            inner.type === 'CallExpression' &&
            target?.type === 'MemberExpression' &&
            isSessionStoreReceiver(target.object, storeBindings)
          )
            report(inner, '[reentrant-patch]');
        });
      }
      for (const object of objects) {
        patches.add(object);
        for (const property of object.properties as AstNode[]) {
          if (
            property.type !== 'Property' ||
            property.computed === true ||
            property.method === true ||
            property.kind !== 'init'
          )
            report(property, '[patch-shape]');
          else report(property, propertyName(property.key) ?? '[patch-shape]');
        }
      }
    });
    inheritAliases();
    const walk = (value: unknown, ancestors: readonly AstNode[]): void => {
      if (Array.isArray(value)) {
        for (const child of value) walk(child, ancestors);
        return;
      }
      const node = astNode(value);
      if (!node) return;
      const target = writeTarget(node);
      if (target?.object !== undefined && sessionBindings.has(target.object)) {
        if (target.computed) report(node, '[computed]');
        else if (target.field !== undefined && declared.has(target.field))
          report(node, target.field);
      }
      if (node.type === 'ObjectExpression' && !patches.has(node)) {
        const properties = node.properties as AstNode[];
        const copiesRecord = properties.some((property) => {
          if (property.type !== 'SpreadElement') return false;
          return isSessionRecord(property.argument, sessionBindings);
        });
        if (copiesRecord) {
          const enclosingFunction = [...ancestors]
            .reverse()
            .find((ancestor) =>
              ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
                String(ancestor.type),
              ),
            );
          const constructor = propertyName(enclosingFunction?.id);
          const parent = ancestors.at(-1);
          const publishedDraft = file.endsWith('/session-open-state.ts')
            ? parent?.type === 'CallExpression' &&
              memberName(astNode(parent.callee) ?? {}) === 'publish' &&
              (parent.arguments as unknown[])[1] === node
            : true;
          const draft = SESSION_DRAFT_CONSTRUCTORS[file];
          if (!draft || constructor !== draft || !publishedDraft) {
            report(node, '[whole-record-spread]');
            for (const property of properties) {
              const field = propertyName(property.key);
              if (property.type === 'Property' && declared.has(field ?? ''))
                report(property, field!);
            }
          }
        }
      }
      for (const child of Object.values(node)) walk(child, [...ancestors, node]);
    };
    walk(program, []);
  }
  return writes.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export type SessionStateWritePressure = Readonly<{
  /** Declared fields written by an owner through assignments, patches or record copies. */
  writerOwnedFields: number;
  /** Distinct (field, writing module) pairs — what `SESSION_STATE_FIELD_OWNERS` claims. */
  ownerFileClaims: number;
}>;

/**
 * R10 measures how many declared fields have a writer, and how many
 * module claims that takes. Read from the tree rather than from the ownership table, so the same
 * function measures a merge-base tree whose table is not in scope. On a tree R7 accepts, both
 * numbers equal the table's own size.
 */
export function sessionStateWritePressure(
  sources: ReadonlyMap<string, string>,
): SessionStateWritePressure {
  const declarationFile = sessionStateDeclarationFile(sources);
  if (!declarationFile) return { writerOwnedFields: 0, ownerFileClaims: 0 };
  const fields = sessionStateFields(sources.get(declarationFile)!);
  const declared = new Set(fields);
  const writes = findSessionStateWrites(sources, fields).filter((write) =>
    declared.has(write.field),
  );
  return {
    writerOwnedFields: new Set(writes.map((write) => write.field)).size,
    ownerFileClaims: new Set(writes.map((write) => `${write.field}\0${write.file}`)).size,
  };
}
