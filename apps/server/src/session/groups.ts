/**
 * Rooms and groups (contract-m2 §3): one `Session` per group. The main group (`main`) is the
 * hub's; every independent room gets a one-room group of its own, seeded from the fallback pool
 * with an empty queue. Linking a room back merges it into the main group; its group's queue is
 * dropped and returned as orphaned entries for the owner to re-add (never moved silently).
 */
import { randomUUID } from 'node:crypto';
import type {
  AdminState,
  EntryAdmin,
  Group,
  LinkState,
  PlayerInfo,
  Room,
} from '@room-jukebox/shared';
import type { RoomRow } from '../db/repo.ts';
import { MAIN_GROUP_ID } from '../db/repo.ts';
import { toEntryAdmin } from './projections.ts';
import type { PlayFailure, SessionDeps } from './session.ts';
import { Session } from './session.ts';

export { MAIN_GROUP_ID };

/** Device IDs of the hub's own TV window start with this (issued by `issueLocalPlayerToken`). */
export const LOCAL_PLAYER_PREFIX = 'tv-';
export const isLocalPlayer = (deviceId: string): boolean =>
  deviceId.startsWith(LOCAL_PLAYER_PREFIX);

export type GroupsDeps = Omit<SessionDeps, 'groupId' | 'roomName'>;

export interface LinkResult {
  room: Room;
  /** The merged group's entries (now playing first), for the owner to re-add. Empty on split. */
  orphaned: EntryAdmin[];
}

const toRoom = (r: RoomRow): Room => ({
  deviceId: r.deviceId,
  name: r.name,
  groupId: r.groupId,
  linkState: r.linkState,
  lanAddress: r.lanAddress,
  lastSeen: r.lastSeen,
});

export class Groups {
  #d: GroupsDeps;
  #sessions = new Map<string, Session>();
  #changeListeners = new Set<(groupId: string) => void>();
  #failListeners = new Set<(f: PlayFailure, groupId: string) => void>();
  readonly main: Session;

  constructor(deps: GroupsDeps) {
    this.#d = deps;
    const { repos } = deps;
    const now = deps.now();
    repos.groups.ensure(MAIN_GROUP_ID, deps.settings.data().roomName, now);
    // M1 hubs: every paired device becomes a room in the main group.
    for (const p of repos.players.list()) {
      if (repos.rooms.get(p.deviceId) === null) {
        repos.rooms.upsert({
          deviceId: p.deviceId,
          name: p.name,
          groupId: MAIN_GROUP_ID,
          linkState: 'linked',
          lanAddress: null,
          lastSeen: 0,
          createdAt: p.createdAt,
        });
      }
    }
    this.main = this.#open(MAIN_GROUP_ID);
    for (const g of repos.groups.list()) {
      if (g.groupId !== MAIN_GROUP_ID) this.#open(g.groupId);
    }
    const active = new Set(repos.players.list().map((p) => p.deviceId));
    for (const r of repos.rooms.list()) {
      if (!active.has(r.deviceId)) continue;
      (this.#sessions.get(r.groupId) ?? this.main).addPlayer(r.deviceId, r.name, r.createdAt);
    }
  }

  #open(groupId: string): Session {
    const session = new Session({
      ...this.#d,
      groupId,
      ...(groupId === MAIN_GROUP_ID ? {} : { roomName: () => this.#groupName(groupId) }),
    });
    session.onChange(() => {
      for (const l of this.#changeListeners) l(groupId);
    });
    session.onPlayFailure((f) => {
      for (const l of this.#failListeners) l(f, groupId);
    });
    this.#sessions.set(groupId, session);
    return session;
  }

  #groupName(groupId: string): string {
    return (
      this.#d.repos.groups.list().find((g) => g.groupId === groupId)?.name ??
      this.#d.settings.data().roomName
    );
  }

  onChange(listener: (groupId: string) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onPlayFailure(listener: (f: PlayFailure, groupId: string) => void): () => void {
    this.#failListeners.add(listener);
    return () => this.#failListeners.delete(listener);
  }

  /** Every live session (main first). */
  sessions(): Session[] {
    return [...this.#sessions.values()];
  }

  get(groupId: string): Session | undefined {
    return this.#sessions.get(groupId);
  }

  /** The group's session; an unknown or merged group (or none) falls back to the main group. */
  resolve(groupId: string | null | undefined): Session {
    return (groupId ? this.#sessions.get(groupId) : undefined) ?? this.main;
  }

  /** The session the player belongs to (main when the device has no room). */
  sessionOfPlayer(deviceId: string): Session {
    for (const s of this.#sessions.values()) if (s.hasPlayer(deviceId)) return s;
    return this.main;
  }

  // -------------------------------------------------------------------------------------------
  // Rooms

  room(deviceId: string): Room | null {
    const r = this.#d.repos.rooms.get(deviceId);
    return r === null ? null : toRoom(r);
  }

  /**
   * Makes a paired device a room (or refreshes its name). A new room is `linked`; a known one
   * keeps its stored link state (an independent room gets its group back).
   */
  ensureRoom(deviceId: string, name: string): Room {
    const { repos } = this.#d;
    const now = this.#d.now();
    const existing = repos.rooms.get(deviceId);
    const linkState: LinkState = existing?.linkState ?? 'linked';
    let groupId = MAIN_GROUP_ID;
    if (linkState === 'independent') {
      groupId =
        existing && this.#sessions.has(existing.groupId) && existing.groupId !== MAIN_GROUP_ID
          ? existing.groupId
          : this.#newGroup(name);
    }
    const row: RoomRow = {
      deviceId,
      name,
      groupId,
      linkState,
      lanAddress: existing?.lanAddress ?? null,
      lastSeen: existing?.lastSeen ?? 0,
      createdAt: existing?.createdAt ?? now,
    };
    repos.rooms.upsert(row);
    if (groupId !== MAIN_GROUP_ID) repos.groups.setName(groupId, name);
    const current = this.sessionOfPlayer(deviceId);
    const target = this.#sessions.get(groupId) as Session;
    if (current.hasPlayer(deviceId) && current !== target) {
      const live = current.detachPlayer(deviceId);
      if (live) target.attachPlayer({ ...live, name });
    } else {
      target.addPlayer(deviceId, name, row.createdAt);
    }
    return toRoom(row);
  }

  #newGroup(name: string): string {
    const groupId = `g-${randomUUID()}`;
    this.#d.repos.groups.ensure(groupId, name, this.#d.now());
    this.#open(groupId);
    return groupId;
  }

  /** Records the room's address and time when its player connects. */
  roomSeen(deviceId: string, lanAddress: string | null): void {
    this.#d.repos.rooms.seen(deviceId, lanAddress, this.#d.now());
  }

  /**
   * Link (merge into the main group) or split (a new one-room group seeded from the fallback
   * pool). Linking returns the dropped group's live entries as `orphaned`.
   */
  setLinkState(deviceId: string, linkState: LinkState): LinkResult | null {
    const { repos } = this.#d;
    const row = repos.rooms.get(deviceId);
    if (row === null) return null;
    if (linkState === 'independent') {
      if (row.groupId !== MAIN_GROUP_ID && this.#sessions.has(row.groupId)) {
        repos.rooms.upsert({ ...row, linkState });
        return { room: toRoom({ ...row, linkState }), orphaned: [] };
      }
      const groupId = this.#newGroup(row.name);
      const next = { ...row, linkState, groupId };
      repos.rooms.upsert(next);
      this.#move(deviceId, row.name, row.createdAt, groupId);
      repos.events.append('room.split', { deviceId, groupId }, this.#d.now());
      return { room: toRoom(next), orphaned: [] };
    }
    const oldGroup = row.groupId;
    const next = { ...row, linkState, groupId: MAIN_GROUP_ID };
    repos.rooms.upsert(next);
    this.#move(deviceId, row.name, row.createdAt, MAIN_GROUP_ID);
    const orphaned = oldGroup === MAIN_GROUP_ID ? [] : this.#dropGroup(oldGroup);
    if (oldGroup !== MAIN_GROUP_ID) {
      repos.events.append(
        'room.link',
        { deviceId, groupId: oldGroup, orphaned: orphaned.length },
        this.#d.now(),
      );
    }
    return { room: toRoom(next), orphaned };
  }

  #move(deviceId: string, name: string, order: number, groupId: string): void {
    const target = this.#sessions.get(groupId) as Session;
    const current = this.sessionOfPlayer(deviceId);
    if (current === target && target.hasPlayer(deviceId)) return;
    const live = current.hasPlayer(deviceId) ? current.detachPlayer(deviceId) : null;
    if (live) target.attachPlayer(live);
    else target.addPlayer(deviceId, name, order);
  }

  /** Deletes a non-main group (no rooms left in it) and returns its live entries. */
  #dropGroup(groupId: string): EntryAdmin[] {
    const session = this.#sessions.get(groupId);
    if (!session || groupId === MAIN_GROUP_ID) return [];
    if (this.#d.repos.rooms.list().some((r) => r.groupId === groupId)) return [];
    const orphaned = session.liveEntries().map(toEntryAdmin);
    session.close();
    this.#sessions.delete(groupId);
    const { repos } = this.#d;
    repos.queue.deleteGroup(groupId);
    repos.session.delete(groupId);
    repos.groups.delete(groupId);
    for (const l of this.#changeListeners) l(groupId);
    return orphaned;
  }

  /** Revoked device: drops its room (and its own group, if it had one). */
  removeRoom(deviceId: string): void {
    const row = this.#d.repos.rooms.get(deviceId);
    const session = this.sessionOfPlayer(deviceId);
    if (session.hasPlayer(deviceId)) session.detachPlayer(deviceId);
    if (row === null) return;
    this.#d.repos.rooms.delete(deviceId);
    if (row.groupId !== MAIN_GROUP_ID) this.#dropGroup(row.groupId);
  }

  rooms(): Room[] {
    return this.#d.repos.rooms.list().map(toRoom);
  }

  groups(): Group[] {
    return this.#d.repos.groups.list().map((g) => ({
      groupId: g.groupId,
      name: g.groupId === MAIN_GROUP_ID ? this.#d.settings.data().roomName : g.name,
      leaderDeviceId: this.#sessions.get(g.groupId)?.leaderId() ?? null,
    }));
  }

  /** Persists each group's live leader (for the replica). */
  saveLeaders(): void {
    for (const g of this.#d.repos.groups.list()) {
      const live = this.#sessions.get(g.groupId)?.leaderId() ?? null;
      if (live !== g.leaderDeviceId) this.#d.repos.groups.setLeader(g.groupId, live);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Fan-out helpers

  /** Every group's players (the admin page lists them all). */
  players(): PlayerInfo[] {
    return this.sessions().flatMap((s) => s.players());
  }

  adminState(groupId?: string | null): AdminState {
    return { ...this.resolve(groupId).toAdminState(), players: this.players() };
  }

  /** Forget me: database once, every session's live state. */
  forgetGuest(guestId: string): void {
    this.main.forgetGuest(guestId);
    for (const s of this.#sessions.values()) if (s !== this.main) s.stripGuest(guestId);
    this.#d.repos.tombstones.add('guests', guestId, this.#d.now());
  }

  sweep(): void {
    for (const s of this.#sessions.values()) s.sweep();
  }

  touchAll(): void {
    for (const s of this.#sessions.values()) s.touch();
  }

  close(): void {
    for (const s of this.#sessions.values()) s.close();
  }
}
