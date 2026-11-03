import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPreviewPresence } from './presence';

afterEach(() => vi.useRealTimers());
it('leases only an acknowledged preview and stops heartbeat on hide, revision replacement or failed send', () => {
  vi.useFakeTimers(); const send = vi.fn(() => true), presence = new ProjectPreviewPresence(send);
  vi.advanceTimersByTime(6000); expect(send).not.toHaveBeenCalled();
  presence.start({ projectId: 'p1', revision: 1 }); expect(send).toHaveBeenLastCalledWith({ projectId: 'p1', revision: 1, active: true });
  vi.advanceTimersByTime(1500); expect(send).toHaveBeenCalledTimes(2);
  presence.start({ projectId: 'p1', revision: 2 });
  expect(send.mock.calls.slice(-2)).toEqual([[{ projectId: 'p1', revision: 1, active: false }], [{ projectId: 'p1', revision: 2, active: true }]]);
  presence.stop(); const count = send.mock.calls.length; vi.advanceTimersByTime(6000); expect(send).toHaveBeenCalledTimes(count);
  expect(send).toHaveBeenLastCalledWith({ projectId: 'p1', revision: 2, active: false });
  presence.start({ projectId: 'p2', revision: 1 }); send.mockReturnValue(false);
  vi.advanceTimersByTime(1500); const disconnected = send.mock.calls.length;
  vi.advanceTimersByTime(6000); expect(send).toHaveBeenCalledTimes(disconnected);
});
