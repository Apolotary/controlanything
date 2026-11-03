/** The buddy's little scavenger hunt: it asks for things, Muse judges whether what you showed fits. */
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

export const ASK_LINES = [
  'Show me {q}!',
  'Ooh, can you find {q}?',
  'Quest time: {q}!',
  'I wonder… do you have {q}?',
] as const;

export const POKE_LINES = ['Hehe, that tickles!', 'Boop!', 'Hey! I was thinking.', 'Again! Again!', 'You found my off switch. Kidding.'] as const;

export class QuestLog {
  index = 0;
  done = 0;
  private askIndex = 0;

  get current(): string {
    return QUESTS[this.index % QUESTS.length];
  }

  ask(): string {
    const line = ASK_LINES[this.askIndex++ % ASK_LINES.length];
    return line.replace('{q}', this.current);
  }

  complete(): void {
    this.done++;
    this.next();
  }

  next(): void {
    this.index = (this.index + 1) % QUESTS.length;
  }
}

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}
