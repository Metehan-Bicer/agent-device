import { bindSessionCapture } from './session-capture-binding.ts';
import type { SessionRef } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

export function bindSessionAudioProbe(sessionStore: SessionStore, ref: SessionRef) {
  return bindSessionCapture(sessionStore, ref, {
    read: (session) => session.audioProbe,
    write: (audioProbe) => {
      sessionStore.update(ref, { audioProbe });
    },
  });
}
