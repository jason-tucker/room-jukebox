import { describe, expect, it } from 'vitest';
import { beaconInterfaces, directedBroadcast } from '../src/net';

describe('directedBroadcast', () => {
  it.each([
    ['192.168.1.20', '255.255.255.0', '192.168.1.255'],
    ['10.0.5.9', '255.0.0.0', '10.255.255.255'],
    ['172.16.33.4', '255.255.240.0', '172.16.47.255'],
    ['192.168.50.130', '255.255.255.128', '192.168.50.255'],
    ['192.168.50.12', '255.255.255.128', '192.168.50.127'],
    ['100.101.102.103', '255.192.0.0', '100.127.255.255'],
    ['255.255.255.254', '255.255.255.252', '255.255.255.255'],
  ])('%s/%s -> %s', (address, netmask, expected) => {
    expect(directedBroadcast(address, netmask)).toBe(expected);
  });

  it('rejects malformed input', () => {
    expect(() => directedBroadcast('192.168.1', '255.255.255.0')).toThrow();
    expect(() => directedBroadcast('192.168.1.300', '255.255.255.0')).toThrow();
  });
});

describe('beaconInterfaces', () => {
  it('keeps non-internal IPv4 interfaces and skips loopback, IPv6 and /32', () => {
    const result = beaconInterfaces({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '',
          internal: true,
          cidr: null,
        },
      ],
      'Wi-Fi': [
        {
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: null,
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '',
          internal: false,
          cidr: null,
          scopeid: 1,
        },
      ],
      vpn: [
        {
          address: '10.8.0.2',
          netmask: '255.255.255.255',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: null,
        },
      ],
      'vEthernet (WSL)': [
        {
          address: '172.20.48.1',
          netmask: '255.255.240.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: null,
        },
      ],
    });
    expect(result).toEqual([
      {
        name: 'Wi-Fi',
        address: '192.168.1.20',
        netmask: '255.255.255.0',
        broadcast: '192.168.1.255',
      },
      {
        name: 'vEthernet (WSL)',
        address: '172.20.48.1',
        netmask: '255.255.240.0',
        broadcast: '172.20.63.255',
      },
    ]);
  });
});
