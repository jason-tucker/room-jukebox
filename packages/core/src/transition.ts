/**
 * Single transition rule (plan §3.4): an `ended`/`error` event carries the revision the player saw;
 * the transition commits only when it matches the current revision, and committing bumps the
 * revision. Duplicate and late events therefore can never advance twice.
 */
export interface Revisioned {
  revision: number;
}

export interface TransitionResult<S> {
  state: S;
  committed: boolean;
}

/**
 * Applies an `ended` (or `error`) report. `advance` produces the next track's state; its
 * `revision` field is ignored and replaced by `state.revision + 1`.
 */
export function applyEnded<S extends Revisioned>(
  state: S,
  revisionFromClient: number,
  advance: (state: S) => S,
): TransitionResult<S> {
  if (revisionFromClient !== state.revision) return { state, committed: false };
  return { state: { ...advance(state), revision: state.revision + 1 }, committed: true };
}
