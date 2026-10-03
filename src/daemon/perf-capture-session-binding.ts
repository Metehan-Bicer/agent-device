import { bindSessionCapture } from './session-capture-binding.ts';
import type { SessionRef } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export function bindSessionPerfCapture(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.perfCapture,
    write: (perfCapture) => {
      sessionStore.update(ref, { perfCapture });
    },
  });
}
