import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
/**
 * #3260: `fill --text-stdin` keeps the value out of argv, so it must not come back on the
 * response either. Sent through the real request handler to a web session, the narrowest
 * runtime that still runs the full fill admission, dispatch and response projection.
 */
import { expect, test } from 'vitest';
import path from 'node:path';
import type { WebProvider } from '@agent-device/platform-web';
import type { SessionState } from '../session-state.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeAuthoringSession, makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  createPlatformRuntimeGateway,
  createRequestPlatformProviders,
} from '../../platform-runtime.ts';

const SECRET = 'stdin-s3cret-value';

function fillWithStdinText(
  session: SessionState,
  flags: Record<string, unknown> = {},
  fillFails?: (text: string) => Error,
) {
  const sessionStore = makeSessionStore('agent-device-router-fill-text-stdin-');
  sessionStore.publish(session.name, session);
  const typed: string[] = [];
  const webProvider: WebProvider = {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async (_x, _y, text) => {
      typed.push(text);
      if (fillFails) throw fillFails(text);
    },
    typeText: async () => {},
    scroll: async () => {},
  };
  const dir = mkdtempForTestSync('agent-device-router-fill-text-stdin-runtime-');
  const handler = createRequestHandler({
    logPath: path.join(dir, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    requestPlatformProviders: createRequestPlatformProviders({
      providers: { webProvider: () => webProvider },
    }),
    deviceRuntimeGateway: createPlatformRuntimeGateway({
      sessionsDir: dir,
      resolveSessionArtifacts: (sessionId) => ({
        outputPath: path.join(dir, sessionId, 'app.log'),
        pidPath: path.join(dir, sessionId, 'app-log.pid'),
      }),
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const response = handler({
    token: 'test-token',
    session: session.name,
    command: 'fill',
    positionals: ['10', '20', SECRET],
    flags: { textStdin: true, ...flags },
    meta: { requestId: 'req-fill-text-stdin' },
  });
  return { response, typed, sessionStore };
}

test('an unrecorded --text-stdin fill types the value but returns no part of it', async () => {
  const { response, typed } = fillWithStdinText(makeSession('web', { device: WEB_DESKTOP_DEVICE }));

  const result = await response;
  expect(result.ok).toBe(true);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (result.ok) expect(result.data?.text).toBe('[REDACTED]');
});

test('an armed --text-stdin --no-record fill returns no part of the value and records nothing', async () => {
  const session = makeAuthoringSession('web', { device: WEB_DESKTOP_DEVICE });
  const { response, typed, sessionStore } = fillWithStdinText(session, { noRecord: true });

  const result = await response;
  expect(result.ok).toBe(true);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (result.ok) expect(result.data?.text).toBe('[REDACTED]');
  expect(sessionStore.get('web')?.actions).toEqual([]);
});

test('an armed --text-stdin fill without --record-as or --no-record is refused before typing', async () => {
  const session = makeAuthoringSession('web', { device: WEB_DESKTOP_DEVICE });
  const { response, typed } = fillWithStdinText(session);

  const result = await response;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('INVALID_ARGS');
  expect(result.error.details?.reason).toBe('fill_text_stdin_unparameterized_recording');
  expect(typed).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test.each([
  ['recordAs', { textStdin: undefined, recordAs: 42 }, '--record-as'],
  ['textStdin', { textStdin: 'true' }, '--text-stdin'],
])(
  'a fill whose %s marker has the wrong type is refused before typing',
  async (_name, flags, flagName) => {
    const { response, typed } = fillWithStdinText(
      makeSession('web', { device: WEB_DESKTOP_DEVICE }),
      flags,
    );

    const result = await response;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain(flagName);
    expect(typed).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  },
);

test('a backend error that echoes the --text-stdin value does not return it', async () => {
  const { response, typed } = fillWithStdinText(
    makeSession('web', { device: WEB_DESKTOP_DEVICE }),
    {},
    (text) => new Error(`could not type "${text}" into the field`),
  );

  const result = await response;
  expect(result.ok).toBe(false);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (!result.ok) expect(result.error.message).toBe('could not type "[REDACTED]" into the field');
});
