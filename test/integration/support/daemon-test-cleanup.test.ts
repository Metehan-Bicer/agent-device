import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import {
  isProcessAlive,
  readHostProcessIdentityObservations,
} from '@agent-device/host-kit/process';
import { cleanupDaemonTestState } from './daemon-test-cleanup.ts';
import { resolveDaemonPaths } from '../../../src/daemon-resolution.ts';
import { stopDaemonProcess } from '../../../src/daemon-process.ts';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from '../../../src/__tests__/test-utils/registered-daemon-fixture.ts';

const fields = {
  httpPort: 4210,
  token: 'fixture',
  version: 'test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'fixture',
};

test.each(['string', 'out-of-range'])(
  'malformed %s registration retains the directory and live daemon',
  async (kind) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-invalid-registration-'));
    const child = spawnRegisteredDaemonFixture(paths, fields, undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const info = await waitForRegisteredDaemonFixture(paths, child);
      const malformed = JSON.stringify({
        ...info,
        pid: kind === 'string' ? String(info.pid) : 2_147_483_648,
      });
      fs.writeFileSync(paths.infoPath, malformed);
      await cleanupDaemonTestState(paths.baseDir, null);
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), malformed);
      assert.equal(isProcessAlive(child.pid), true);
      assert.equal(warnings.mock.calls.length, 1);
    } finally {
      warnings.mockRestore();
      await finishRegisteredDaemonFixture(paths.baseDir);
    }
  },
);

test('cleanup stops the registered replacement when its observation still names the exited original', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-replaced-registration-'));
  const original = spawnRegisteredDaemonFixture(paths, fields, undefined);
  try {
    const observed = await waitForRegisteredDaemonFixture(paths, original);
    const stopped = await stopDaemonProcess(
      { pid: original.pid, startTime: observed.processStartTime ?? null },
      { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 1_000 },
    );
    assert.equal(stopped.status, 'exited');
    await original.exited;
    const replacement = spawnRegisteredDaemonFixture(paths, fields, undefined);
    await waitForRegisteredDaemonFixture(paths, replacement);
    await cleanupDaemonTestState(paths.baseDir, observed);
    assert.ok(
      !isProcessAlive(replacement.pid) ||
        readHostProcessIdentityObservations([replacement.pid])
          .get(replacement.pid)
          ?.state.startsWith('Z'),
      'the registered replacement must be dead before cleanup returns',
    );
    await replacement.exited;
    assert.equal(isProcessAlive(replacement.pid), false);
    assert.equal(fs.existsSync(paths.baseDir), false);
  } finally {
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});
