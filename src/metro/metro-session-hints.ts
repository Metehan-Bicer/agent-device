import fs from 'node:fs';
import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { resolveMetroServerUrl } from './metro-reload-endpoints.ts';

/** Reload control and the prepared device addresses that may reuse it on a fresh open. */
export type MetroSessionHints = {
  controlBaseUrl: string;
  deviceBaseUrls?: string[];
};

function metroSessionHintsPath(stateDir: string, session: string): string {
  return path.join(stateDir, 'metro-sessions', `${safeSessionName(session)}.json`);
}

export function writeMetroSessionHints(options: {
  stateDir: string;
  session: string;
  hints: MetroSessionHints;
}): void {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(options.hints, null, 2)}\n`, 'utf8');
}

export function readMetroSessionHints(options: {
  stateDir: string;
  session: string;
}): MetroSessionHints | undefined {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  try {
    const runtime = {
      metroHost: typeof record.metroHost === 'string' ? record.metroHost : undefined,
      metroPort: typeof record.metroPort === 'number' ? record.metroPort : undefined,
      bundleUrl: typeof record.bundleUrl === 'string' ? record.bundleUrl : undefined,
    };
    if (
      typeof record.controlBaseUrl !== 'string' &&
      Object.values(runtime).every((value) => value === undefined)
    )
      return undefined;
    const url =
      typeof record.controlBaseUrl === 'string'
        ? new URL(record.controlBaseUrl)
        : resolveMetroServerUrl({ runtime });
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? {
          controlBaseUrl: url.toString(),
          ...(Array.isArray(record.deviceBaseUrls)
            ? {
                deviceBaseUrls: record.deviceBaseUrls.filter(
                  (value): value is string => typeof value === 'string',
                ),
              }
            : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function clearMetroSessionHints(options: { stateDir: string; session: string }): void {
  fs.rmSync(metroSessionHintsPath(options.stateDir, options.session), { force: true });
}
