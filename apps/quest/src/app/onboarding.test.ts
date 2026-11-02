import { describe, expect, it } from 'vitest';
import { HelperOnboarding, type HelperDevice } from './onboarding';

const urls = ['http://localhost:8797/pair', 'http://192.168.1.10:8797/pair'];
const mac: HelperDevice = { deviceId: 'mac', name: 'My laptop', kind: 'mac', online: true };

describe('helper onboarding', () => {
  it('shows the server URLs on AR entry and scans without a timeout', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [] }, 0);
    expect(flow.visible).toBe(false);
    flow.enter(0);
    expect(flow.state).toBe('shown');
    expect(flow.urls).toEqual(urls);
    flow.scan();
    for (const time of [500, 30_001, 3_600_000]) flow.tick(time);
    expect(flow.state).toBe('scanning');
    expect(flow.scanning).toBe(true);
    flow.leave();
    expect(flow.scanning).toBe(false);
    expect(flow.visible).toBe(false);
  });

  it('waits for an online helper, shows success for 1.5 seconds, then stays closed', () => {
    const flow = new HelperOnboarding();
    flow.enter(0);
    flow.update({ urls, helpers: [{ ...mac, online: false }] }, 0);
    flow.scan();
    expect(flow.state).toBe('scanning');
    flow.updateHelpers([mac], 100);
    expect(flow.state).toBe('paired');
    expect(flow.pairedName).toBe('My laptop');
    expect(flow.scanning).toBe(false);
    flow.tick(1599);
    expect(flow.visible).toBe(true);
    flow.tick(1600);
    expect(flow.visible).toBe(false);
    flow.updateHelpers([mac], 2000);
    flow.enter(3000);
    expect(flow.visible).toBe(false);
  });

  it('Skip lasts for this session, while an explicit Pair can reopen it', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [] }, 0);
    flow.enter(0);
    flow.scan();
    const generation = flow.generation;
    flow.skip();
    flow.updateHelpers([], 60_000);
    expect(flow.state).toBe('skipped');
    expect(flow.scanning).toBe(false);
    expect(flow.generation).toBeGreaterThan(generation);
    flow.show(); flow.scan();
    expect(flow.scanning).toBe(true);
    flow.skip(); flow.leave(); flow.enter(70_000);
    expect(flow.state).toBe('shown');
  });

  it('counts the sim as a helper only for the sim camera', () => {
    for (const allowSim of [false, true]) {
      const flow = new HelperOnboarding(allowSim);
      flow.update({ urls, helpers: [{ ...mac, kind: 'sim' }] }, 0);
      flow.enter(0);
      expect(flow.visible).toBe(!allowSim);
    }
  });
});
