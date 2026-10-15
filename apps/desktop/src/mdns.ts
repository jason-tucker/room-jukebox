import multicastDns from 'multicast-dns';

/** The fixed name phones on the same network can try without any router setup. */
export const MDNS_NAME = 'jukebox.local';

export interface MdnsQuestion {
  name: string;
  type: string;
}

export interface MdnsAnswer {
  name: string;
  type: 'A';
  ttl: number;
  data: string;
  flush: boolean;
}

/** The names this hub answers: `jukebox.local`, plus the friendly host when it ends in `.local`. */
export function mdnsNames(friendlyHost: string | null): string[] {
  const names = [MDNS_NAME];
  if (friendlyHost !== null && friendlyHost.endsWith('.local') && friendlyHost !== MDNS_NAME) {
    names.push(friendlyHost);
  }
  return names;
}

/** A answers for the questions that ask for one of `names` (A or ANY), case-insensitively. */
export function buildAnswers(
  questions: readonly MdnsQuestion[],
  names: readonly string[],
  address: string,
): MdnsAnswer[] {
  const mine = new Set(names.map((n) => n.toLowerCase()));
  const out: MdnsAnswer[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const name = q.name.toLowerCase();
    if (!mine.has(name) || seen.has(name)) continue;
    if (q.type !== 'A' && q.type !== 'ANY') continue;
    seen.add(name);
    out.push({ name: q.name, type: 'A', ttl: 120, data: address, flush: true });
  }
  return out;
}

/** The slice of the `multicast-dns` socket the responder uses (so tests can fake it). */
export interface MdnsSocket {
  on(event: 'query', listener: (query: { questions: MdnsQuestion[] }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  respond(response: { answers: MdnsAnswer[] }): void;
  destroy(): void;
}

export interface MdnsOptions {
  /** The hub's current LAN address (re-read per query: networks change). */
  address: () => string;
  /** The friendly host from settings (re-read per query). */
  friendlyHost: () => string | null;
  log: { info(msg: string): void; warn(msg: string): void };
  socket?: MdnsSocket;
}

/** Answers mDNS A queries for `jukebox.local` (and a `.local` friendly host). Call `stop()` on quit. */
export function startMdns(opts: MdnsOptions): { stop(): void } {
  let socket: MdnsSocket;
  try {
    socket = opts.socket ?? (multicastDns() as unknown as MdnsSocket);
  } catch (err) {
    opts.log.warn(`mDNS responder could not start: ${String(err)}`);
    return { stop() {} };
  }
  let warned = false;
  socket.on('error', (err) => {
    if (warned) return;
    warned = true;
    opts.log.warn(`mDNS responder error: ${err.message}`);
  });
  socket.on('query', (query) => {
    const answers = buildAnswers(query.questions, mdnsNames(opts.friendlyHost()), opts.address());
    if (answers.length > 0) socket.respond({ answers });
  });
  opts.log.info(
    `mDNS: answering ${mdnsNames(opts.friendlyHost()).join(', ')} -> ${opts.address()}`,
  );
  return {
    stop() {
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    },
  };
}
