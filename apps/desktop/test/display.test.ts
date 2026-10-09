import { describe, expect, it } from 'vitest';
import { pickTvDisplay } from '../src/display';

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, internal: true };
const tv = { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 } };
const monitor = { id: 3, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } };

describe('pickTvDisplay', () => {
  it('uses the only display when nothing else is connected', () => {
    expect(pickTvDisplay([laptop], 1)).toBe(laptop);
  });

  it('prefers the first non-primary display', () => {
    expect(pickTvDisplay([laptop, tv], 1)).toBe(tv);
    expect(pickTvDisplay([laptop, monitor, tv], 1)).toBe(monitor);
  });

  it('treats an external primary correctly (laptop screen becomes the TV choice)', () => {
    expect(pickTvDisplay([laptop, tv], 2)).toBe(laptop);
  });

  it('honours a connected override, including the primary', () => {
    expect(pickTvDisplay([laptop, monitor, tv], 1, 2)).toBe(tv);
    expect(pickTvDisplay([laptop, tv], 1, 1)).toBe(laptop);
  });

  it('falls back to the automatic choice when the override is disconnected', () => {
    expect(pickTvDisplay([laptop, tv], 1, 99)).toBe(tv);
  });

  it('returns undefined for no displays', () => {
    expect(pickTvDisplay([], 1)).toBeUndefined();
  });
});
