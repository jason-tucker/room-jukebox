import pino from 'pino';
import { buildApp } from './app.ts';

const port = Number.parseInt(process.env.LAN_PORT ?? '8080', 10);
const host = '0.0.0.0';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = await buildApp({ loggerInstance: logger });

try {
  await app.listen({ port, host });
} catch (err) {
  logger.error(err, 'failed to start server');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
