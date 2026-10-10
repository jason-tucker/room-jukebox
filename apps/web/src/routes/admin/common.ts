import type { AdminState } from '@room-jukebox/shared';
import type { ApiResult } from '../../lib/api.ts';

/** Runs an admin call: toasts failures (or `ok` on success) and drops to the login form on 401. */
export type Run = <T>(p: Promise<ApiResult<T>>, ok?: string) => Promise<ApiResult<T>>;
export type Push = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface TabProps {
  state: AdminState;
  run: Run;
  push: Push;
  serverNow: () => number;
}
