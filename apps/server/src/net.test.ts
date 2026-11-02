import { describe, expect, it } from 'vitest';
import { helperPairUrls } from './net';

describe('helper pairing URLs', () => {
  it('puts localhost first, the first LAN address next, and the local hostname last', () => {
    expect(helperPairUrls(9876, ['192.168.1.20', '10.0.0.3'], ['localhost', 'Studio-Mac', 'Studio-Mac.local'])).toEqual([
      'http://localhost:9876/pair', 'http://192.168.1.20:9876/pair', 'http://Studio-Mac.local:9876/pair',
    ]);
  });

  it('omits unavailable LAN and local hostname choices', () => {
    expect(helperPairUrls(8787, [], ['localhost'])).toEqual(['http://localhost:8787/pair']);
    expect(helperPairUrls(8787, ['192.168.1.20'], [])).toEqual(['http://localhost:8787/pair', 'http://192.168.1.20:8787/pair']);
    expect(helperPairUrls(8787, [], ['localhost', 'localhost.local'])).toEqual(['http://localhost:8787/pair']);
  });

  it('keeps an existing .local hostname and does not repeat addresses', () => {
    expect(helperPairUrls(8787, ['192.168.1.20'], ['Studio.local', 'Studio.local'])).toEqual([
      'http://localhost:8787/pair', 'http://192.168.1.20:8787/pair', 'http://Studio.local:8787/pair',
    ]);
  });
});
