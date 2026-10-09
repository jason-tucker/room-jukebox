import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';

describe('parseArgs', () => {
  it('defaults to fullscreen hub mode', () => {
    expect(parseArgs(['.', '--some-chromium-flag'])).toEqual({
      mode: 'hub',
      hub: undefined,
      display: undefined,
      kiosk: false,
      fullscreen: true,
      occlusionFix: false,
    });
  });

  it('parses player mode with hub, display, kiosk and occlusion fix', () => {
    expect(
      parseArgs([
        '--mode=player',
        '--hub=http://192.168.1.20:8080/',
        '--display=2779098405',
        '--kiosk',
        '--occlusion-fix',
      ]),
    ).toEqual({
      mode: 'player',
      hub: 'http://192.168.1.20:8080',
      display: 2779098405,
      kiosk: true,
      fullscreen: true,
      occlusionFix: true,
    });
  });

  it('rejects player mode without a hub and unknown modes', () => {
    expect(() => parseArgs(['--mode=player'])).toThrow(/--hub/);
    expect(() => parseArgs(['--mode=tv'])).toThrow(/--mode/);
  });
});
