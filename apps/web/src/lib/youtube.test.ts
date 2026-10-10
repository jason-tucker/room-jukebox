import { describe, expect, it } from 'vitest';
import { parseYouTubeInput } from './youtube.ts';

describe('parseYouTubeInput', () => {
  it.each([
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['Check out this video! https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('%s', (input, id) => {
    expect(parseYouTubeInput(input)).toBe(id);
  });

  it.each([
    '',
    'hello world',
    'https://vimeo.com/123',
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/short',
  ])('rejects %s', (input) => {
    expect(parseYouTubeInput(input)).toBeNull();
  });
});
