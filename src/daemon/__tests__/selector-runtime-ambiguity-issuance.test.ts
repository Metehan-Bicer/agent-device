import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { selectorCaptureFixture } from './selector-capture-fixture.ts';
import { refFrameScope, refFrameState } from '../ref-frame.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { dispatchIsViaRuntime } from '../selector-runtime.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeStaleRefSession,
  readPressPoint,
} from '../interaction/internal/__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../interaction/index.ts';

// #2870 review, the reviewer's pinned invariant: a response that prints
// candidate @refs must issue those refs on the frame they came from. The end-
// to-end sequence a user actually runs — an interactive snapshot activates a
// complete frame over the INTERACTIVE tree; an ambiguous `is` then prints
// candidates minted from its own full capture — must not leave the printed ref
// resolving against the earlier tree, where the same body names a different
// node. The candidate either acts on the listed node or is refused.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({ mockRunAppleRunnerCommand: vi.fn() }));

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

beforeEach(() => {
  resetGetRuntimeFixture();
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

function isRequest(session: string, positionals: readonly string[]): DaemonRequest {
  return { token: 't', session, command: 'is', positionals: [...positionals], flags: {} };
}

/**
 * The full capture `is` takes: two same-label buttons at distinctive points,
 * so the tap coordinates prove WHICH tree the retried candidate ref resolved
 * against. In the interactive frame seeded below, `e2` is a different button
 * at (10,20) — a positional coincidence of exactly the kind the review named.
 */
function ambiguousFullCapture() {
  return {
    nodes: attachRefs([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Deploy',
        rect: { x: 300, y: 300, width: 20, height: 20 },
        enabled: true,
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Deploy',
        rect: { x: 500, y: 500, width: 20, height: 20 },
        enabled: true,
        hittable: true,
      },
    ] as never),
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
  };
}

test('an ambiguous is issues its printed candidates so press acts on the listed node', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-ambiguity-issuance';
  // As if `snapshot -i` just returned: a complete active frame whose tree has
  // `e2` at (10,20) — the wrong node for the candidate body we are about to
  // copy out of the `is` refusal.
  const session = makeStaleRefSession(sessionName);
  session.device = IOS_SIMULATOR;
  sessionStore.publish(sessionName, session);

  const fixture = selectorCaptureFixture({ snapshot: () => ambiguousFullCapture() });
  const response = await dispatchIsViaRuntime({
    req: isRequest(sessionName, ['visible', 'label="Deploy"']),
    sessionName,
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(false);
  if (!response || response.ok) throw new Error('expected the ambiguity refusal');
  expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  const candidates = response.error.details?.candidates as string[];
  expect(candidates).toHaveLength(2);
  // The rule: the refusal is ref-issuing — candidates are pinned to the
  // generation that minted them, and the frame scope holds exactly them.
  const refsGeneration = response.error.details?.refsGeneration as number;
  expect(typeof refsGeneration).toBe('number');
  expect(refFrameState(session)).toBe('active');
  expect([...refFrameScope(session)].sort()).toEqual(['e2', 'e3']);

  // Copy the first printed candidate and press it. Pinned, it is admitted on
  // the frame the `is` refusal issued and resolves against THAT tree — the
  // listed button at (300,300), center (310,310) — not the interactive tree's
  // (10,20) button the same body named before.
  const pinned = candidates[0]!.replace(/\s.*$/, '') + `~s${refsGeneration}`;
  const press = await handleInteractionCommands({
    req: { token: 't', session: sessionName, command: 'press', positionals: [pinned], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  expect(press?.ok).toBe(true);
  expect(readPressPoint(mockTapPoint)).toEqual(['310', '310']);
});

test('a plain candidate ref from the ambiguity refusal is refused, not silently retargeted', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'is-ambiguity-plain-ref';
  const session = makeStaleRefSession(sessionName);
  session.device = IOS_SIMULATOR;
  sessionStore.publish(sessionName, session);

  const fixture = selectorCaptureFixture({ snapshot: () => ambiguousFullCapture() });
  const response = await dispatchIsViaRuntime({
    req: isRequest(sessionName, ['visible', 'label="Deploy"']),
    sessionName,
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  expect(response?.ok).toBe(false);
  if (!response || response.ok) throw new Error('expected the ambiguity refusal');

  // The partial frame authorizes exactly the issued bodies at its epoch; a
  // plain (unpinned) ref needs a complete frame and is refused with the
  // suggested pinned form rather than resolving positionally.
  const press = await handleInteractionCommands({
    req: { token: 't', session: sessionName, command: 'press', positionals: ['@e2'], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  expect(press?.ok).toBe(false);
  if (press && !press.ok) {
    expect(press.error.details?.reason).toBe('plain_ref_requires_complete_frame');
    expect(String(press.error.details?.hint)).toMatch(/Retry with the exact emitted ref/);
  }
  expect(mockTapPoint).not.toHaveBeenCalled();
});
