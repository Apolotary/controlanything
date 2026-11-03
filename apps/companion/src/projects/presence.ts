import type { ProjectPreviewPayload } from '@ce/protocol';

/** A lightweight lease exists only after the sandbox acknowledges startup. */
export class ProjectPreviewPresence {
  private current?: { projectId: string; revision: number };
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly send: (payload: ProjectPreviewPayload) => boolean) {}
  start(value: { projectId: string; revision: number }): void {
    if (this.current?.projectId === value.projectId && this.current.revision === value.revision) return;
    this.stop(); this.current = { projectId: value.projectId, revision: value.revision };
    if (!this.send({ ...this.current, active: true })) { this.current = undefined; return; }
    this.timer = setInterval(() => { if (this.current && !this.send({ ...this.current, active: true })) this.stop(); }, 1500);
  }
  stop(): void {
    clearInterval(this.timer); this.timer = undefined;
    const current = this.current; this.current = undefined;
    if (current) this.send({ ...current, active: false });
  }
}
