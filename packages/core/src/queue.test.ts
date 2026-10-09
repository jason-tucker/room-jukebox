import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Queue } from './queue.ts';

type Item = { id: string };

describe('Queue', () => {
  it('returns items in FIFO order', () => {
    const q = new Queue<Item>();
    q.enqueue({ id: 'a' });
    q.enqueue({ id: 'b' });
    q.enqueue({ id: 'c' });
    expect(q.next()?.id).toBe('a');
    expect(q.next()?.id).toBe('b');
    expect(q.next()?.id).toBe('c');
    expect(q.next()).toBeUndefined();
  });

  it('next() bumps the revision exactly once', () => {
    const q = new Queue<Item>();
    q.enqueue({ id: 'a' });
    const before = q.revision;
    q.next();
    expect(q.revision).toBe(before + 1);
  });

  it('next() on an empty queue does not bump the revision', () => {
    const q = new Queue<Item>();
    q.next();
    expect(q.revision).toBe(0);
  });

  it('remove() drops the matching item only', () => {
    const q = new Queue<Item>();
    q.enqueue({ id: 'a' });
    q.enqueue({ id: 'b' });
    expect(q.remove('a')).toBe(true);
    expect(q.remove('missing')).toBe(false);
    expect(q.toArray().map((i) => i.id)).toEqual(['b']);
  });

  it('property: draining returns exactly what was enqueued, in order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 })), (ids) => {
        const q = new Queue<Item>();
        for (const id of ids) q.enqueue({ id });
        const drained: string[] = [];
        for (let item = q.next(); item !== undefined; item = q.next()) drained.push(item.id);
        expect(drained).toEqual(ids);
        expect(q.revision).toBe(ids.length * 2);
      }),
    );
  });
});
