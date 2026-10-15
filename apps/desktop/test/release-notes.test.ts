import { readFileSync } from 'node:fs';
import { ReleaseNotesSchema } from '@room-jukebox/shared';
import { describe, expect, it } from 'vitest';
import {
  parseReleaseNotes,
  releaseNotesText,
  withReleaseNotes,
} from '../../../scripts/release-notes.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/RELEASES.fixture.md', import.meta.url), 'utf8');

describe('release notes parser', () => {
  it('takes exactly the requested version section, with wrapped bullets', () => {
    const notes = parseReleaseNotes(FIXTURE, '0.0.1');
    expect(notes).toEqual({
      version: '0.0.1',
      date: '2026-10-20',
      changes: ['First change with a wrapped second line.', 'Second change.'],
      checklist: [
        { id: 'v0.0.1-1', text: 'Check one.' },
        { id: 'v0.0.1-2', text: 'Check two continues here.' },
      ],
    });
    expect(ReleaseNotesSchema.safeParse(notes).success).toBe(true);
  });

  it('matches whole versions only (0.0.1 is not 0.0.10) and any dash style', () => {
    expect(parseReleaseNotes(FIXTURE, '0.0.10').changes).toEqual(['Ten.']);
    expect(parseReleaseNotes(FIXTURE, '0.0.0')).toMatchObject({
      date: '2026-09-01',
      checklist: [{ id: 'v0.0.0-1', text: 'Old check.' }],
    });
  });

  it('fails the build on a missing section, date or checklist', () => {
    expect(() => parseReleaseNotes(FIXTURE, '9.9.9')).toThrow(/no "## 9.9.9/);
    expect(() => parseReleaseNotes(FIXTURE, '0.0.2')).toThrow(/no date/);
    expect(() => parseReleaseNotes(FIXTURE, '0.0.3')).toThrow(/no "### Test"/);
  });

  it('parses the real docs/RELEASES.md 0.0.8 section', () => {
    const md = readFileSync(new URL('../../../docs/RELEASES.md', import.meta.url), 'utf8');
    const notes = parseReleaseNotes(md, '0.0.8');
    expect(notes.date).toBe('2026-10-14');
    expect(notes.changes).toHaveLength(3);
    expect(notes.checklist).toHaveLength(7);
    expect(notes.checklist[0]?.id).toBe('v0.0.8-1');
  });
});

describe('latest.yml releaseNotes', () => {
  const YML = `version: 0.0.1
files:
  - url: RoomJukebox-Setup-0.0.1.exe
    sha512: abc==
    size: 100
path: RoomJukebox-Setup-0.0.1.exe
sha512: abc==
releaseDate: '2026-10-20T08:00:00.000Z'
`;

  it('appends a block scalar and keeps every other line', () => {
    const text = releaseNotesText(parseReleaseNotes(FIXTURE, '0.0.1'));
    const out = withReleaseNotes(YML, text);
    expect(out).toBe(
      `${YML}releaseNotes: |-\n  - First change with a wrapped second line.\n  - Second change.\n`,
    );
  });

  it('replaces an existing releaseNotes key (idempotent)', () => {
    const once = withReleaseNotes(YML, '- a: "quoted" # not a comment');
    expect(withReleaseNotes(once, '- a: "quoted" # not a comment')).toBe(once);
    const swapped = withReleaseNotes(
      `${YML.replace('releaseDate', 'releaseNotes: |\n  old\n  lines\nreleaseDate')}`,
      '- new',
    );
    expect(swapped).toBe(`${YML}releaseNotes: |-\n  - new\n`);
  });
});
