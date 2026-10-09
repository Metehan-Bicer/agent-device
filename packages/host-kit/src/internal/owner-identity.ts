import fs from 'node:fs';
import {
  isProcessAlive,
  isProcessZombie,
  readHostProcessIdentityObservations,
  readProcessStartTime,
  type HostProcessIdentityObservation,
} from './host-process.ts';

export type OwnerIdentity = {
  pid: number;
  startTime: string | null;
};

/** A process id accepted by Node's native signal API. */
export function isProcessPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fff_ffff;
}

export type OwnerLiveness =
  | 'live'
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone'
  | 'unknown';

export function readCurrentOwnerIdentity(): OwnerIdentity {
  return { pid: process.pid, startTime: readProcessStartTime(process.pid) };
}

export function ownerIdentityMatches(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

/**
 * Positive proof that two records name DIFFERENT processes. Deliberately not
 * the negation of {@link ownerIdentityMatches}: equal pids with an unreadable
 * start time on either side are unproven rather than different, so a caller
 * that acts on this can never mistake one owner for two and hand its resource
 * away.
 */
export function ownerIdentityDiffers(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  if (left.pid !== right.pid) return true;
  return Boolean(left.startTime && right.startTime && left.startTime !== right.startTime);
}

/**
 * This is deliberately proof-oriented, in both directions. A filesystem read
 * error is not proof that an owner state directory disappeared, so callers
 * must surface it as an unknown owner rather than treating the resource as
 * free. Likewise a failed `ps` read (it shells out with a short timeout and
 * loses under CPU contention) is not proof the owner died, so it never
 * condemns a pid that kill(pid, 0) says is alive. Death is only concluded
 * from positive evidence: the pid is gone or the process is a zombie (already
 * terminated, merely unreaped). A different readable start time proves PID
 * reuse, but remains a distinct result so each ownership policy must decide
 * explicitly whether that proof permits recovery. An unreadable start time is
 * not proof of reuse. An owner recorded without a start time stays fail-closed
 * while its pid is alive: there is no same-clock-domain proof of birth order (wall-clock
 * arithmetic over `ps etime` shifts under clock steps), and misreading a live
 * owner as recycled would let a waiter steal a held resource.
 */
export function classifyOwnerLiveness(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
}): OwnerLiveness {
  // One process-table snapshot answers the whole judgment. State and start time
  // read as two probes double the cost of every lock-ownership poll on hosts
  // where a probe starts a fresh process tool, and one snapshot also judges both
  // facts at the same instant instead of stitching two separate host answers.
  const guarded = guardOwnerPid(params.owner);
  if (guarded) return guarded;
  const observation =
    readHostProcessIdentityObservations([params.owner.pid]).get(params.owner.pid) ?? null;
  return classifyLiveOwnerFromObservation(params, observation);
}

export function classifyOwnerLivenessFromObservation(
  params: {
    owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
    stateDir?: string;
  },
  observation?: HostProcessIdentityObservation | null,
): OwnerLiveness {
  // The snapshot was taken before this call, so the guards run again here: a
  // claim whose owner died between snapshot and judgment must read dead.
  const guarded = guardOwnerPid(params.owner);
  if (guarded) return guarded;
  return classifyLiveOwnerFromObservation(params, observation);
}

/** The verdicts provable from the pid alone; undefined means the caller may probe on. */
function guardOwnerPid(owner: Pick<OwnerIdentity, 'pid' | 'startTime'>): OwnerLiveness | undefined {
  if (!isProcessPid(owner.pid)) return 'unknown';
  if (!isProcessAlive(owner.pid)) return 'owner-process-dead';
  return undefined;
}

/** Judges an owner the caller has established as a live, valid pid; probes no liveness. */
function classifyLiveOwnerFromObservation(
  params: {
    owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
    stateDir?: string;
  },
  observation?: HostProcessIdentityObservation | null,
): OwnerLiveness {
  const { owner, stateDir } = params;
  if (observation !== undefined ? observation?.state.startsWith('Z') : isProcessZombie(owner.pid)) {
    return 'owner-process-dead';
  }
  if (owner.startTime) {
    const currentStartTime =
      observation !== undefined
        ? (observation?.startTime ?? null)
        : readProcessStartTime(owner.pid);
    if (currentStartTime !== null && currentStartTime !== owner.startTime) {
      return 'owner-process-reused';
    }
  }
  return stateDir ? classifyOwnerStateDirectory(stateDir) : 'live';
}

function classifyOwnerStateDirectory(stateDir: string): OwnerLiveness {
  try {
    fs.statSync(stateDir);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'owner-state-dir-gone';
    return 'unknown';
  }
}
