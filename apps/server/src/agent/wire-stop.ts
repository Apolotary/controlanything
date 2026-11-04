/** Neutral releases for authored software capabilities, not gesture mappings or physical device commands. */
import type { Driver, ExecOp } from '@ce/protocol';
import { isMusicalSynthPort } from '../devices/musicalSynth';
import { isVisualSynthPort, touchRoleOfCc } from '../devices/visualSynth';
import type { Dispatcher } from './dispatch';
import type { Target } from './types';

export function heldWireRelease(driver: Driver, _verification?: Target['verification']): { actionId: string; op: ExecOp } | undefined {
  if (driver.transport !== 'midi') return undefined;
  const musical = isMusicalSynthPort(driver.executor.port), visual = isVisualSynthPort(driver.executor.port);
  if (!musical && !visual) return undefined;
  const action = driver.actions.find(a => a.kind === 'set'
    && a.range && a.range.min <= 0 && a.range.max >= 0 && a.encode.kind === 'midi' && a.encode.msg === 'cc' && a.encode.channel === 1
    && (musical ? a.encode.number === 17 : touchRoleOfCc(a.encode.number) === 'pressure'));
  // A verification probe can hold these authored engine inputs before a matching action has passed.
  // This exact neutral is infrastructure, permitted only inside the server's scoped release authorization.
  return { actionId: action?.actionId ?? 'wire-release', op: { kind: 'midi', msg: 'cc', channel: 1, number: musical ? 17 : 24, value: 0 } };
}

export async function releaseWireOutputs(target: Target, deps: {
  cancelQueued(target: Target): void;
  dispatcher: Pick<Dispatcher, 'exec'>;
}): Promise<{ released: boolean; reason?: string }> {
  // The caller already revoked WIRE authority. Retain arm/driver while clearing every delayed command for this card.
  deps.cancelQueued(target);
  const driver = target.driver;
  const release = driver ? heldWireRelease(driver, target.verification) : undefined;
  if (!driver || !release) return { released: true };
  try {
    await deps.dispatcher.exec(driver.executor.deviceId, release.op, { port: driver.executor.port, cardId: target.cardId,
      driverId: driver.driverId, actionId: release.actionId, priorityRelease: true, timeoutMs: 1500, signal: AbortSignal.timeout(1700) });
    return { released: true };
  } catch {
    return { released: false, reason: 'Wiring stopped. Device release was not confirmed; use Stop everything if needed.' };
  }
}
