import {
  ChecklistPatchSchema,
  type ReleaseNotesReply,
  type UpdateStatus,
} from '@room-jukebox/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext, UpdaterApi } from '../context.ts';
import { requireAdmin } from '../context.ts';
import { HttpError, parse } from '../errors.ts';

const ModeBodySchema = z.object({ mode: z.enum(['immediate', 'quiet', 'off']) });
const FeedBodySchema = z.object({
  feed: z.enum(['tango', 'github']),
  url: z.url().optional(),
});

/** What `GET /api/admin/update-status` reports when the server runs without the desktop. */
export function standaloneUpdateStatus(version: string): UpdateStatus {
  return {
    mode: 'off',
    feed: 'tango',
    feedUrl: '',
    state: 'idle',
    current: version,
    available: null,
    message: 'Updater not available (standalone server)',
    lastCheckAt: null,
  };
}

/** M1.5: release notes, the owner's test checklist and the desktop updater controls. */
export async function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  installedVersion: string,
): Promise<void> {
  const updater = (): UpdaterApi => {
    if (ctx.updater === null) {
      throw new HttpError(503, 'updater-unavailable', 'Updates are only available in the hub app.');
    }
    return ctx.updater;
  };
  /** Runs an updater action; its failure becomes a 502 carrying the updater's message. */
  const act = async (name: string, fn: (u: UpdaterApi) => void | Promise<void>, detail = {}) => {
    const u = updater();
    ctx.repos.events.append('admin.update', { action: name, ...detail }, ctx.now());
    try {
      await fn(u);
    } catch (err) {
      throw new HttpError(502, 'update-failed', err instanceof Error ? err.message : String(err));
    }
    return u.status();
  };

  app.get('/api/admin/release-notes', async (request): Promise<ReleaseNotesReply> => {
    requireAdmin(ctx, request);
    return {
      notes: ctx.releaseNotes,
      checklist: ctx.settings.checklist(installedVersion),
      installedVersion,
    };
  });

  app.patch('/api/admin/checklist', async (request) => {
    requireAdmin(ctx, request);
    const patch = parse(ChecklistPatchSchema, request.body);
    if (patch.version !== installedVersion) {
      throw new HttpError(
        409,
        'version-mismatch',
        `This checklist is for ${patch.version}; the hub runs ${installedVersion}. Reload the page.`,
      );
    }
    return ctx.settings.patchChecklist(patch);
  });

  app.get('/api/admin/update-status', async (request): Promise<UpdateStatus> => {
    requireAdmin(ctx, request);
    return ctx.updater?.status() ?? standaloneUpdateStatus(installedVersion);
  });

  app.post('/api/admin/update/check', async (request) => {
    requireAdmin(ctx, request);
    return act('check', (u) => u.checkNow());
  });

  app.post('/api/admin/update/install', async (request) => {
    requireAdmin(ctx, request);
    return act('install', (u) => u.installNow());
  });

  app.post('/api/admin/update/mode', async (request) => {
    requireAdmin(ctx, request);
    const { mode } = parse(ModeBodySchema, request.body);
    return act('mode', (u) => u.setMode(mode), { mode });
  });

  app.post('/api/admin/update/feed', async (request) => {
    requireAdmin(ctx, request);
    const { feed, url } = parse(FeedBodySchema, request.body);
    return act('feed', (u) => (url === undefined ? u.setFeed(feed) : u.setFeed(feed, url)), {
      feed,
    });
  });
}
