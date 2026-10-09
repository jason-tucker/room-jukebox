import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import { networkInterfaces } from 'node:os';

export interface CheckResult {
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

export interface SelfCheck {
  at: string;
  mode: string;
  appVersion: string;
  sqlite: CheckResult;
  argon2: CheckResult & { present: boolean };
  scrypt: CheckResult;
  versions: NodeJS.ProcessVersions;
  platform: string;
  arch: string;
  displays: unknown;
  networkInterfaces: unknown;
  networkCategory?: unknown;
}

async function timed(fn: () => Promise<unknown>): Promise<CheckResult> {
  const start = performance.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Math.round(performance.now() - start), detail };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function checkSqlite(): Promise<unknown> {
  // Dynamic so a build without node:sqlite fails this check instead of the whole main process.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('jukebox');
    const row = db.prepare('SELECT id, v FROM t').get() as { id: number; v: string } | undefined;
    if (row?.v !== 'jukebox') throw new Error(`unexpected row ${JSON.stringify(row)}`);
    const version = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    return { row, sqliteVersion: version.v };
  } finally {
    db.close();
  }
}

function checkArgon2(): Promise<unknown> {
  return new Promise((ok, fail) => {
    // OWASP minimum argon2id profile: 19 MiB, 2 passes, 1 lane.
    crypto.argon2(
      'argon2id',
      {
        message: 'selfcheck',
        nonce: crypto.randomBytes(16),
        parallelism: 1,
        tagLength: 32,
        memory: 19456,
        passes: 2,
      },
      (err, key) => (err ? fail(err) : ok({ tagBytes: key.length })),
    );
  });
}

function checkScrypt(): Promise<unknown> {
  return new Promise((ok, fail) => {
    crypto.scrypt('selfcheck', crypto.randomBytes(16), 32, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? fail(err) : ok({ keyBytes: key.length, N: 16384 }),
    );
  });
}

/** Windows network profile category (Public/Private/DomainAuthenticated); skipped elsewhere. */
function networkCategory(): Promise<unknown> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((ok) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,@{n="NetworkCategory";e={"$($_.NetworkCategory)"}} | ConvertTo-Json -Compress',
      ],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return ok({ error: err.message });
        try {
          ok(JSON.parse(stdout));
        } catch {
          ok({ raw: stdout.trim() });
        }
      },
    );
  });
}

export async function runSelfCheck(context: {
  mode: string;
  appVersion: string;
  displays: unknown;
}): Promise<SelfCheck> {
  const argon2Present = typeof (crypto as { argon2?: unknown }).argon2 === 'function';
  const [sqlite, argon2, scrypt, category] = await Promise.all([
    timed(checkSqlite),
    argon2Present
      ? timed(checkArgon2)
      : Promise.resolve<CheckResult>({
          ok: false,
          ms: 0,
          error: 'crypto.argon2 is not a function',
        }),
    timed(checkScrypt),
    networkCategory(),
  ]);
  return {
    at: new Date().toISOString(),
    mode: context.mode,
    appVersion: context.appVersion,
    sqlite,
    argon2: { present: argon2Present, ...argon2 },
    scrypt,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    displays: context.displays,
    networkInterfaces: networkInterfaces(),
    ...(category === undefined ? {} : { networkCategory: category }),
  };
}
