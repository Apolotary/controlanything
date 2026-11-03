import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createContext } from '../context';
import { GENERAL_ASSISTANT_CARD } from './connected-peripheral';
import { createAgent } from './index';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); });

describe('voice command scope through the real agent', () => {
  it('does not use a newer room action for general chat or selected-device undo', async () => {
    const ctx = createContext(loadConfig({ MODEL_MODE: 'fixture', FIXTURE_DELAY_MS: '0', MUSE_REPLAY: '0', HTTP_PORT: '0', HTTPS_PORT: '0' }), { registryFile: null, log: () => {} });
    const agent = createAgent(ctx, { macLocal: false, forge: () => undefined, tagsFile: null });
    cleanups.push(() => { agent.close(); ctx.hub.close(); });
    const target = agent.targets.create({ cardId: 'lamp', state: 'identified' });
    agent.combos.lastRun = { hackId: 'room-action', startedAt: target.since + 1, confirmed: true, evidence: [], steps: [] };
    const undoRoom = vi.spyOn(agent.combos, 'undo').mockResolvedValue({ restored: [], cannot: [] });
    const undoDevice = vi.spyOn(agent.control, 'undo').mockReturnValue({ ok: true, fired: 0, ms: 0 });
    const panic = vi.spyOn(agent.control, 'panic');

    for (const [index, text] of ['undo', 'How does undo work?', 'What does panic mean?', 'scan'].entries()) {
      await agent.voice.onText({ utteranceId: `general-${index}`, text, cardId: GENERAL_ASSISTANT_CARD, final: true }, 'quest');
    }
    expect(undoRoom).not.toHaveBeenCalled(); expect(undoDevice).not.toHaveBeenCalled(); expect(panic).not.toHaveBeenCalled();

    await agent.voice.onText({ utteranceId: 'scoped', text: 'undo', cardId: target.cardId, final: true }, 'quest');
    expect(undoDevice).toHaveBeenCalledExactlyOnceWith(target); expect(undoRoom).not.toHaveBeenCalled();

    // Legacy room voice entry remains explicit and has no selected card.
    await agent.voice.onText({ utteranceId: 'room', text: 'undo', final: true }, 'quest');
    expect(undoRoom).toHaveBeenCalledOnce();
  });
});
