import { describe, expect, it } from 'vitest';
import { canvasIdentity, isHeadsetCanvas, prefilledPrompt, questReturnUrl } from './navigation';

const mac = { deviceId: 'm', deviceToken: 'mac-token', kind: 'mac', name: 'Mac' };
const quest = { deviceId: 'q', deviceToken: 'quest-token', kind: 'quest', name: 'Quest' };
const storage = (values: Record<string, unknown>) => ({ getItem: (key: string) => key in values ? JSON.stringify(values[key]) : null });
describe('headset Canvas navigation and identity', () => {
  it('reuses the headset identity without borrowing a Mac identity in a shared test browser', () => {
    expect(canvasIdentity(storage({ 'ce.device': quest }), true)).toEqual(quest);
    const shared = storage({ 'ce.device': mac, 'ce.device.quest': quest });
    expect(canvasIdentity(shared, true)).toEqual(quest);
    expect(canvasIdentity(shared, false)).toEqual(mac);
    expect(canvasIdentity(storage({ 'ce.device': mac }), true)).toBeUndefined();
    expect(canvasIdentity(storage({ 'ce.device.quest': mac }), true)).toBeUndefined();
  });
  it('tolerates missing or invalid identity storage and keeps return navigation local', () => {
    expect(canvasIdentity({ getItem: () => '{oops' }, true)).toBeUndefined();
    expect(canvasIdentity({ getItem: () => { throw new Error('blocked'); } }, true)).toBeUndefined();
    const url = new URL(questReturnUrl('https://example.test/?foo=bar'), 'https://app.test');
    expect(url.origin).toBe('https://app.test'); expect(url.pathname).toBe('/quest/');
    expect(url.searchParams.get('canvasProject')).toBe('https://example.test/?foo=bar');
  });
  it('detects the headset route and bounds prefilled request data without executing it', () => {
    expect(isHeadsetCanvas('?headset=1')).toBe(true);
    expect(isHeadsetCanvas('', 'OculusBrowser')).toBe(true);
    expect(isHeadsetCanvas('', 'Chrome')).toBe(false);
    expect(prefilledPrompt('?prompt=' + encodeURIComponent('<script>alert(1)</script>'))).toBe('<script>alert(1)</script>');
    expect(prefilledPrompt('?prompt=' + 'x'.repeat(5000))).toHaveLength(4000);
  });
});
