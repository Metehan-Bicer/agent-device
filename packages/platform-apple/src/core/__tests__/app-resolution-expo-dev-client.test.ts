import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosSimulatorExpoDevClientScheme } from '../app-resolution.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const DEV_CLIENT_BUNDLE_ID = 'com.example.devclient';

type InstalledApps = Readonly<{
  listing: Record<string, unknown>;
  appPaths: Map<string, string>;
  schemesByPlist: Map<string, string[]>;
}>;

async function installApps(apps: Record<string, string[]>): Promise<InstalledApps> {
  const root = await mkdtempForTest('expo-dev-client-schemes-');
  const listing: Record<string, unknown> = {};
  const appPaths = new Map<string, string>();
  const schemesByPlist = new Map<string, string[]>();
  for (const [bundleId, schemes] of Object.entries(apps)) {
    const appPath = path.join(root, `${bundleId}.app`);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'Info.plist'), '');
    listing[bundleId] = { ApplicationType: 'User', CFBundleDisplayName: bundleId, Path: appPath };
    appPaths.set(bundleId, appPath);
    schemesByPlist.set(path.join(appPath, 'Info.plist'), schemes);
  }
  return { listing, appPaths, schemesByPlist };
}

function answerContainer(installed: InstalledApps, bundleId: string | undefined, fails: boolean) {
  const appPath = bundleId === undefined ? undefined : installed.appPaths.get(bundleId);
  if (fails || appPath === undefined) return { exitCode: 2, stderr: 'no app' };
  return `${appPath}\n`;
}

function answerSchemes(installed: InstalledApps, plistPath: string | undefined): string {
  const schemes = installed.schemesByPlist.get(plistPath ?? '') ?? [];
  return JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }] });
}

/** Installs each app with the given URL schemes and answers the simctl/plutil probes for them. */
async function createInstalledApps(
  apps: Record<string, string[]>,
  options: { containerFails?: boolean } = {},
): Promise<(args: string[]) => FakeAppleToolResponse> {
  const installed = await installApps(apps);
  return (args) => {
    const [tool, command] = args;
    if (tool === 'simctl' && command === 'listapps') return JSON.stringify(installed.listing);
    if (tool === 'simctl' && command === 'get_app_container') {
      return answerContainer(installed, args[3], options.containerFails === true);
    }
    if (tool === 'plutil' && command === '-convert') return answerSchemes(installed, args[5]);
    return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
  };
}

test('an expo-dev-client resolves to its exp+ scheme when it is the scheme’s only owner', async () => {
  const tool = await createInstalledApps({
    [DEV_CLIENT_BUNDLE_ID]: ['devclient', 'com.example.devclient', 'exp+dev-slug'],
    'com.example.other': ['other'],
  });

  await withFakeAppleTool(tool, async () => {
    assert.equal(
      await resolveIosSimulatorExpoDevClientScheme(IOS_TEST_SIMULATOR, DEV_CLIENT_BUNDLE_ID),
      'exp+dev-slug',
    );
  });
});

test.each([
  ['a bare React Native app', { [DEV_CLIENT_BUNDLE_ID]: ['devclient'] }],
  ['an app with two exp+ schemes', { [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug', 'exp+other-slug'] }],
  [
    'a scheme another installed variant also owns',
    {
      [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug'],
      'com.example.devclient.preview': ['exp+dev-slug'],
    },
  ],
  ['a bare exp+ prefix', { [DEV_CLIENT_BUNDLE_ID]: ['exp+'] }],
])('%s has no dev-client scheme', async (_name, apps) => {
  const tool = await createInstalledApps(apps);

  await withFakeAppleTool(tool, async () => {
    assert.equal(
      await resolveIosSimulatorExpoDevClientScheme(IOS_TEST_SIMULATOR, DEV_CLIENT_BUNDLE_ID),
      undefined,
    );
  });
});

test('an app the simulator cannot locate has no dev-client scheme', async () => {
  const tool = await createInstalledApps(
    { [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug'] },
    { containerFails: true },
  );

  await withFakeAppleTool(tool, async () => {
    assert.equal(
      await resolveIosSimulatorExpoDevClientScheme(IOS_TEST_SIMULATOR, DEV_CLIENT_BUNDLE_ID),
      undefined,
    );
  });
});

test('a physical device is never probed', async () => {
  const physical: DeviceInfo = { ...IOS_TEST_SIMULATOR, kind: 'device' };

  await withFakeAppleTool(
    () => ({ stderr: 'must not run', exitCode: 1 }),
    async ({ calls }) => {
      assert.equal(
        await resolveIosSimulatorExpoDevClientScheme(physical, DEV_CLIENT_BUNDLE_ID),
        undefined,
      );
      assert.deepEqual(calls, []);
    },
  );
});
