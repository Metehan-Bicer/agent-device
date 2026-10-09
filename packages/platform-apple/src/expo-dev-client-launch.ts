import type { DeviceInfo } from '@agent-device/kernel/device';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  resolveRuntimeTransportHints,
  type ResolvedRuntimeTransport,
} from '@agent-device/host-kit/runtime-transport-hints';
import { resolveIosSimulatorExpoDevClientScheme } from './core/app-resolution.ts';

/** Detection must stay well inside the 20 s `simctl openurl` bound of the launch it precedes. */
const EXPO_DEV_CLIENT_PROBE_TIMEOUT_MS = 3_000;

/**
 * The launch URL that points an expo-dev-client at the open's Metro server. An expo-dev-client
 * reads its server from this deep link, not from React Native's `RCT_jsLocation` default, so the
 * runtime hint alone leaves it on its own bundle (#1245). Returns `undefined` for bare React Native
 * apps, an explicit `--launch-url`, or a probe that cannot prove the scheme, which keeps the plain
 * launch. CONSERVATIVE: a failed probe falls back instead of failing the open, because the hint
 * write already succeeded; revisit if a dev-client open must refuse when it cannot be pointed.
 */
export async function resolveExpoDevClientLaunchUrl(
  device: DeviceInfo,
  input: OpenApplicationInput,
): Promise<string | undefined> {
  if (!input.appBundleId || input.runtimeLaunchUrl?.trim()) return undefined;
  const transport = resolveRuntimeTransportHints({
    metroHost: input.runtimeHints.metroHost,
    metroPort: input.runtimeHints.metroPort ? Number(input.runtimeHints.metroPort) : undefined,
    bundleUrl: input.runtimeHints.bundleUrl,
  });
  if (!transport) return undefined;
  let scheme: string | undefined;
  try {
    scheme = await resolveIosSimulatorExpoDevClientScheme(device, input.appBundleId, {
      timeoutMs: EXPO_DEV_CLIENT_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    return undefined;
  }
  return scheme ? buildExpoDevClientLaunchUrl(scheme, transport) : undefined;
}

export function buildExpoDevClientLaunchUrl(
  scheme: string,
  transport: ResolvedRuntimeTransport,
): string {
  // `URL.hostname` keeps an IPv6 host bracketed, and so may a `--metro-host`; bracket only a bare one.
  const host =
    transport.host.includes(':') && !transport.host.startsWith('[')
      ? `[${transport.host}]`
      : transport.host;
  const serverUrl = `${transport.scheme}://${host}:${transport.port}`;
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(serverUrl)}`;
}
