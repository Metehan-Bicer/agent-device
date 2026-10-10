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
  listing: Record<string, { ApplicationType: string; CFBundleDisplayName: string; Path: string }>;
  schemesByPlist: Map<string, string[]>;
}>;

async function installApps(apps: Record<string, string[]>): Promise<InstalledApps> {
  const root = await mkdtempForTest('expo-dev-client-schemes-');
  const listing: InstalledApps['listing'] = {};
  const schemesByPlist = new Map<string, string[]>();
  for (const [bundleId, schemes] of Object.entries(apps)) {
    const appPath = path.join(root, `${bundleId}.app`);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'Info.plist'), '');
    listing[bundleId] = { ApplicationType: 'User', CFBundleDisplayName: bundleId, Path: appPath };
    schemesByPlist.set(path.join(appPath, 'Info.plist'), schemes);
  }
  return { listing, schemesByPlist };
}

function answerSchemes(installed: InstalledApps, plistPath: string | undefined): string {
  const schemes = installed.schemesByPlist.get(plistPath ?? '') ?? [];
  return JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }] });
}

function answerContainer(installed: InstalledApps, bundleId: string | undefined, fails: boolean) {
  const appPath = installed.listing[bundleId ?? '']?.Path;
  return fails || !appPath ? { exitCode: 2, stderr: 'no app' } : `${appPath}\n`;
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

test.each<[string, Record<string, string[]>, string | undefined, boolean?]>([
  [
    'a uniquely owned dev-client scheme',
    {
      [DEV_CLIENT_BUNDLE_ID]: ['devclient', 'com.example.devclient', 'exp+dev-slug'],
      'com.example.other': ['other'],
    },
    'exp+dev-slug',
  ],
  ['a bare React Native app', { [DEV_CLIENT_BUNDLE_ID]: ['devclient'] }, undefined],
  ['two exp+ schemes', { [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug', 'exp+other-slug'] }, undefined],
  [
    'a scheme shared with another installed variant',
    {
      [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug'],
      'com.example.devclient.preview': ['exp+dev-slug'],
    },
    undefined,
  ],
  ['a bare exp+ prefix', { [DEV_CLIENT_BUNDLE_ID]: ['exp+'] }, undefined],
  [
    'an app the simulator cannot locate',
    { [DEV_CLIENT_BUNDLE_ID]: ['exp+dev-slug'] },
    undefined,
    true,
  ],
])('%s resolves only when unambiguous', async (_name, apps, expected, containerFails = false) => {
  const tool = await createInstalledApps(apps, { containerFails });

  await withFakeAppleTool(tool, async () => {
    assert.equal(
      await resolveIosSimulatorExpoDevClientScheme(IOS_TEST_SIMULATOR, DEV_CLIENT_BUNDLE_ID),
      expected,
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
