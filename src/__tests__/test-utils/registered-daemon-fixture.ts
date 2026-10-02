import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { stopDaemonProcess } from '../../daemon-process.ts';
import type { DaemonPaths } from '../../daemon-resolution.ts';
import type { DaemonRegistrationFields } from '../../daemon-registration-owner.ts';

const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const children = new Map<
  string,
  { launch: ReturnType<typeof runCmdDetachedMonitored>; startTime: string | null }
>();

/** A real registration owner, advertising the caller's HTTP fixture and joining before deletion. */
export function registeredDaemonFixtureArgs(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
): string[] {
  const entry = path.join(paths.baseDir, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'package.json'), '{"type":"module"}');
  const registrationUrl = new URL('../../daemon-registration-owner.ts', import.meta.url).href;
  fs.writeFileSync(
    entry,
    `import fs from 'node:fs';
import path from 'node:path';
import { tryAcquireDaemonRegistration } from ${JSON.stringify(registrationUrl)};
const paths = ${JSON.stringify(paths)};
const acquired = await tryAcquireDaemonRegistration(paths);
if (acquired.status !== 'acquired') process.exit(75);
process.on('SIGTERM', async () => {
  const deferred = path.join(paths.baseDir, 'repair-on-shutdown.json');
  if (fs.existsSync(deferred)) {
    const dir = path.join(paths.sessionsDir, 'default');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(deferred, path.join(dir, 'repair-tombstone.json'));
  }
  await acquired.owner.finish();
  process.exit(0);
});
acquired.owner.publish(${JSON.stringify(fields)});
setInterval(() => {}, 1000);
`,
  );
  return ['--experimental-strip-types', entry];
}

export function spawnRegisteredDaemonFixture(
  paths: DaemonPaths,
  fields: DaemonRegistrationFields,
  options: Parameters<typeof runCmdDetachedMonitored>[2],
): ReturnType<typeof runCmdDetachedMonitored> {
  const child = actualCommand.runCmdDetachedMonitored(
    process.execPath,
    registeredDaemonFixtureArgs(paths, fields),
    options,
  );
  children.set(paths.baseDir, { launch: child, startTime: readProcessStartTime(child.pid) });
  return child;
}

export async function finishRegisteredDaemonFixture(stateDir: string): Promise<void> {
  const owned = children.get(stateDir);
  if (owned) {
    const child = owned.launch;
    const termination = await stopDaemonProcess(
      { pid: child.pid, startTime: owned.startTime },
      { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 2_000 },
    );
    assert.notEqual(termination.status, 'retained', JSON.stringify(termination));
    await child.exited;
    children.delete(stateDir);
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
}

export async function finishRegisteredDaemonFixtures(): Promise<void> {
  for (const stateDir of children.keys()) await finishRegisteredDaemonFixture(stateDir);
}
