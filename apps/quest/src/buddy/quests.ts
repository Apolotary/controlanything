/**
 * The buddy's little scavenger hunt: three quests per round ("Quest 1 of 3"), Muse judges whether what you
 * showed fits. A quest ends when it is met, or after two near-misses (so nobody gets stuck); after the third,
 * a celebration, then free play until "Play again" starts the next three.
 */
export const QUESTS = [
  'something green',
  'something that makes music',
  'something with buttons',
  'something you can hold in one hand',
  'something red',
  'something soft',
  'something shiny',
  'something you use every day',
  'something older than you',
  'your favourite thing on the desk',
] as const;

/** quests per round */
export const ROUND = 3;
/** misses on one quest before the buddy moves on */
export const MISSES = 2;

export const POKE_LINES = ['Hehe, that tickles!', 'Boop!', 'Hey! I was thinking.', 'Again! Again!', 'You found my off switch. Kidding.'] as const;

export class QuestLog {
  /** index into QUESTS of the current quest */
  index = 0;
  /** quests finished this round (met or skipped after misses) */
  done = 0;
  /** quests met this round */
  met = 0;
  misses = 0;
  /** the round of three is over: free play */
  get finished(): boolean { return this.done >= ROUND; }

  get current(): string | undefined {
    return this.finished ? undefined : QUESTS[this.index % QUESTS.length];
  }

  /** "Quest 2 of 3" (or "Free play") */
  get kicker(): string {
    return this.finished ? `ALL ${ROUND} DONE · FREE PLAY` : `QUEST ${this.done + 1} OF ${ROUND}`;
  }

  /** The one-line ask, with the how-to: "Show me something green! Hold it in the frame." */
  ask(kind: 'first' | 'next' | 'retry' = 'next'): string {
    const q = this.current;
    if (!q) return 'Show me anything you like! Hold it in the frame.';
    if (kind === 'first') return `Hi! Show me ${q}. Hold it up in the frame!`;
    if (kind === 'retry') return `Still looking for ${q}! Hold it in the frame.`;
    return this.done === ROUND - 1 ? `Last one: ${q}! Hold it in the frame.` : `Next: ${q}! Hold it in the frame.`;
  }

  /** Quest met: returns true when that finished the round. */
  complete(): boolean {
    this.met++;
    return this.advance();
  }

  /** Shown something that does not fit: whether the buddy moved on to the next quest (after MISSES), and whether that ended the round. */
  miss(): { movedOn: boolean; roundOver: boolean } {
    this.misses++;
    if (this.misses < MISSES) return { movedOn: false, roundOver: false };
    return { movedOn: true, roundOver: this.advance() };
  }

  /** Skip the current quest (the card's skip button); in free play, start a new round. */
  skip(): void {
    if (this.finished) this.restart();
    else { this.misses = 0; this.index = (this.index + 1) % QUESTS.length; }
  }

  /** a fresh round of three, continuing through the quest list */
  restart(): void {
    this.done = 0;
    this.met = 0;
    this.misses = 0;
    this.index = (this.index + 1) % QUESTS.length;
  }

  private advance(): boolean {
    this.done++;
    this.misses = 0;
    if (!this.finished) this.index = (this.index + 1) % QUESTS.length;
    return this.finished;
  }
}

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}
