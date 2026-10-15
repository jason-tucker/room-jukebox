import type { PlayerInfo, Room } from '@room-jukebox/shared';
import { useCallback, useEffect, useState } from 'react';
import { btn, Chip, Section, Spinner } from '../../components/ui.tsx';
import { api, type OrphanedEntry, type ReplicaStatus } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { uuid } from '../../lib/uuid.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';

const T = S.admin.rooms;
/** Rooms and replica status refresh this often while the tab is open. */
export const ROOMS_POLL_MS = 10_000;

/** "Copy … made 9:41 PM; 1 of 2 up to date", or the no-copy line. */
export function replicaLine(r: ReplicaStatus): string {
  if (r.snapshotAt === null || r.snapshotAt === undefined) return T.replicaNone;
  const players = r.players ?? [];
  const ok = players.filter((p) => (p.ackedAt ?? -1) >= r.snapshotAt!).length;
  return T.replica(fmtDateTime(r.snapshotAt), ok, players.length);
}

interface Orphans {
  room: string;
  entries: OrphanedEntry[];
}

/**
 * Admin → Rooms (contract-m2 §3): every room with its health, link state and actions. Link merges
 * a room into the main queue without moving its waiting songs, so the reply's orphaned entries
 * are listed here with a one-tap re-add through the owner request route.
 */
export function RoomsTab({ state, run, push }: TabProps) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [replica, setReplica] = useState<ReplicaStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<Orphans | null>(null);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const load = () => {
      void run(api.admin.rooms()).then((r) => {
        if (live && r.ok) setRooms(r.data.rooms);
      });
      void api.admin.replicaStatus().then((r) => {
        if (live && r.ok) setReplica(r.data);
      });
    };
    load();
    const t = setInterval(load, ROOMS_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [run, reload]);

  const playerOf = (deviceId: string): PlayerInfo | undefined =>
    state.players.find((p) => p.id === deviceId);

  const link = async (room: Room) => {
    if (!window.confirm(T.linkConfirm(room.name))) return;
    setBusy(room.deviceId);
    const r = await run(api.admin.linkRoom(room.deviceId), T.linkedDone(room.name));
    setBusy(null);
    if (!r.ok) return;
    const entries = r.data.orphaned ?? [];
    setOrphans(entries.length > 0 ? { room: room.name, entries } : null);
    refresh();
  };

  const split = async (room: Room) => {
    if (!window.confirm(T.splitConfirm(room.name))) return;
    setBusy(room.deviceId);
    const r = await run(api.admin.splitRoom(room.deviceId), T.splitDone(room.name));
    setBusy(null);
    if (r.ok) refresh();
  };

  const revoke = async (room: Room) => {
    if (!window.confirm(T.revokeConfirm(room.name))) return;
    setBusy(room.deviceId);
    const r = await run(api.admin.revokePlayer(room.deviceId), T.revoked(room.name));
    setBusy(null);
    if (r.ok) refresh();
  };

  const addOrphans = async () => {
    if (!orphans) return;
    setBusy('orphans');
    let added = 0;
    const left: OrphanedEntry[] = [];
    for (const e of orphans.entries) {
      const r = await run(api.admin.request({ videoId: e.videoId, idempotencyKey: uuid() }));
      if (r.ok) added += 1;
      else left.push(e);
    }
    setBusy(null);
    if (added > 0) push(T.orphansAdded(added));
    setOrphans(left.length > 0 ? { ...orphans, entries: left } : null);
  };

  return (
    <>
      <Section title={T.title}>
        {replica && (
          <p data-testid="replica-status" className="text-base text-muted">
            {replicaLine(replica)}
          </p>
        )}
        {rooms === null && <Spinner />}
        {rooms && rooms.length === 0 && <p className="text-base text-muted">{T.none}</p>}
        {rooms && rooms.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rooms.map((room) => {
              const p = playerOf(room.deviceId);
              const isHub = room.deviceId === state.settings.hubId;
              const linked = room.linkState === 'linked';
              return (
                <li
                  key={room.deviceId}
                  data-testid="room-row"
                  className="flex flex-col gap-2 rounded-2xl bg-surface p-3 text-base"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lg font-semibold">{room.name}</span>
                    <span className="flex flex-wrap gap-1">
                      <Chip
                        tone={
                          p?.status === 'online'
                            ? 'accent'
                            : !p || p.status === 'offline'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {S.admin.playerStatus[p?.status ?? 'offline']}
                      </Chip>
                      <Chip>{linked ? T.linked : T.independent}</Chip>
                    </span>
                  </div>
                  <div className="text-muted">
                    {[
                      p ? T.roles[p.role] : null,
                      room.lanAddress,
                      T.seen(fmtDateTime(p?.lastSeen ?? room.lastSeen)),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!isHub &&
                      (linked ? (
                        <button
                          type="button"
                          className={btn.secondary}
                          disabled={busy !== null}
                          aria-label={`${T.split}: ${room.name}`}
                          onClick={() => void split(room)}
                        >
                          {T.split}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={btn.secondary}
                          disabled={busy !== null}
                          aria-label={`${T.link}: ${room.name}`}
                          onClick={() => void link(room)}
                        >
                          {T.link}
                        </button>
                      ))}
                    {!isHub && (
                      <button
                        type="button"
                        className={btn.danger}
                        disabled={busy !== null}
                        aria-label={`${T.revoke}: ${room.name}`}
                        onClick={() => void revoke(room)}
                      >
                        {T.revoke}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {orphans && (
        <Section title={T.orphaned(orphans.room)}>
          <div data-testid="orphaned" className="flex flex-col gap-3">
            <ul className="flex list-disc flex-col gap-1 pl-6 text-base">
              {orphans.entries.map((e, i) => (
                <li key={`${i}-${e.videoId}`}>{e.title}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btn.primary}
                disabled={busy !== null}
                onClick={() => void addOrphans()}
              >
                {busy === 'orphans' ? S.app.working : T.addOrphans}
              </button>
              <button type="button" className={btn.ghost} onClick={() => setOrphans(null)}>
                {T.dismiss}
              </button>
            </div>
          </div>
        </Section>
      )}
    </>
  );
}
