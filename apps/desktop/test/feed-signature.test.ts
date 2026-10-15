import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSignedFeed, feedMatchesUpdateInfo, verifyFeedSignature } from '../src/feed-signature';
import type { FetchLike } from '../src/feed-signature';

// Throwaway key for the tests; the real private key only exists in the release environment.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const OTHER_PEM = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

const SHA =
  'k3bS0qJ1n3cY0xg8Yy3vZ1t9kPz+9w2Z8b5vQm3d4X7qJ3oN1aF0cE9rT6uH2sL5yW4iG8eK7jD1pM0nB2vC==';
const YML = `version: 0.0.5
files:
  - url: RoomJukebox-Setup-0.0.5.exe
    sha512: ${SHA}
    size: 90123456
path: RoomJukebox-Setup-0.0.5.exe
sha512: ${SHA}
releaseDate: '2026-10-10T08:00:00.000Z'
`;
const DATA = Buffer.from(YML);
const SIG = `${sign(null, DATA, privateKey).toString('base64')}\n`; // as the release job writes it
const INFO = { version: '0.0.5', files: [{ sha512: SHA }] };

describe('latest.yml signature', () => {
  it('accepts the exact signed bytes', () => {
    expect(verifyFeedSignature(DATA, SIG, PUBLIC_PEM)).toBe(true);
  });

  it('rejects modified bytes, another key and junk signatures', () => {
    expect(verifyFeedSignature(Buffer.from(YML.replace('0.0.5', '0.0.6')), SIG, PUBLIC_PEM)).toBe(
      false,
    );
    expect(verifyFeedSignature(Buffer.from(`${YML}\n`), SIG, PUBLIC_PEM)).toBe(false);
    expect(verifyFeedSignature(DATA, SIG, OTHER_PEM)).toBe(false);
    expect(verifyFeedSignature(DATA, '', PUBLIC_PEM)).toBe(false);
    expect(verifyFeedSignature(DATA, 'not base64 at all!', PUBLIC_PEM)).toBe(false);
    expect(verifyFeedSignature(DATA, SIG, 'not a key')).toBe(false);
  });

  it('binds the signed feed to what electron-updater offers', () => {
    expect(feedMatchesUpdateInfo(YML, INFO)).toBe(true);
    expect(feedMatchesUpdateInfo(YML, { ...INFO, version: '0.0.6' })).toBe(false);
    expect(feedMatchesUpdateInfo(YML, { version: '0.0.5', files: [{ sha512: 'other==' }] })).toBe(
      false,
    );
    expect(feedMatchesUpdateInfo(YML, { version: '0.0.5', files: [] })).toBe(false);
  });

  it('compiles in a valid Ed25519 release key', () => {
    const pem = readFileSync(new URL('../build/release-public.pem', import.meta.url), 'utf8');
    expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519');
    expect(verifyFeedSignature(DATA, SIG, pem)).toBe(false);
  });
});

function fakeFetch(
  files: Record<string, string>,
  date = 'Sat, 10 Oct 2026 08:00:00 GMT',
): {
  fetch: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'date' ? date : null) },
      arrayBuffer: async () => {
        const b = Buffer.from(body ?? 'Not Found');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { fetch, urls };
}

describe('signed feed check', () => {
  const BASE = 'https://github.com/o/r/releases/download/v0.0.5';
  const yml = `${BASE}/latest.yml`;

  it('passes with a good signature and reports the Date header', async () => {
    const { fetch, urls } = fakeFetch({ [yml]: YML, [`${yml}.sig`]: SIG });
    expect(await checkSignedFeed(`${BASE}/`, INFO, PUBLIC_PEM, fetch)).toEqual({
      ok: true,
      dateHeader: 'Sat, 10 Oct 2026 08:00:00 GMT',
    });
    expect(urls).toEqual([yml, `${yml}.sig`]);
  });

  it('aborts when the signature file is missing', async () => {
    const { fetch } = fakeFetch({ [yml]: YML });
    const r = await checkSignedFeed(BASE, INFO, PUBLIC_PEM, fetch);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/sig missing/);
  });

  it('aborts on a bad signature', async () => {
    const { fetch } = fakeFetch({
      [yml]: YML.replace('90123456', '90123457'),
      [`${yml}.sig`]: SIG,
    });
    const r = await checkSignedFeed(BASE, INFO, PUBLIC_PEM, fetch);
    expect(r).toMatchObject({ ok: false, error: 'latest.yml signature is invalid' });
  });

  it('aborts when the signed feed does not describe the offered update', async () => {
    const { fetch } = fakeFetch({ [yml]: YML, [`${yml}.sig`]: SIG });
    const r = await checkSignedFeed(
      BASE,
      { version: '0.0.5', files: [{ sha512: 'evil==' }] },
      PUBLIC_PEM,
      fetch,
    );
    expect(r).toMatchObject({
      ok: false,
      error: 'signed latest.yml does not match the offered update',
    });
  });

  it('aborts when latest.yml itself is missing', async () => {
    const { fetch } = fakeFetch({});
    expect((await checkSignedFeed(BASE, INFO, PUBLIC_PEM, fetch)).ok).toBe(false);
  });
});

describe('openssl-signed latest.yml (scripts/build-win.sh format)', () => {
  it('accepts `openssl pkeyutl -sign -rawin | base64 -w0`, byte-identical to crypto.sign', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rj-sig-'));
    const key = join(dir, 'key.pem');
    const yml = join(dir, 'latest.yml');
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', key]);
    writeFileSync(yml, YML);
    const sigText = execFileSync('bash', [
      '-c',
      `openssl pkeyutl -sign -inkey "${key}" -rawin -in "${yml}" | base64 -w0`,
    ]).toString();
    expect(sigText).toMatch(/^[A-Za-z0-9+/]{86}==$/); // 64 bytes, no newline
    const pub = execFileSync('openssl', ['pkey', '-in', key, '-pubout']).toString();
    expect(verifyFeedSignature(DATA, sigText, pub)).toBe(true);
    expect(verifyFeedSignature(Buffer.from(`${YML} `), sigText, pub)).toBe(false);
    // Ed25519 is deterministic: Node's signature with the same key is the same bytes.
    const nodeSig = sign(null, DATA, createPrivateKey(readFileSync(key))).toString('base64');
    expect(nodeSig).toBe(sigText);
  });
});
