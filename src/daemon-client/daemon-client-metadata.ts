import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { stopDaemonProcess, type DaemonTerminationResult } from '../daemon-process.ts';

import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';

import {
  resolveDaemonPaths,
  type DaemonPaths,
  type DaemonServerMode,
} from '../daemon-resolution.ts';

export type DaemonInfo = {
  port?: number;
  httpPort?: number;
  transport?: DaemonServerMode;
  token: string;
  pid: number;
  version?: string;
  codeOrigin?: DaemonCodeOrigin;
  codeSignature?: string;
  processStartTime?: string;
  /** ADR 0029: digest of the daemon policy the daemon enforces; absent when it has none. */
  policyDigest?: string;
  baseUrl?: string;
  remoteInstanceId?: string;
  remoteUpstreamInstanceId?: string;
};

export type DaemonMetadataState = {
  hasInfo: boolean;
  hasLock: boolean;
};

const DAEMON_TAKEOVER_TERM_TIMEOUT_MS = 3000;
const DAEMON_TAKEOVER_KILL_TIMEOUT_MS = 1000;

export function readDaemonInfo(infoPath: string): DaemonInfo | null {
  const data = readJsonFile(infoPath);
  if (!data || typeof data !== 'object') return null;
  const parsed = data as Partial<DaemonInfo>;
  const token = readRequiredDaemonToken(parsed);
  if (!token) return null;
  const ports = readDaemonInfoPorts(parsed);
  if (!ports) return null;
  return {
    token,
    ...ports,
    transport: readDaemonInfoTransport(parsed.transport),
    pid: readPositiveInteger(parsed.pid) ?? 0,
    version: readOptionalString(parsed.version),
    codeOrigin: readDaemonInfoCodeOrigin(parsed.codeOrigin),
    codeSignature: readOptionalString(parsed.codeSignature),
    processStartTime: readOptionalString(parsed.processStartTime),
    policyDigest: readOptionalString(parsed.policyDigest),
  };
}

function readRequiredDaemonToken(parsed: Partial<DaemonInfo>): string | null {
  return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
}

function readDaemonInfoPorts(
  parsed: Partial<DaemonInfo>,
): Pick<DaemonInfo, 'port' | 'httpPort'> | null {
  const port = readPositiveInteger(parsed.port);
  const httpPort = readPositiveInteger(parsed.httpPort);
  if (port === undefined && httpPort === undefined) return null;
  return { port, httpPort };
}

function readDaemonInfoCodeOrigin(value: unknown): DaemonInfo['codeOrigin'] {
  return value === 'installed' || value === 'checkout' ? value : undefined;
}

function readDaemonInfoTransport(value: unknown): DaemonInfo['transport'] {
  return value === 'socket' || value === 'http' || value === 'dual' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

export function removeDaemonInfo(infoPath: string): void {
  removeFileIfExists(infoPath);
}

export function removeDaemonLock(lockPath: string): void {
  removeFileIfExists(lockPath);
}

export function getDaemonMetadataState(paths: DaemonPaths): DaemonMetadataState {
  return {
    hasInfo: fs.existsSync(paths.infoPath),
    hasLock: fs.existsSync(paths.lockPath),
  };
}

export async function stopDaemonProcessForTakeover(
  info: DaemonInfo,
): Promise<DaemonTerminationResult> {
  const termination = await stopDaemonProcess(
    { pid: info.pid, startTime: info.processStartTime ?? null },
    {
      mode: 'graceful',
      termTimeoutMs: DAEMON_TAKEOVER_TERM_TIMEOUT_MS,
      killTimeoutMs: DAEMON_TAKEOVER_KILL_TIMEOUT_MS,
    },
  );
  requireDaemonExit(termination);
  return termination;
}

function requireDaemonExit(termination: DaemonTerminationResult): void {
  if (termination.status !== 'retained') return;
  throw new AppError('COMMAND_FAILED', 'Daemon exit could not be confirmed.', {
    reason: 'daemon_exit_unconfirmed',
    termination,
  });
}

export function isRemoteDaemon(info: DaemonInfo): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}

export function resolveDaemonStartupHint(
  state: { hasInfo: boolean; hasLock: boolean },
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'> = resolveDaemonPaths(
    process.env.AGENT_DEVICE_STATE_DIR,
  ),
): string {
  const artifacts = [state.hasInfo ? paths.infoPath : null, state.hasLock ? paths.lockPath : null]
    .filter(Boolean)
    .join(' and ');
  return `Daemon startup did not establish a reachable owner. ${artifacts ? `State was retained at ${artifacts}. ` : ''}Retry with --debug and inspect daemon diagnostics. Before upgrading, stop all older clients and daemons with their original CLI and prevent them from returning to this state directory. Unverified lock state requires confirming every user stopped before manual recovery; deleting metadata alone is not a safe reset.`;
}

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
