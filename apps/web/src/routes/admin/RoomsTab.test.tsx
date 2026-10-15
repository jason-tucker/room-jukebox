import type { AdminState } from '@room-jukebox/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDateTime } from '../../lib/format.ts';
import { S } from '../../strings.ts';
import { bodyOf, callsTo, stubFetch } from '../../test/stubFetch.ts';
import type { Run } from './common.ts';
import { replicaLine, RoomsTab } from './RoomsTab.tsx';

const T = S.admin.rooms;
const NOW = Date.now();

/** EntryAdmin fields the orphaned list carries (shared **LinkReply**). */
const orphan = {
  requesterName: 'Ann',
  requesterGuestId: 'g1',
  source: 'request' as const,
  status: 'queued' as const,
  enqueuedAt: NOW - 1000,
};

const ROOMS = {
  rooms: [
    {
      deviceId: 'hub1',
      name: 'Basement',
      groupId: 'main',
      linkState: 'linked',
      lanAddress: '192.168.1.20',
      lastSeen: NOW,
    },
    {
      deviceId: 'den',
      name: 'Den',
      groupId: 'main',
      linkState: 'linked',
      lanAddress: '192.168.1.31',
      lastSeen: NOW,
    },
    {
      deviceId: 'garage',
      name: 'Garage',
      groupId: 'g-garage',
      linkState: 'independent',
      lanAddress: null,
      lastSeen: NOW - 60_000,
    },
  ],
  groups: [],
};

const STATE = {
  settings: { hubId: 'hub1' },
  players: [
    {
      id: 'den',
      name: 'Den',
      lanAddress: '192.168.1.31',
      status: 'online',
      role: 'follower',
      lastSeen: NOW,
      drift: 0.1,
    },
    {
      id: 'garage',
      name: 'Garage',
      lanAddress: null,
      status: 'delayed',
      role: 'leader',
      lastSeen: NOW - 60_000,
      drift: null,
    },
  ],
} as unknown as AdminState;

function setup() {
  const fetchMock = stubFetch({
    'GET /api/admin/rooms': () => ({ body: ROOMS }),
    'GET /api/admin/replica/status': () => ({
      body: {
        lastSentAt: NOW - 5000,
        bytes: 2048,
        players: [
          { deviceId: 'den', lastAckAt: NOW - 4900 },
          { deviceId: 'garage', lastAckAt: NOW - 600_000 },
        ],
      },
    }),
    'POST /api/admin/rooms/garage/link': () => ({
      body: {
        room: { ...ROOMS.rooms[2], groupId: 'main', linkState: 'linked' },
        orphaned: [
          { ...orphan, id: 'x1', videoId: 'aaaaaaaaaaa', title: 'Song A' },
          { ...orphan, id: 'x2', videoId: 'bbbbbbbbbbb', title: 'Song B' },
        ],
      },
    }),
    'POST /api/admin/rooms/den/split': () => ({
      body: {
        room: { ...ROOMS.rooms[1], groupId: 'g-den', linkState: 'independent' },
        orphaned: [],
      },
    }),
    'POST /api/admin/players/den/revoke': () => ({ body: { ok: true } }),
    'POST /api/admin/requests': (init) => ({
      status: 201,
      body: {
        entry: {
          id: 'n',
          videoId: (JSON.parse(String(init.body)) as { videoId: string }).videoId,
          title: 't',
          requesterName: 'Owner',
          source: 'request',
          status: 'queued',
          enqueuedAt: 1,
        },
        duplicate: false,
      },
    }),
  });
  const push = vi.fn();
  const run: Run = (p) => p;
  render(<RoomsTab state={STATE} run={run} push={push} serverNow={Date.now} />);
  return { fetchMock, push };
}

const row = (name: string) =>
  screen.getAllByTestId('room-row').find((r) => within(r).queryByText(name) !== null)!;

describe('Admin Rooms tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists rooms with status, role, link state, address and last seen, and the replica line', async () => {
    setup();
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));
    const den = row('Den');
    expect(den).toHaveTextContent(S.admin.playerStatus.online);
    expect(den).toHaveTextContent(T.linked);
    expect(den).toHaveTextContent(T.roles.follower);
    expect(den).toHaveTextContent('192.168.1.31');
    expect(den).toHaveTextContent(T.seen(fmtDateTime(NOW)));
    const garage = row('Garage');
    expect(garage).toHaveTextContent(S.admin.playerStatus.delayed);
    expect(garage).toHaveTextContent(T.independent);
    expect(within(garage).getByRole('button', { name: `${T.link}: Garage` })).toBeInTheDocument();
    // The hub's own room cannot be split, linked or revoked.
    expect(within(row('Basement')).queryAllByRole('button')).toHaveLength(0);
    expect(await screen.findByTestId('replica-status')).toHaveTextContent(
      T.replica(fmtDateTime(NOW - 5000), 1, 2),
    );
  });

  it('Split asks first and explains the room starts its own queue', async () => {
    const { fetchMock } = setup();
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: `${T.split}: Den` }));
    expect(confirm).toHaveBeenCalledWith(T.splitConfirm('Den'));
    expect(callsTo(fetchMock, 'POST /api/admin/rooms/den/split')).toHaveLength(0);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: `${T.split}: Den` }));
    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST /api/admin/rooms/den/split')).toHaveLength(1),
    );
  });

  it('Link lists the orphaned songs and re-adds them to the main queue', async () => {
    const { fetchMock, push } = setup();
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: `${T.link}: Garage` }));
    const panel = await screen.findByTestId('orphaned');
    expect(screen.getByRole('heading', { name: T.orphaned('Garage') })).toBeInTheDocument();
    expect(within(panel).getByText('Song A')).toBeInTheDocument();
    expect(within(panel).getByText('Song B')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: T.addOrphans }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/admin/requests')).toHaveLength(2));
    const bodies = callsTo(fetchMock, 'POST /api/admin/requests').map(bodyOf);
    expect(bodies).toEqual([
      { videoId: 'aaaaaaaaaaa', idempotencyKey: expect.any(String) },
      { videoId: 'bbbbbbbbbbb', idempotencyKey: expect.any(String) },
    ]);
    await waitFor(() => expect(screen.queryByTestId('orphaned')).toBeNull());
    expect(push).toHaveBeenCalledWith(T.orphansAdded(2));
  });

  it('Revoke asks first, explaining the key rotation', async () => {
    const { fetchMock } = setup();
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: `${T.revoke}: Den` }));
    expect(confirm).toHaveBeenCalledWith(T.revokeConfirm('Den'));
    expect(T.revokeConfirm('Den')).toMatch(/household key changes/);
    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST /api/admin/players/den/revoke')).toHaveLength(1),
    );
  });

  it('replicaLine handles no snapshot yet', () => {
    expect(replicaLine({ lastSentAt: null, players: [] })).toBe(T.replicaNone);
    expect(replicaLine({ lastSentAt: 10, players: [] })).toBe(T.replica(fmtDateTime(10), 0, 0));
    expect(
      replicaLine({
        lastSentAt: 10,
        players: [
          { deviceId: 'a', lastAckAt: 11 },
          { deviceId: 'b', lastAckAt: null },
        ],
      }),
    ).toBe(T.replica(fmtDateTime(10), 1, 2));
  });
});
