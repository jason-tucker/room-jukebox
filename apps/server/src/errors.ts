import type { ApiError } from '@room-jukebox/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { z } from 'zod';

/** A 4xx/5xx carried to the client as the contract's ApiError envelope. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(statusCode: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }

  toBody(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}),
      },
    };
  }
}

/** Validates `data` with `schema`; throws 400 `bad-request` with the first issue. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'bad-request', `${where}${issue?.message ?? 'invalid request'}`);
  }
  return r.data;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) {
      if (err.retryAfterSec !== undefined) reply.header('Retry-After', String(err.retryAfterSec));
      return reply.code(err.statusCode).send(err.toBody());
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'request failed');
    const body: ApiError = {
      error: {
        code: status >= 500 ? 'internal' : 'bad-request',
        message: status >= 500 ? 'Something went wrong on the hub.' : err.message,
      },
    };
    return reply.code(status).send(body);
  });
}
