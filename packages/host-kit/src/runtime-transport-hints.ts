import { URL } from 'node:url';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';

export type ResolvedRuntimeTransport = {
  host: string;
  port: number;
  scheme: 'http' | 'https';
};

export function resolveRuntimeTransportHints(
  runtime: SessionRuntimeHints | undefined,
): ResolvedRuntimeTransport | undefined {
  if (!runtime) return undefined;

  let host = trimRuntimeValue(runtime.metroHost);
  let port = normalizePort(runtime.metroPort);
  let scheme: 'http' | 'https' = 'http';
  const bundleUrl = trimRuntimeValue(runtime.bundleUrl);
  if (bundleUrl) {
    let parsed: URL;
    try {
      parsed = new URL(bundleUrl);
    } catch (error) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid runtime bundle URL: ${bundleUrl}`,
        {},
        error as Error,
      );
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      host ??= trimRuntimeValue(parsed.hostname);
      port ??= normalizePort(
        parsed.port.length > 0 ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol),
      );
      scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    }
  }

  if (!host || !port) return undefined;
  return { host, port, scheme };
}

export function trimRuntimeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves a complete server address, retaining its mount but removing the bundle entry. */
export function resolveRuntimeServerUrl(runtime: SessionRuntimeHints | undefined): URL | undefined {
  const transport = resolveRuntimeTransportHints(runtime);
  if (!transport) return undefined;
  const host =
    transport.host.includes(':') && !transport.host.startsWith('[')
      ? `[${transport.host}]`
      : transport.host;
  const url = new URL(`${transport.scheme}://${host}:${transport.port}`);
  if (runtime?.bundleUrl?.trim()) {
    const bundlePath = new URL(runtime.bundleUrl).pathname.replace(/\/+$/, '');
    const expoEntry = '/.expo/.virtual-metro-entry.bundle';
    url.pathname = bundlePath.endsWith(expoEntry)
      ? bundlePath.slice(0, -expoEntry.length)
      : /\.(?:bundle|jsbundle|js)$/.test(bundlePath)
        ? bundlePath.slice(0, bundlePath.lastIndexOf('/'))
        : bundlePath;
  }
  return url;
}

function normalizePort(value: number | undefined): number | undefined {
  if (!Number.isInteger(value)) return undefined;
  if ((value as number) <= 0 || (value as number) > 65_535) return undefined;
  return value;
}

function defaultPortForProtocol(protocol: string): number | undefined {
  if (protocol === 'https:') return 443;
  if (protocol === 'http:') return 80;
  return undefined;
}
