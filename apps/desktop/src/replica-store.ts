import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReplicaSnapshotSchema } from '@room-jukebox/shared';
import type { ReplicaSnapshot } from '@room-jukebox/shared';
import { openSecret, sealSecret } from './desktop-state';
import type { SecretCodec, StoredSecret } from './desktop-state';

/**
 * `userData/replica.json`: the last `ReplicaSnapshot` the hub sent this player (contract §4),
 * sealed with safeStorage. `snapshotAt` and `hubEpoch` stay readable so the status line does not
 * decrypt megabytes every few seconds. Become hub (a later build) loads it.
 */
interface ReplicaFile {
  v: 1;
  snapshotAt: number;
  hubEpoch: number;
  data: StoredSecret;
}

export interface ReplicaInfo {
  snapshotAt: number;
  hubEpoch: number;
  bytes: number;
}

export function writeReplica(file: string, codec: SecretCodec, snapshot: unknown): ReplicaInfo {
  const parsed = ReplicaSnapshotSchema.parse(snapshot);
  const body: ReplicaFile = {
    v: 1,
    snapshotAt: parsed.snapshotAt,
    hubEpoch: parsed.hubEpoch,
    data: sealSecret(codec, JSON.stringify(parsed)),
  };
  const text = JSON.stringify(body);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return { snapshotAt: body.snapshotAt, hubEpoch: body.hubEpoch, bytes: Buffer.byteLength(text) };
}

function readFile(file: string): ReplicaFile | null {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReplicaFile> | null;
    if (
      !body ||
      body.v !== 1 ||
      typeof body.snapshotAt !== 'number' ||
      typeof body.hubEpoch !== 'number' ||
      !body.data
    ) {
      return null;
    }
    return body as ReplicaFile;
  } catch {
    return null;
  }
}

export function replicaInfo(file: string): ReplicaInfo | null {
  const body = readFile(file);
  if (!body) return null;
  return { snapshotAt: body.snapshotAt, hubEpoch: body.hubEpoch, bytes: statSync(file).size };
}

/** `null` when missing, corrupt or sealed for another Windows user. */
export function readReplica(file: string, codec: SecretCodec): ReplicaSnapshot | null {
  const body = readFile(file);
  const text = body ? openSecret(codec, body.data) : undefined;
  if (!text) return null;
  try {
    const parsed = ReplicaSnapshotSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
