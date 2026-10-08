import type { ExecOptions, ExecResult } from './exec.ts';
import { runCmd, runCmdSync } from './exec.ts';
import { sleep } from './retry.ts';

const PS_TIMEOUT_MS = 1_000;
const HOST_PS_COMMAND = process.platform === 'win32' ? 'ps' : '/bin/ps';
// PowerShell pays a fixed startup cost before the CIM query even runs, so every
// Windows process-table read gets at least this budget instead of the `ps` one.
const WINDOWS_PS_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_TOOL = 'powershell.exe';

export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

export type HostProcessIdentityObservation = Readonly<{
  state: string;
  startTime: string;
}>;

/**
 * What the host says about one pid when a caller is about to signal it. Each field is `null`
 * when the host did not answer, which is unknown evidence rather than absence: only a `ps`
 * that names a different process proves the pid changed hands. `zombie` is `null` together
 * with an unreadable process state, since a zombie passes `kill(pid, 0)` and still reports
 * its original start time, so nothing else exposes that it already terminated.
 */
export type HostProcessIdentityFacts = Readonly<{
  startTime: string | null;
  command: string | null;
  zombie: boolean | null;
}>;

type HostProcessRunCommand = (
  cmd: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export function hostEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}

export function readHostEnvironmentVariable(name: string): string | undefined {
  return hostEnvironment()[name];
}

export function writeHostStderr(value: string): void {
  process.stderr.write(value);
}

export function hostCurrentWorkingDirectory(): string {
  return process.cwd();
}

export function hostNodeExecutablePath(): string {
  return process.execPath;
}

export function hostNodeVersion(): string {
  return process.version;
}

export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function hostProcessId(): number {
  return process.pid;
}

export type ListHostProcessesOptions = {
  timeoutMs: number;
  runCommand?: HostProcessRunCommand;
};

export type StopPidsWithEscalationOptions = {
  pids: readonly number[];
  termTimeoutMs: number;
  killTimeoutMs: number;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads who owns a pid, off the event loop, with a budget the caller names. The three fields
 * are read concurrently so a loaded host pays one budget for the set rather than one per
 * field; on Windows one CIM query answers the whole set. Use this rather than the synchronous
 * probes when the answer decides whether a process is signaled: waiting is reversible and
 * signaling the wrong process is not.
 */
export async function readProcessIdentityFacts(
  pid: number,
  timeoutMs = PS_TIMEOUT_MS,
): Promise<HostProcessIdentityFacts> {
  if (isWindowsHostPlatform()) {
    return await readWindowsProcessIdentityFacts(pid, timeoutMs);
  }
  const [startTime, command, state] = await Promise.all([
    readProcessFieldAsync(pid, 'lstart=', timeoutMs),
    readProcessFieldAsync(pid, 'command=', timeoutMs),
    readProcessFieldAsync(pid, 'state=', timeoutMs),
  ]);
  return { startTime, command, zombie: state === null ? null : state.startsWith('Z') };
}

export function readProcessStartTime(pid: number): string | null {
  return readProcessField(pid, 'lstart=');
}

export function readProcessCommand(pid: number): string | null {
  return readProcessField(pid, 'command=');
}

// A terminated Windows process leaves the CIM table rather than lingering in it
// unreaped, so no live pid on that host can be a zombie: the question is answered
// without a process-table probe, and exit proof stays liveness-and-lifetime.
export function isProcessZombie(pid: number): boolean {
  if (isWindowsHostPlatform()) return false;
  return readProcessField(pid, 'state=')?.startsWith('Z') ?? false;
}

export function readHostProcessIdentityObservations(
  pids: Iterable<number>,
): ReadonlyMap<number, HostProcessIdentityObservation> {
  const observations = new Map<number, HostProcessIdentityObservation>();
  const selected = uniquePositivePids(pids);
  if (selected.length === 0) return observations;
  if (isWindowsHostPlatform()) {
    for (const row of readWindowsProcessRows(selected, WINDOWS_PS_TIMEOUT_MS)) {
      if (row.startTime === null) continue;
      // A live row is never a zombie: a terminated Windows process leaves the
      // CIM table, it does not linger in it unreaped, so no row state exposes
      // one. Exit proof stays liveness-and-lifetime, as on every other platform.
      observations.set(row.pid, { state: 'R', startTime: row.startTime });
    }
    return observations;
  }
  try {
    const result = runCmdSync('ps', ['-p', selected.join(','), '-o', 'pid=,state=,lstart='], {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return observations;
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      observations.set(pid, { state: match[2]!, startTime: match[3]! });
    }
  } catch {
    // A failed ps snapshot is unknown evidence; callers remain fail-closed.
  }
  return observations;
}

type HostProcessField = 'lstart=' | 'command=' | 'state=';

function readProcessField(pid: number, field: HostProcessField): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindowsHostPlatform()) return readWindowsProcessField(pid, field);
  try {
    const result = runCmdSync(HOST_PS_COMMAND, ['-p', String(pid), '-o', field], {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    return processFieldValue(result);
  } catch {
    return null;
  }
}

async function readProcessFieldAsync(
  pid: number,
  field: HostProcessField,
  timeoutMs: number,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = await runCmd(HOST_PS_COMMAND, ['-p', String(pid), '-o', field], {
      allowFailure: true,
      timeoutMs,
    });
    return processFieldValue(result);
  } catch {
    return null;
  }
}

function processFieldValue(result: ExecResult): string | null {
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

export function parseHostProcessList(stdout: string): HostProcessInfo[] {
  const processes: HostProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const command = match[3]!;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({ pid, ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : undefined, command });
  }
  return processes;
}

/* -------------------------------------------------------------------------- */
/* Windows process-identity branch (#3291)                                     */
/*                                                                             */
/* Windows hosts have no `ps`. The same identity facts come from one           */
/* CIM (`Win32_Process`) query through PowerShell: `CreationDate` is the       */
/* birth time proven against PID reuse, `CommandLine` is the command the       */
/* daemon-identity patterns match, and a terminated process leaves the table   */
/* entirely instead of lingering as a zombie, so a live row is never `Z`.      */
/* A failed or unanswered query is unknown evidence, exactly like a failed     */
/* `ps`, and every caller stays fail-closed on it.                             */
/* -------------------------------------------------------------------------- */

type WindowsProcessRow = Readonly<{
  pid: number;
  ppid?: number;
  startTime: string | null;
  command: string | null;
}>;

function isWindowsHostPlatform(): boolean {
  return hostPlatform() === 'win32';
}

// Rows are `pid|ppid|creation|command` with a culture-invariant UTC creation
// stamp, so the value recorded in daemon.json compares equal on every read of
// the same process lifetime. Newlines inside a command line are flattened so
// one process is one row; the command may still contain `|`, which only ever
// lands in the final capture group.
const WINDOWS_PROCESS_ROW_BODY =
  " | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId," +
  " $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfffffff')," +
  String.raw` ($_.CommandLine -replace '[\r\n]+', ' ') }`;

function windowsProcessQueryArgs(pids: readonly number[]): string[] {
  const source =
    pids.length > 0
      ? `Get-CimInstance -ClassName Win32_Process -Filter '${pids
          .map((pid) => `ProcessId=${pid}`)
          .join(' OR ')}'`
      : 'Get-CimInstance -ClassName Win32_Process';
  // PowerShell writes redirected stdout in the OEM console code page, which would
  // mojibake any non-ASCII command line the identity check later compares
  // byte-for-byte; the console is pinned to UTF-8 so the pipe matches the
  // UTF-8 decode Node applies.
  const command = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${source}${WINDOWS_PROCESS_ROW_BODY}`;
  return ['-NoProfile', '-NonInteractive', '-Command', command];
}

function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = [];
  for (const line of stdout.replace(/^\uFEFF/, '').split('\n')) {
    const match = /^(\d+)\|(\d+)\|([^|]*)\|(.*)\r?$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : undefined,
      startTime: match[3]!.length > 0 ? match[3]! : null,
      command: match[4]!.length > 0 ? match[4]! : null,
    });
  }
  return rows;
}

function readWindowsProcessRows(pids: readonly number[], timeoutMs: number): WindowsProcessRow[] {
  try {
    const result = runCmdSync(WINDOWS_PROCESS_TOOL, windowsProcessQueryArgs(pids), {
      allowFailure: true,
      timeoutMs,
    });
    if (result.exitCode !== 0) return [];
    return parseWindowsProcessRows(result.stdout);
  } catch {
    // A failed CIM snapshot is unknown evidence; callers remain fail-closed.
    return [];
  }
}

function readWindowsProcessField(pid: number, field: HostProcessField): string | null {
  const row = readWindowsProcessRows([pid], WINDOWS_PS_TIMEOUT_MS).find(
    (candidate) => candidate.pid === pid,
  );
  if (!row) return null;
  if (field === 'lstart=') return row.startTime;
  if (field === 'command=') return row.command;
  return 'R';
}

function windowsBudgetMs(timeoutMs: number): number {
  return Math.max(timeoutMs, WINDOWS_PS_TIMEOUT_MS);
}

async function readWindowsProcessIdentityFacts(
  pid: number,
  timeoutMs: number,
): Promise<HostProcessIdentityFacts> {
  if (!Number.isInteger(pid) || pid <= 0) return { startTime: null, command: null, zombie: null };
  try {
    const result = await runCmd(WINDOWS_PROCESS_TOOL, windowsProcessQueryArgs([pid]), {
      allowFailure: true,
      timeoutMs: windowsBudgetMs(timeoutMs),
    });
    if (result.exitCode !== 0) return { startTime: null, command: null, zombie: null };
    const row = parseWindowsProcessRows(result.stdout).find((candidate) => candidate.pid === pid);
    if (!row) return { startTime: null, command: null, zombie: null };
    return { startTime: row.startTime, command: row.command, zombie: false };
  } catch {
    return { startTime: null, command: null, zombie: null };
  }
}

async function listWindowsHostProcesses(
  options: ListHostProcessesOptions,
): Promise<HostProcessInfo[]> {
  const result = await (options.runCommand ?? runCmd)(
    WINDOWS_PROCESS_TOOL,
    windowsProcessQueryArgs([]),
    {
      allowFailure: true,
      timeoutMs: windowsBudgetMs(options.timeoutMs),
    },
  );
  if (result.exitCode !== 0) return [];
  return parseWindowsProcessRows(result.stdout).map((row) => ({
    pid: row.pid,
    ...(row.ppid !== undefined ? { ppid: row.ppid } : {}),
    command: row.command ?? '',
  }));
}

export async function listHostProcesses(
  options: ListHostProcessesOptions,
): Promise<HostProcessInfo[]> {
  if (isWindowsHostPlatform()) return await listWindowsHostProcesses(options);
  const result = await (options.runCommand ?? runCmd)(
    options.runCommand ? 'ps' : HOST_PS_COMMAND,
    ['-ax', '-o', 'pid=,ppid=,command='],
    {
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.exitCode !== 0) return [];
  return parseHostProcessList(result.stdout);
}

export function expandProcessTree(
  rootPids: readonly number[],
  processes: readonly HostProcessInfo[],
): HostProcessInfo[] {
  const selected = new Set(uniquePositivePids(rootPids));
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (processInfo.ppid === undefined || !selected.has(processInfo.ppid)) continue;
      if (selected.has(processInfo.pid)) continue;
      selected.add(processInfo.pid);
      changed = true;
    }
  }
  return processes.filter((processInfo) => selected.has(processInfo.pid));
}

export function uniquePositivePids(
  values: Iterable<number>,
  options: { excludePid?: number } = {},
): number[] {
  return [...new Set(values)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== options.excludePid,
  );
}

export function signalPidsBestEffort(
  pidsToSignal: readonly number[],
  signal: NodeJS.Signals,
): number {
  const pids = uniquePositivePids(pidsToSignal, { excludePid: process.pid });
  let signaled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch {
      // Process already exited or cannot be signaled; cleanup remains best-effort.
    }
  }
  return signaled;
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

export async function stopPidsWithEscalation(
  options: StopPidsWithEscalationOptions,
): Promise<void> {
  const pids = uniquePositivePids(options.pids, { excludePid: process.pid });
  if (pids.length === 0) return;
  signalPidsBestEffort(pids, 'SIGTERM');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.termTimeoutMs)));
  const livePids = pids.filter((pid) => isProcessAlive(pid));
  signalPidsBestEffort(livePids, 'SIGKILL');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.killTimeoutMs)));
}

const SYSCTL_TIMEOUT_MS = 1_000;
const APPLE_SILICON_SYSCTL = ['-n', 'hw.optional.arm64'] as const;

let pendingHostCpuArch: Promise<string> | undefined;
let settledHostCpuArch: string | undefined;

/**
 * The machine's native CPU architecture in Apple naming (`arm64`, `x86_64`), which is what
 * simulators on a Mac run by default. Other CPUs keep Node's `process.arch` name. Resolved once
 * per process.
 */
export function readHostCpuArch(): Promise<string> {
  if (settledHostCpuArch !== undefined) return Promise.resolve(settledHostCpuArch);
  pendingHostCpuArch ??= resolveHostCpuArch(process.platform, process.arch).then(settleHostCpuArch);
  return pendingHostCpuArch;
}

/**
 * {@link readHostCpuArch} for a caller that cannot await. It shares the same per-process value,
 * resolving it with a blocking `sysctl` only when nothing has resolved it yet.
 */
export function readHostCpuArchSync(): string {
  return (
    settledHostCpuArch ??
    settleHostCpuArch(
      hostCpuArchName(process.platform === 'darwin' && isAppleSiliconMacSync(), process.arch),
    )
  );
}

function settleHostCpuArch(arch: string): string {
  settledHostCpuArch ??= arch;
  return settledHostCpuArch;
}

export async function resolveHostCpuArch(
  platform: NodeJS.Platform,
  nodeArch: string,
): Promise<string> {
  return hostCpuArchName(platform === 'darwin' && (await isAppleSiliconMac()), nodeArch);
}

function hostCpuArchName(appleSilicon: boolean, nodeArch: string): string {
  if (appleSilicon) return 'arm64';
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

// macOS: `hw.optional.arm64` is 1 on Apple silicon even inside a Rosetta-translated process,
// where `process.arch` reports x64; Intel Macs do not define the key.
async function isAppleSiliconMac(): Promise<boolean> {
  try {
    const result = await runCmd('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

function isAppleSiliconMacSync(): boolean {
  try {
    const result = runCmdSync('/usr/sbin/sysctl', APPLE_SILICON_SYSCTL, {
      allowFailure: true,
      timeoutMs: SYSCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}
