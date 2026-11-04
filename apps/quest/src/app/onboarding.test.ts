import { describe, expect, it } from 'vitest';
import { HelperOnboarding, type HelperDevice } from './onboarding';

const urls = ['http://localhost:8797/pair', 'http://192.168.1.10:8797/pair'];
const mac: HelperDevice = { deviceId: 'mac', name: 'My laptop', kind: 'mac', online: true };

describe('helper onboarding', () => {
  it('starts annotation guidance without opening or scanning helper pairing when no Mac is online', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [] }, 0);
    expect(flow.visible).toBe(false);
    flow.enter(0);
    expect(flow.state).toBe('hidden');
    expect(flow.urls).toEqual(urls);
    flow.scan();
    flow.updateUrls(urls, 100);
    flow.updateHelpers([], 200);
    flow.tick(60_000);
    expect(flow.visible).toBe(false);
    expect(flow.scanning).toBe(false);
    expect(flow.guide(0)).toMatchObject({ step: 'tag', message: 'Boxes appear on devices. Pinch one to tag it.' });
    expect(flow.guide(1)?.step).toBe('use');
  });

  it('shows the server URLs and scans without a timeout after an explicit Pair action', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [] }, 0);
    flow.enter(0); flow.show(); flow.scan();
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
    flow.show();
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
    flow.show();
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
    expect(flow.state).toBe('hidden');
    expect(flow.guide(0)?.step).toBe('tag');
  });

  it('counts the sim as a helper only for the sim camera', () => {
    for (const allowSim of [false, true]) {
      const flow = new HelperOnboarding(allowSim);
      flow.update({ urls, helpers: [{ ...mac, kind: 'sim' }] }, 0);
      flow.enter(0);
      expect(flow.visible).toBe(false);
      expect(!!flow.online).toBe(allowSim);
    }
  });

  it('guides pairing, tagging, and explicit Control and Set up without advancing automatically', () => {
    const flow = new HelperOnboarding();
    flow.enter(0);
    expect(flow.guide(0)?.step).toBe('tag');
    flow.update({ urls, helpers: [] }, 1);
    expect(flow.guide(0)?.step).toBe('tag');
    flow.show();
    expect(flow.guide(0)).toBeNull();
    flow.scan();
    flow.updateHelpers([mac], 100);
    expect(flow.guide(0)).toBeNull();
    flow.tick(1600);
    expect(flow.guide(0)).toMatchObject({ step: 'tag', message: 'Boxes appear on devices. Pinch one to tag it.' });
    expect(flow.guide(1)).toMatchObject({ step: 'use', message: 'Open the wrist menu and choose Control, then Set up on your device.' });
    flow.tick(60_000);
    expect(flow.guide(1)?.step).toBe('use');
    flow.chooseControl();
    expect(flow.guide(1)).toBeNull();
    expect(flow.guide(0)).toBeNull();
    flow.leave();
    flow.enter(70_000);
    expect(flow.guide(0)?.step).toBe('tag');
  });

  it('continues with tagging after Skip and hides the guide outside AR', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [] }, 0);
    flow.enter(0);
    flow.skip();
    expect(flow.guide(0)?.step).toBe('tag');
    flow.updateHelpers([], 1000);
    expect(flow.guide(1)?.step).toBe('use');
    flow.show();
    expect(flow.guide(1)).toBeNull();
    flow.skip();
    flow.leave();
    expect(flow.guide(1)).toBeNull();
  });

  it('can pair another helper explicitly without accepting an existing helper as success', () => {
    const flow = new HelperOnboarding();
    flow.update({ urls, helpers: [mac] }, 0);
    flow.enter(0);
    expect(flow.guide(0)?.step).toBe('tag');
    flow.show(true);
    flow.scan();
    flow.updateHelpers([mac], 100);
    flow.updateUrls(urls, 500);
    expect(flow.state).toBe('scanning');
    expect(flow.guide(0)).toBeNull();
    flow.updateHelpers([mac, { ...mac, deviceId: 'second', name: 'Second laptop' }], 1000);
    expect(flow.state).toBe('paired');
    expect(flow.pairedName).toBe('Second laptop');
    flow.tick(2500);
    expect(flow.guide(0)?.step).toBe('tag');
  });
});
