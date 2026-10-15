export interface ParsedReleaseNotes {
  version: string;
  date: string;
  changes: string[];
  checklist: { id: string; text: string }[];
}
export function parseReleaseNotes(markdown: string, version: string): ParsedReleaseNotes;
export function releaseNotesText(notes: ParsedReleaseNotes): string;
export function withReleaseNotes(yml: string, text: string): string;
