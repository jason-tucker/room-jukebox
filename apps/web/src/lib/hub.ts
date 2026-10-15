/** Default hub port (settings.lanPort). */
export const DEFAULT_HUB_PORT = 8080;

/**
 * What the owner typed for a hub address, as a base URL: `192.168.1.20` →
 * `http://192.168.1.20:8080`, `http://jukebox.home:9000/` → `http://jukebox.home:9000`.
 * null when it is not a usable address.
 */
export function normalizeHubAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const port = url.port || (/^https:/i.test(withScheme) ? '' : String(DEFAULT_HUB_PORT));
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}`;
}

/** `http://192.168.1.20:8080` → `192.168.1.20:8080`. */
export function displayHubAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
