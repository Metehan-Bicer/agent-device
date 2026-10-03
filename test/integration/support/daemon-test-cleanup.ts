import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { stopDaemonProcess } from '../../../src/daemon-process.ts';
import {
  readRegisteredDaemonIdentity,
  readRegisteredDaemonOwnership,
} from '../../../src/daemon-registration.ts';
import { ownerIdentityMatches, type OwnerIdentity } from '@agent-device/host-kit/process';

type TestDaemonIdentity = { pid: number; processStartTime?: string };

/** Best-effort cleanup keeps primary test failures and unconfirmed daemon state. */
export async function cleanupDaemonTestState(
  stateDir: string,
  observed: TestDaemonIdentity | null,
): Promise<void> {
  try {
    const identities = [
      observed ? { pid: observed.pid, startTime: observed.processStartTime ?? null } : null,
      readIdentity(stateDir),
    ].filter((identity): identity is OwnerIdentity => identity !== null);
    if (identities.length === 0) throw new Error('No daemon lifetime was observed');
    for (const identity of identities) {
      const termination = await stopDaemonProcess(identity, {
        mode: 'graceful',
        termTimeoutMs: 1_500,
        killTimeoutMs: 1_500,
      });
      if (termination.status !== 'exited') {
        console.warn('Daemon test cleanup retained state:', stateDir, termination);
        return;
      }
    }
    const current = readIdentity(stateDir);
    if (current && !identities.some((identity) => ownerIdentityMatches(identity, current)))
      throw new Error('Daemon registration changed during test cleanup');
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('Daemon test cleanup retained state:', stateDir, normalizeError(error));
  }
}

function readIdentity(stateDir: string): OwnerIdentity | null {
  const infoPath = path.join(stateDir, 'daemon.json');
  if (readRegisteredDaemonOwnership(infoPath, null).state === 'absent') return null;
  const identity = readRegisteredDaemonIdentity(infoPath);
  if (!identity) throw new Error('Daemon registration identity is invalid or unreadable');
  return identity;
}
