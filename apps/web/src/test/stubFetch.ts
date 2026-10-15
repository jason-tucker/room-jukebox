import { vi } from 'vitest';

export type Route = (init: RequestInit) => { status?: number; body: unknown };

/** A fetch stub answering `METHOD url` routes (404 otherwise); records every call. */
export function stubFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    if (!route) return Promise.resolve(new Response('{}', { status: 404 }));
    const { status = 200, body } = route(init);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export type FetchMock = ReturnType<typeof stubFetch>;

/** Calls made to `METHOD url`, as `[url, init]`. */
export const callsTo = (fetchMock: FetchMock, key: string) =>
  (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
    ([url, init]) => `${init?.method ?? 'GET'} ${url}` === key,
  );

/** JSON body of a recorded call. */
export const bodyOf = (call: [string, RequestInit | undefined]) =>
  JSON.parse(String(call[1]?.body)) as unknown;
