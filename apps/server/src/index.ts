/**
 * Standalone server (development and the later Docker image). Environment:
 *   LAN_PORT   listen port (default 8080)
 *   HOST       listen address (default 0.0.0.0)
 *   DATA_DIR   database and backups (default ./data)
 *   WEB_ROOT   built SPA directory (default ../web/dist)
 *   LOG_LEVEL  pino level (default info)
 *   LOG_FILE   also append logs to this file (enables /api/admin/logs/tail)
 *   SPIKE=1    mount the M0 spike routes (SPIKE_DATA_DIR for its results)
 * Secrets are stored as given (no safeStorage outside Electron).
 */
import pino from 'pino';
import { buildApp } from './app.ts';

const port = Number.parseInt(process.env.LAN_PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const logFile = process.env.LOG_FILE;

const level = process.env.LOG_LEVEL ?? 'info';
const logger = logFile
  ? pino(
      { level },
      pino.multistream([
        { level, stream: process.stdout },
        { level, stream: pino.destination({ dest: logFile, mkdir: true, sync: false }) },
      ]),
    )
  : pino({ level });

const app = await buildApp({
  loggerInstance: logger,
  dataDir: process.env.DATA_DIR ?? './data',
  ...(process.env.WEB_ROOT ? { webRoot: process.env.WEB_ROOT } : {}),
  ...(logFile ? { logFile } : {}),
  spike: process.env.SPIKE === '1',
});

try {
  await app.listen({ port, host });
} catch (err) {
  logger.error(err, 'failed to start server');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    // onClose checkpoints the WAL and closes the database.
    void app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error(err, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
