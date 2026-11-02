import { describe, expect, it } from 'vitest';
import { buildCheckSteps, type CheckProgress } from './checks';

const generated: CheckProgress = { generated: true, checked: false, sent: false };

describe('check progress', () => {
  it('leaves unreported stages pending', () => {
    expect(buildCheckSteps({ generated: false, checked: false, sent: false })).toEqual([
      { label: 'Generated', state: 'pending' },
      { label: 'Checked', state: 'pending' },
      { label: 'Sent', state: 'pending' },
      { label: 'Seen', state: 'pending' },
    ]);
    expect(buildCheckSteps(generated).map((step) => step.state)).toEqual(['done', 'pending', 'pending', 'pending']);
  });

  it('shows a failed validation without claiming a command was sent', () => {
    expect(buildCheckSteps({ ...generated, checkFailed: true }).map((step) => step.state)).toEqual(['done', 'failed', 'pending', 'pending']);
  });

  it('preserves successful validation when sending fails', () => {
    expect(buildCheckSteps({ ...generated, checked: true, sendFailed: true }).map((step) => step.state)).toEqual(['done', 'done', 'failed', 'pending']);
  });

  it('gives explicit failures priority over stale success flags', () => {
    expect(buildCheckSteps({ generated: true, checked: true, sent: true, checkFailed: true, sendFailed: true }).map((step) => step.state)).toEqual(['done', 'failed', 'failed', 'pending']);
  });

  it.each([
    ['camera', 'Seen'],
    ['audio', 'Heard'],
    ['ack', 'Wired'],
    ['none', 'Wired'],
  ] as const)('labels a %s observation as %s', (sense, label) => {
    expect(buildCheckSteps({ generated: true, checked: true, sent: true, observation: { sense, pass: true } })).toEqual([
      { label: 'Generated', state: 'done' },
      { label: 'Checked', state: 'done' },
      { label: 'Sent', state: 'done' },
      { label, state: 'done' },
    ]);
  });

  it('keeps the successful send when physical verification fails', () => {
    expect(buildCheckSteps({ generated: true, checked: true, sent: true, observation: { sense: 'audio', pass: false } })).toEqual([
      { label: 'Generated', state: 'done' },
      { label: 'Checked', state: 'done' },
      { label: 'Sent', state: 'done' },
      { label: 'Heard', state: 'failed' },
    ]);
  });

  it('does not infer unreported stages from an observation', () => {
    expect(buildCheckSteps({ generated: false, checked: false, sent: false, observation: { sense: 'camera', pass: true } }).map((step) => step.state)).toEqual(['pending', 'pending', 'pending', 'done']);
  });
});
