/** localStorage that never throws (private mode, blocked storage, tests). Keys are listed here. */
export const KEYS = {
  notice: 'rj.noticeAccepted',
  name: 'rj.name',
  stepsSeen: 'rj.stepsSeen',
  /** '1' when the guest last used Browse YouTube: the panel opens directly next visit. */
  browse: 'rj.browse',
} as const;

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the page still works, it just forgets
  }
}

/** Removes every Room Jukebox key from this browser (Forget me). */
export function clearLocal(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.startsWith('rj.')) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // nothing stored
  }
}
