import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureSessionBinding, DurableCaptureSessionSlot } from './definition.ts';

export function makeCaptureSessionBinding<K extends string, H extends AsyncDisposable, S>(
  store: Readonly<{
    get(name: string): S | undefined;
    set(name: string, session: S): void;
    resolveSessionDir(name: string): string;
  }>,
  address: string,
  slot: DurableCaptureSessionSlot<K, H, S>,
): DurableCaptureSessionBinding<K, H> {
  const requireSession = (): S => {
    const session = store.get(address);
    if (!session) throw new AppError('COMMAND_FAILED', 'Test session retired');
    return session;
  };
  const assertAdoptable = (): void => {
    if (slot.read(requireSession())) throw new AppError('COMMAND_FAILED', 'Test resource changed');
  };
  return Object.freeze({
    address,
    sessionDir: store.resolveSessionDir(address),
    read: () => {
      const session = store.get(address);
      return session === undefined ? undefined : slot.read(session);
    },
    assertAdoptable,
    canPersist: () => {
      const session = store.get(address);
      return session !== undefined && slot.read(session) === undefined;
    },
    adopt: (resource) => {
      assertAdoptable();
      store.set(address, slot.replace(requireSession(), resource));
    },
    clear: (expected) => {
      const current = store.get(address);
      if (!current) return 'retired';
      if (slot.read(current)?.handle !== expected.handle) return 'resource-changed';
      store.set(address, slot.replace(current, undefined));
      return 'cleared';
    },
  });
}
