import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SpikeResultSchema, type SpikeResult } from '@room-jukebox/shared';

/** Append-only JSONL log of spike results (`<dir>/spike-results.jsonl`). */
export class SpikeResults {
  readonly file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, 'spike-results.jsonl');
  }

  /** Serialises writes so concurrent appends never interleave with a clear. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  append(result: SpikeResult): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(result)}\n`, 'utf8');
    });
  }

  /** Parsed results in append order; unparseable lines are skipped. */
  list(): Promise<SpikeResult[]> {
    return this.#enqueue(async () => {
      let text: string;
      try {
        text = await readFile(this.file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const out: SpikeResult[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = SpikeResultSchema.safeParse(JSON.parse(line));
          if (parsed.success) out.push(parsed.data);
        } catch {
          // skip a torn or hand-edited line
        }
      }
      return out;
    });
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      await writeFile(this.file, '', 'utf8');
    });
  }
}
