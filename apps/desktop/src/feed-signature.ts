import { verify } from 'node:crypto';

/** Ed25519 signature check of `latest.yml` (the release job writes base64 to `latest.yml.sig`). */
export function verifyFeedSignature(
  data: Buffer,
  signatureText: string,
  publicKeyPem: string,
): boolean {
  const sig = Buffer.from(signatureText.trim(), 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, data, publicKeyPem, sig);
  } catch {
    return false;
  }
}

export interface FeedInfo {
  version: string;
  files: { sha512: string }[];
}

/**
 * Binds what electron-updater parsed to the signed bytes: same version and every file hash it
 * will verify the download against appears in the signed feed.
 */
export function feedMatchesUpdateInfo(yml: string, info: FeedInfo): boolean {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yml)?.[1];
  if (version !== info.version) return false;
  const hashes = new Set(
    [...yml.matchAll(/sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?/g)].map((m) => m[1]),
  );
  return info.files.length > 0 && info.files.every((f) => hashes.has(f.sha512));
}

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type FeedCheck =
  { ok: true; dateHeader: string | null } | { ok: false; error: string; dateHeader: string | null };

/**
 * Fetches `<base>/latest.yml` and `<base>/latest.yml.sig` and checks both. `base` is the feed
 * directory (Tango) or the release `.../download/v<version>` (GitHub): see `signatureBase`.
 */
export async function checkSignedFeed(
  feedBase: string,
  info: FeedInfo,
  publicKeyPem: string,
  fetchFn: FetchLike,
): Promise<FeedCheck> {
  const base = feedBase.replace(/\/+$/, '');
  const yml = await fetchFn(`${base}/latest.yml`);
  const dateHeader = yml.headers.get('date');
  if (!yml.ok) return { ok: false, error: `latest.yml HTTP ${yml.status}`, dateHeader };
  const sig = await fetchFn(`${base}/latest.yml.sig`);
  if (!sig.ok)
    return { ok: false, error: `latest.yml.sig missing (HTTP ${sig.status})`, dateHeader };
  const data = Buffer.from(await yml.arrayBuffer());
  const sigText = Buffer.from(await sig.arrayBuffer()).toString('utf8');
  if (!verifyFeedSignature(data, sigText, publicKeyPem)) {
    return { ok: false, error: 'latest.yml signature is invalid', dateHeader };
  }
  if (!feedMatchesUpdateInfo(data.toString('utf8'), info)) {
    return { ok: false, error: 'signed latest.yml does not match the offered update', dateHeader };
  }
  return { ok: true, dateHeader };
}
