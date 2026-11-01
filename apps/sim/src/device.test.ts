import { describe, expect, it } from 'vitest';
import { promptedButton } from './device';

describe('learn prompts', () => {
  it('finds the button whatever the remote calls it', () => {
    const cases: [string, string][] = [
      ['Press 全灯 (full on) once', 'fullOn'],
      ['Press 消灯 (off) once', 'off'],
      ['Press 明るく (brighter) once', 'brighter'],
      ['Press 暗く (dimmer) once', 'dimmer'],
      ['Press 常夜灯 (night light) once', 'night'],
      ['Press 暖色 (warm) once', 'warmer'],
      ['Press 白色 (cool white) once', 'cooler'],
      ['press 暖かい光', 'warmer'],
      ['press 点灯 once', 'on'],
      ['press On', 'on'],
      ['press Off', 'off'],
    ];
    for (const [prompt, cmd] of cases) expect(promptedButton(prompt), prompt).toBe(cmd);
    expect(promptedButton('press any button')).toBeUndefined();
    expect(promptedButton(undefined)).toBeUndefined();
  });
});
