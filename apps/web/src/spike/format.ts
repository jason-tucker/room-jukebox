export function fmtSec(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : `${v.toFixed(digits)} s`;
}

export function fmtDrift(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)} s`;
}

/** Stable per-browser player id for a given player name (survives reloads). */
export function stablePlayerId(name: string): string {
  const key = `spike.playerId.${name}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = `${name}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `${name}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function numParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
