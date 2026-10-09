import { beforeEach, expect, test, vi } from 'vitest';

import { alertNotFound } from './launch-confirmation.fixtures.ts';
import { launchUrlSimulator, openInput, resetUrlOwner } from './lifecycle.fixtures.ts';

vi.mock('./core/app-resolution.ts', async () => {
  const fixtures = await import('./lifecycle.fixtures.ts');
  return {
    resolveIosSimulatorDeepLinkBundleId: async () => await fixtures.urlOwner.resolve(),
  };
});

const devClientLaunch = vi.hoisted(() => ({ url: undefined as string | undefined, probes: 0 }));
vi.mock('./expo-dev-client-launch.ts', () => ({
  resolveExpoDevClientLaunchUrl: async () => {
    devClientLaunch.probes += 1;
    return devClientLaunch.url;
  },
}));

beforeEach(() => {
  resetUrlOwner();
  devClientLaunch.url = undefined;
  devClientLaunch.probes = 0;
});

const DEV_CLIENT_URL = 'exp+dev-slug://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8085';

/** A Simulator open that asks to point the app at Metro, without an explicit launch URL. */
function metroHintedOpen() {
  const applyRuntimeHints = vi.fn(async () => {});
  return {
    applyRuntimeHints,
    input: {
      ...openInput(),
      runtimeHints: { metroHost: '127.0.0.1', metroPort: '8085' },
      applyRuntimeHints,
      execution: { plannedOperations: ['captureSnapshot'] as const },
    },
  };
}

function simulatorWithoutPrompt() {
  return launchUrlSimulator(async () => {
    throw alertNotFound();
  });
}

test('an expo-dev-client is launched through its dev-client URL instead of a plain launch (#1245)', async () => {
  devClientLaunch.url = DEV_CLIENT_URL;
  const { lifecycle, events } = simulatorWithoutPrompt();
  const { input, applyRuntimeHints } = metroHintedOpen();

  await lifecycle.openApplication(input);

  expect(applyRuntimeHints).toHaveBeenCalledOnce();
  expect(events).toContain(`open ${DEV_CLIENT_URL}`);
  expect(events).not.toContain('open');
});

test('a bare React Native app keeps the plain launch after its Metro hints are written', async () => {
  const { lifecycle, events } = simulatorWithoutPrompt();
  const { input, applyRuntimeHints } = metroHintedOpen();

  await lifecycle.openApplication(input);

  expect(devClientLaunch.probes).toBe(1);
  expect(applyRuntimeHints).toHaveBeenCalledOnce();
  expect(events).toContain('open');
  expect(events.filter((event) => event.startsWith('open exp+'))).toEqual([]);
});

test('an open without Metro hints never probes for an expo-dev-client', async () => {
  devClientLaunch.url = DEV_CLIENT_URL;
  const { lifecycle, events } = simulatorWithoutPrompt();

  await lifecycle.openApplication({
    ...openInput(),
    execution: { plannedOperations: ['captureSnapshot'] },
  });

  expect(devClientLaunch.probes).toBe(0);
  expect(events).toContain('open');
});
