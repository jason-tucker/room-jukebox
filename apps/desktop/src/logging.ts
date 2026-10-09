import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';

const MAX_FILES = 10;

/** electron-log v5 to `<logsDir>/main.log`, rotated at 10 MB keeping 10 files (main.log + main.1..9.log). */
export function setupLogging(logsDir: string): typeof log {
  log.transports.file.resolvePathFn = () => join(logsDir, 'main.log');
  log.transports.file.maxSize = 10 * 1024 * 1024;
  log.transports.file.archiveLogFn = (oldLog) => {
    const base = oldLog.path.replace(/\.log$/, '');
    try {
      rmSync(`${base}.${MAX_FILES - 1}.log`, { force: true });
      for (let i = MAX_FILES - 2; i >= 1; i -= 1) {
        if (existsSync(`${base}.${i}.log`)) renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`);
      }
      renameSync(oldLog.path, `${base}.1.log`);
    } catch (err) {
      console.error('log rotation failed', err);
    }
  };
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  return log;
}
