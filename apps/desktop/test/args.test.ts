import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';

describe('parseArgs', () => {
  it('defaults to the saved mode (undefined) in fullscreen', () => {
    expect(parseArgs(['.', '--some-chromium-flag'])).toEqual({
      mode: undefined,
      hub: undefined,
      display: undefined,
      kiosk: false,
      fullscreen: true,
      occlusionFix: false,
      loopback: 'localhost',
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
      loopback: 'localhost',
    });
  });

  it('accepts player mode without a hub (saved hub address); rejects bad hubs and modes', () => {
    expect(parseArgs(['--mode=player']).mode).toBe('player');
    expect(parseArgs(['--mode=hub']).mode).toBe('hub');
    expect(() => parseArgs(['--hub=192.168.1.20:8080'])).toThrow(/--hub/);
    expect(() => parseArgs(['--hub=http://192.168.1.20:8080/x'])).toThrow(/--hub/);
    expect(() => parseArgs(['--mode=tv'])).toThrow(/--mode/);
  });
});

it('accepts --loopback=127.0.0.1 and rejects other hosts', async () => {
  const { parseArgs } = await import('../src/args.ts');
  expect(parseArgs(['--loopback=127.0.0.1']).loopback).toBe('127.0.0.1');
  expect(() => parseArgs(['--loopback=example.com'])).toThrow(/--loopback/);
});
