import { readFileSync } from 'node:fs';
import { ReleaseNotesSchema } from '@room-jukebox/shared';
import type { ReleaseNotes } from '@room-jukebox/shared';

/**
 * `resources/release-notes.json` (written by `scripts/release-notes.mjs` at build time).
 * `null` when it is missing or malformed: the app runs without a "What's new" checklist.
 */
export function loadReleaseNotes(
  file: string,
  log: { warn: (...a: unknown[]) => void },
): ReleaseNotes | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`release notes unavailable (${file})`, err instanceof Error ? err.message : err);
    return null;
  }
  const parsed = ReleaseNotesSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(`release notes malformed (${file})`, parsed.error.message);
    return null;
  }
  return parsed.data;
}
