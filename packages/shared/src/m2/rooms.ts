import { z } from 'zod';
import { EpochMsSchema, IdSchema } from '../m1/common.ts';

export const LinkStateSchema = z.enum(['linked', 'independent']);
export type LinkState = z.infer<typeof LinkStateSchema>;

export const RoomSchema = z.object({
  deviceId: IdSchema,
  name: z.string(),
  groupId: IdSchema,
  linkState: LinkStateSchema,
  lanAddress: z.string().nullable(),
  lastSeen: EpochMsSchema,
});
export type Room = z.infer<typeof RoomSchema>;

export const GroupSchema = z.object({
  groupId: IdSchema,
  name: z.string(),
  leaderDeviceId: z.string().nullable(),
});
export type Group = z.infer<typeof GroupSchema>;

export const RoomStateBodySchema = z.object({ linkState: LinkStateSchema });
export type RoomStateBody = z.infer<typeof RoomStateBodySchema>;

export const RoomsReplySchema = z.object({
  rooms: z.array(RoomSchema),
  groups: z.array(GroupSchema),
});
export type RoomsReply = z.infer<typeof RoomsReplySchema>;
