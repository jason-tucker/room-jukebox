#!/usr/bin/env node
// Release notes for the build (plain Node, no dependencies).
//
//   node scripts/release-notes.mjs
//       docs/RELEASES.md section of apps/desktop/package.json's version
//       -> apps/desktop/build/release-notes.json  { version, date, changes, checklist }
//   node scripts/release-notes.mjs --latest-yml apps/desktop/release/latest.yml
//       also writes the Changes bullets into that latest.yml as `releaseNotes` (block scalar)
//
// Options: --version <x.y.z> (default: the desktop package version), --releases <md>, --out <json>.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `## <version> — <date>` (em dash, en dash or hyphen). */
const HEADING = /^##\s+(\S+)\s*(?:[—–-]\s*(.*?))?\s*$/;

/**
 * Parses the section of `version` from RELEASES.md. Bullets may wrap onto indented lines.
 * Throws when the section, its date or its `### Test` checklist is missing.
 */
export function parseReleaseNotes(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let date = '';
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1] === version) {
      start = i;
      date = (m[2] ?? '').trim();
      break;
    }
  }
  if (start < 0) throw new Error(`docs/RELEASES.md has no "## ${version} — <date>" section`);
  if (!date) throw new Error(`the ${version} heading has no date ("## ${version} — YYYY-MM-DD")`);

  const lists = { changes: [], test: [] };
  let current = null;
  let last = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const sub = /^###\s+(.*?)\s*$/.exec(line);
    if (sub) {
      const name = sub[1].toLowerCase();
      current = name.startsWith('change') ? 'changes' : name.startsWith('test') ? 'test' : null;
      last = null;
      continue;
    }
    if (!current) continue;
    const bullet = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      last = bullet[1].trim();
      lists[current].push(last);
    } else if (last !== null && /^\s+\S/.test(line)) {
      const list = lists[current];
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
    } else if (!line.trim()) {
      last = null;
    }
  }
  const changes = lists.changes.filter(Boolean);
  const checklist = lists.test
    .filter(Boolean)
    .map((text, n) => ({ id: `v${version}-${n + 1}`, text }));
  if (checklist.length === 0) throw new Error(`the ${version} section has no "### Test" bullets`);
  return { version, date, changes, checklist };
}

/** The `releaseNotes` text written into latest.yml: one "- " line per change. */
export function releaseNotesText(notes) {
  return notes.changes.map((c) => `- ${c}`).join('\n');
}

/**
 * Sets `releaseNotes` in electron-builder's latest.yml as a `|-` block scalar (any existing
 * `releaseNotes` key and its indented lines are replaced). Other lines stay byte-identical.
 */
export function withReleaseNotes(yml, text) {
  const out = [];
  let skipping = false;
  for (const line of yml.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')) {
    if (/^releaseNotes:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^\s/.test(line) || line === '')) continue;
    skipping = false;
    out.push(line);
  }
  const body = text
    .split('\n')
    .map((l) => (l ? `  ${l}` : ''))
    .join('\n');
  if (text.trim()) out.push(`releaseNotes: |-\n${body}`);
  return `${out.join('\n')}\n`;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8'));
  const version = arg(argv, '--version') ?? pkg.version;
  const releases = arg(argv, '--releases') ?? join(repo, 'docs/RELEASES.md');
  const out = arg(argv, '--out') ?? join(repo, 'apps/desktop/build/release-notes.json');
  const notes = parseReleaseNotes(readFileSync(releases, 'utf8'), version);
  writeFileSync(out, `${JSON.stringify(notes, null, 2)}\n`);
  console.log(
    `release notes ${notes.version} (${notes.date}): ${notes.changes.length} changes, ` +
      `${notes.checklist.length} checklist items -> ${out}`,
  );
  const latestYml = arg(argv, '--latest-yml');
  if (latestYml) {
    writeFileSync(
      latestYml,
      withReleaseNotes(readFileSync(latestYml, 'utf8'), releaseNotesText(notes)),
    );
    console.log(`releaseNotes written into ${latestYml}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release-notes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
