import { z } from 'zod';
import { ClientMessageSchema, ServerMessageSchema } from '../m1/ws.ts';
import { HouseholdKeySchema, KeyEpochSchema } from './pairing.ts';
import { ReplicaSnapshotSchema } from './replica.ts';
import { IdSchema } from '../m1/common.ts';

export const AuthMessageSchema = z.object({
  type: z.literal('auth'),
  deviceId: IdSchema,
  nonceP: z.string().min(1),
  proof: z.string().min(1),
});
export const AuthOkMessageSchema = z.object({
  type: z.literal('authOk'),
  nonceH: z.string().min(1),
  proof: z.string().min(1),
});
export const RekeyMessageSchema = z.object({
  type: z.literal('rekey'),
  householdKey: HouseholdKeySchema,
  keyEpoch: KeyEpochSchema,
});
export const ReplicaMessageSchema = z.object({
  type: z.literal('replica'),
  snapshot: ReplicaSnapshotSchema,
});
export const ReplicaDeltaMessageSchema = z.object({
  type: z.literal('replicaDelta'),
  // TODO(M2): define the per-table change shape once replication is implemented.
  changes: z.array(z.unknown()),
});

/** Player → hub after storing a `replica` snapshot. */
export const ReplicaAckMessageSchema = z.object({
  type: z.literal('replicaAck'),
  snapshotAt: z.number().int().nonnegative(),
});
export type ReplicaAckMessage = z.infer<typeof ReplicaAckMessageSchema>;

export const M2ClientMessageSchema = z.union([
  ClientMessageSchema,
  AuthMessageSchema,
  ReplicaAckMessageSchema,
]);
export type M2ClientMessage = z.infer<typeof M2ClientMessageSchema>;

export const M2ServerMessageSchema = z.union([
  ServerMessageSchema,
  AuthOkMessageSchema,
  RekeyMessageSchema,
  ReplicaMessageSchema,
  ReplicaDeltaMessageSchema,
]);
export type M2ServerMessage = z.infer<typeof M2ServerMessageSchema>;
