import type { ProjectDocument } from '@ce/protocol';

export interface FrameAction { actionId: string; value?: number }
export interface RuntimeIdentity { projectId: string; revision: number; nonce: string }
const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Generated markup is data inside a trusted bootstrap, never concatenated into document markup. */
export function projectSrcdoc(document: ProjectDocument, identity: RuntimeIdentity, values: Record<string, number> = {}): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(identity.nonce)) throw new Error('Invalid frame nonce');
  const initial = Object.fromEntries(document.spec.actions.map(action => [action.id, values[action.id] ?? action.initial ?? 0]));
  const config = json({ ...identity, values: initial, html: document.spec.html, css: document.spec.css, js: document.spec.js });
  const policy = `default-src 'none'; script-src 'nonce-${identity.nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;color:#f5f5f7;background:#111318}*{box-sizing:border-box}</style></head><body><script nonce="${identity.nonce}">(()=>{
    'use strict';const config=${config};let values=Object.freeze({...config.values});const listeners=new Set();
    const send=(kind,extra={})=>parent.postMessage({channel:'muse-canvas',kind,nonce:config.nonce,projectId:config.projectId,revision:config.revision,...extra},'*');
    Object.defineProperty(window,'museCanvas',{value:Object.freeze({emit:(actionId,value)=>send('action',{actionId,value}),subscribe:(fn)=>{if(typeof fn!=='function')return()=>{};listeners.add(fn);fn(values);return()=>listeners.delete(fn)},get state(){return values}}),writable:false,configurable:false});
    addEventListener('message',(event)=>{const m=event.data;if(event.source!==parent||!m||m.channel!=='muse-canvas'||m.kind!=='state'||m.nonce!==config.nonce||m.projectId!==config.projectId||m.revision!==config.revision)return;values=Object.freeze({...m.values});for(const fn of listeners){try{fn(values)}catch(error){send('error',{message:String(error).slice(0,240)})}}});
    addEventListener('error',(event)=>send('error',{message:String(event.message).slice(0,240)}));
    addEventListener('unhandledrejection',(event)=>send('error',{message:String(event.reason).slice(0,240)}));
    document.addEventListener('click',(event)=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault()},true);
    document.addEventListener('submit',(event)=>event.preventDefault(),true);
    const template=document.createElement('template');template.innerHTML=config.html;
    template.content.querySelectorAll('script,iframe,frame,object,embed,base,meta,link,form').forEach(node=>node.remove());
    template.content.querySelectorAll('*').forEach(node=>{for(const attribute of [...node.attributes])if(/^on/i.test(attribute.name)||['srcdoc','href','action','formaction','target','download'].includes(attribute.name.toLowerCase()))node.removeAttribute(attribute.name)});
    document.body.append(template.content);const style=document.createElement('style');style.textContent=config.css;document.head.append(style);
    const script=document.createElement('script');script.nonce=config.nonce;script.textContent=config.js;document.body.append(script);send('ready');
  })()<\/script></body></html>`;
}

export function validFrameAction(data: unknown, identity: RuntimeIdentity, document: ProjectDocument): FrameAction | undefined {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>;
  if (m.channel !== 'muse-canvas' || m.kind !== 'action' || m.nonce !== identity.nonce || m.projectId !== identity.projectId || m.revision !== identity.revision
    || document.projectId !== identity.projectId || document.revision !== identity.revision || typeof m.actionId !== 'string') return;
  const action = document.spec.actions.find(action => action.id === m.actionId);
  if (!action) return;
  if (action.kind === 'trigger') return m.value === undefined ? { actionId: action.id } : undefined;
  if (typeof m.value !== 'number' || !Number.isFinite(m.value) || m.value < action.min! || m.value > action.max!) return;
  return { actionId: action.id, value: m.value };
}

/** The host owns the frame lifetime; no messages survive Stop, a revision change or disconnect. */
export class ProjectRuntime {
  private frame?: HTMLIFrameElement;
  private document?: ProjectDocument;
  private identity?: RuntimeIdentity;
  private lastAction = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private values: Record<string, number> = {};
  private acknowledged = false;
  constructor(private readonly container: HTMLElement, private readonly action: (action: FrameAction) => void,
    private readonly status: (message: string, error?: boolean) => void,
    private readonly preview: (identity?: RuntimeIdentity) => void = () => {}) {
    window.addEventListener('message', this.onMessage);
  }
  get running(): boolean { return !!this.frame; }
  get ready(): boolean { return !!this.frame && this.acknowledged; }
  get revision(): number | undefined { return this.identity?.revision; }
  get projectId(): string | undefined { return this.identity?.projectId; }
  start(document: ProjectDocument, values: Record<string, number>): void {
    this.stop(); this.document = document; this.values = { ...values };
    this.identity = { projectId: document.projectId, revision: document.revision, nonce: crypto.randomUUID() };
    const frame = window.document.createElement('iframe');frame.id = 'project-preview';frame.title = `${document.spec.title} preview`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; midi 'none'; serial 'none'; usb 'none'; fullscreen 'none'; autoplay 'none'; clipboard-read 'none'; clipboard-write 'none'; xr-spatial-tracking 'none'");
    frame.referrerPolicy = 'no-referrer';
    let loaded = false;
    frame.onload = () => { if (loaded && this.frame === frame) { this.stop(); this.status('Preview stopped after a navigation attempt.', true); } loaded = true; };
    frame.srcdoc = projectSrcdoc(document, this.identity, values);
    this.frame = frame; this.container.replaceChildren(frame);
    this.timer = setTimeout(() => { if (this.frame === frame) { this.stop(); this.status('Preview did not start. Review the generated code or ask Muse to fix it.', true); } }, 8000);
  }
  update(values: Record<string, number>): void {
    this.values = { ...values };
    if (this.frame?.contentWindow && this.identity) this.frame.contentWindow.postMessage({ channel: 'muse-canvas', kind: 'state', ...this.identity, values: this.values }, '*');
  }
  stop(): void { clearTimeout(this.timer); this.timer = undefined; if (this.acknowledged) this.preview(); this.acknowledged = false; this.frame?.remove(); this.frame = undefined; this.document = undefined; this.identity = undefined; this.values = {}; this.lastAction = -Infinity; }
  dispose(): void { this.stop(); window.removeEventListener('message', this.onMessage); }
  private onMessage = (event: MessageEvent): void => {
    const frame = this.frame, document = this.document, identity = this.identity;
    if (!frame || !document || !identity || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (!data || data.channel !== 'muse-canvas' || data.nonce !== identity.nonce || data.projectId !== identity.projectId || data.revision !== identity.revision) return;
    if (data.kind === 'ready') { clearTimeout(this.timer); this.timer = undefined; this.acknowledged = true; this.preview(identity); this.update(this.values); this.status('Preview running · shared controls connected'); return; }
    if (data.kind === 'error') { this.stop(); this.status(`Preview error: ${String(data.message).slice(0, 240)}`, true); return; }
    const action = validFrameAction(data, identity, document);
    const now = performance.now();
    if (this.ready && action && now - this.lastAction >= 30) { this.lastAction = now; this.action(action); }
  };
}
