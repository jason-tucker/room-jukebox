import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { beaconInterfaces } from './net';
import type { BeaconInterface } from './net';

export const BEACON_PORT = 41234;
const INTERVAL_MS = 2000;
const LOG_EVERY_MS = 30_000;

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** M0 beacon. Unsigned; M2 adds the household-key signature and hubEpoch. */
export interface Beacon {
  type: 'beacon';
  hubId: string;
  roomName: string;
  address: string;
  port: number;
  version: string;
  protocolVersion: number;
  counter: number;
  bootId: string;
}

export interface BroadcasterOptions {
  hubId: string;
  bootId: string;
  roomName: string;
  port: number;
  version: string;
  protocolVersion: number;
  log: Logger;
  beaconPort?: number;
  /** Injected for tests; defaults to `os.networkInterfaces()`. */
  listInterfaces?: () => BeaconInterface[];
}

interface IfaceSocket {
  iface: BeaconInterface;
  socket: dgram.Socket;
  ready: boolean;
}

/**
 * Sends a beacon every 2 s from one socket per non-internal IPv4 interface, bound to that
 * interface's address (ephemeral port), to the interface's directed broadcast address. Windows
 * would otherwise route a limited broadcast out of a single adapter chosen by metric.
 */
export function startBroadcaster(opts: BroadcasterOptions): { stop(): void } {
  const beaconPort = opts.beaconPort ?? BEACON_PORT;
  const list = opts.listInterfaces ?? (() => beaconInterfaces(networkInterfaces()));
  let sockets: IfaceSocket[] = [];
  let key = '';
  let counter = 0;

  const rebuild = (ifaces: BeaconInterface[]): void => {
    for (const s of sockets) s.socket.close();
    sockets = ifaces.map((iface) => {
      const socket = dgram.createSocket({ type: 'udp4' });
      const entry: IfaceSocket = { iface, socket, ready: false };
      socket.on('error', (err) => {
        opts.log.warn(`beacon socket ${iface.name} ${iface.address}: ${err.message}`);
      });
      socket.bind({ address: iface.address, port: 0 }, () => {
        socket.setBroadcast(true);
        entry.ready = true;
      });
      return entry;
    });
    opts.log.info(
      'beacon interfaces',
      ifaces.map((i) => `${i.name} ${i.address}/${i.netmask} -> ${i.broadcast}`),
    );
  };

  const tick = (): void => {
    const ifaces = list();
    const nextKey = ifaces.map((i) => `${i.name}|${i.address}|${i.broadcast}`).join(',');
    if (nextKey !== key) {
      key = nextKey;
      rebuild(ifaces);
    }
    counter += 1;
    for (const { iface, socket, ready } of sockets) {
      if (!ready) continue;
      const beacon: Beacon = {
        type: 'beacon',
        hubId: opts.hubId,
        roomName: opts.roomName,
        address: iface.address,
        port: opts.port,
        version: opts.version,
        protocolVersion: opts.protocolVersion,
        counter,
        bootId: opts.bootId,
      };
      socket.send(JSON.stringify(beacon), beaconPort, iface.broadcast, (err) => {
        if (err) opts.log.warn(`beacon send ${iface.name} -> ${iface.broadcast}: ${err.message}`);
      });
    }
  };

  tick();
  const timer = setInterval(tick, INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      for (const s of sockets) s.socket.close();
      sockets = [];
    },
  };
}

export interface ReceivedBeacon {
  beacon: Beacon;
  from: string;
  receivedAt: string;
}

function isBeacon(value: unknown): value is Beacon {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'beacon' &&
    typeof v.hubId === 'string' &&
    typeof v.address === 'string' &&
    typeof v.port === 'number' &&
    typeof v.counter === 'number' &&
    typeof v.bootId === 'string'
  );
}

/** Listens on 0.0.0.0:<beaconPort> (reuseAddr) in both modes and keeps the last beacon. */
export function startListener(opts: { log: Logger; beaconPort?: number }): {
  last(): ReceivedBeacon | null;
  stop(): void;
} {
  const beaconPort = opts.beaconPort ?? BEACON_PORT;
  let last: ReceivedBeacon | null = null;
  const lastLogged = new Map<string, number>();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => opts.log.error(`beacon listener: ${err.message}`));
  socket.on('message', (msg, rinfo) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!isBeacon(parsed)) return;
    last = { beacon: parsed, from: rinfo.address, receivedAt: new Date().toISOString() };
    const logKey = `${parsed.hubId}|${rinfo.address}`;
    const now = Date.now();
    if (now - (lastLogged.get(logKey) ?? 0) >= LOG_EVERY_MS) {
      lastLogged.set(logKey, now);
      opts.log.info(`beacon from ${rinfo.address}:${rinfo.port}`, parsed);
    }
  });
  socket.bind({ address: '0.0.0.0', port: beaconPort }, () => {
    opts.log.info(`beacon listener on 0.0.0.0:${beaconPort}`);
  });

  return {
    last: () => last,
    stop: () => socket.close(),
  };
}
