import { z } from 'zod';
import { EpochMsSchema } from '../m1/common.ts';
import { KeyEpochSchema } from './pairing.ts';

const RowsSchema = z.array(z.record(z.string(), z.unknown()));

export const TombstoneSchema = z.object({
  table: z.string().min(1),
  id: z.string().min(1),
  deletedAt: EpochMsSchema,
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

export const ReplicaSnapshotSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  passwordVerifier: z.string(),
  householdKeyEpoch: KeyEpochSchema,
  fallbackPlaylists: RowsSchema,
  fallbackVideos: RowsSchema,
  videos: RowsSchema,
  history: RowsSchema,
  rooms: RowsSchema,
  groups: RowsSchema,
  players: RowsSchema,
  quotaLog: RowsSchema,
  searchUsage: RowsSchema,
  queueEntries: RowsSchema,
  tombstones: z.array(TombstoneSchema),
  snapshotAt: EpochMsSchema,
  hubEpoch: z.number().int().nonnegative(),
});
export type ReplicaSnapshot = z.infer<typeof ReplicaSnapshotSchema>;
