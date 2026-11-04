import { describe, expect, it } from 'vitest';
import { describeMuseEvent, museCodeArgs, museCodeEnv, museCodeTools, startMcpServer } from './muse-code-engine';

const rpc = async (url: string, token: string | undefined, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 200 ? await res.json() as any : undefined };
};

describe('Muse Code engine', () => {
  it('serves the device tools over loopback MCP behind a per-run token', async () => {
    const calls: [string, unknown][] = [];
    const mcp = await startMcpServer({ tools: museCodeTools(), call: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: `ran ${name}` }] }; } });
    try {
      expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]+$/);
      expect((await rpc(mcp.url, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status).toBe(401);
      expect((await rpc(mcp.url, 'wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
      const init = await rpc(mcp.url, mcp.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      expect(init.json.result.serverInfo.name).toBe('controlanything');
      expect((await rpc(mcp.url, mcp.token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      const list = await rpc(mcp.url, mcp.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['look', 'say', 'open_visuals', 'deploy_connector', 'test_action', 'finish']);
      expect(list.json.result.tools.find((t: { name: string }) => t.name === 'finish').inputSchema.required).toContain('title');
      const call = await rpc(mcp.url, mcp.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'test_action', arguments: { action: 'cc21', value: 64 } } });
      expect(call.json.result.content[0].text).toBe('ran test_action');
      expect(calls).toEqual([['test_action', { action: 'cc21', value: 64 }]]);
      const unknown = await rpc(mcp.url, mcp.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } });
      expect(unknown.json.result.isError).toBe(true);
      expect(calls).toHaveLength(1);
    } finally { await mcp.close(); }
  });

  it('turns Muse Code JSONL events into transcript lines', () => {
    const kinds = new Map<string, string>();
    const ev = (payload_type: string, payload: unknown) => describeMuseEvent({ payload_type, payload }, kinds, '/ws');
    expect(ev('task.lifecycle.proposed', { task_id: 't1', event: { task_kind: 'tool.bash' } })?.status).toMatch(/command/);
    const bash = ev('task.lifecycle.output', { task_id: 't1', event: { chunk: JSON.stringify({ command: 'node --check connectors/v/index.mjs', exit_code: 0, output: 'ok' }) } });
    expect(bash?.line).toBe('$ node --check connectors/v/index.mjs\n  ok');
    ev('task.lifecycle.proposed', { task_id: 't2', event: { task_kind: 'tool.write_file' } });
    expect(ev('task.lifecycle.output', { task_id: 't2', event: { chunk: 'wrote 120 bytes to /ws/connectors/v/index.mjs' } })?.file).toBe('/ws/connectors/v/index.mjs');
    ev('task.lifecycle.proposed', { task_id: 't3', event: { task_kind: 'tool.mcp__controlanything__finish' } });
    expect(ev('task.lifecycle.output', { task_id: 't3', event: { chunk: '{"ok":true}' } })).toBeUndefined();
    expect(ev('run.usage', { models: [{ model: 'muse-spark-1.3' }] })?.models).toEqual(['muse-spark-1.3']);
  });

  it('runs Muse Code headless on Meta with the key on stdin only', () => {
    const args = museCodeArgs({ workspace: '/ws', prompt: '/run/prompt.txt', baseUrl: 'https://api.meta.ai/v1', image: '/run/snapshot.jpg', web: true, effort: 'low', steps: 40 });
    expect(args.slice(0, 7)).toEqual(['exec', '--json', '--provider', 'meta', '--model', 'muse-spark-1.3', '--api-key-stdin']);
    expect(args).toContain('--image');
    expect(args.join(' ')).toContain('--sandbox-network restricted');
    const env = museCodeEnv('/run', { PATH: '/bin', HOME: '/h', MODEL_API_KEY: 'secret', OPENAI_API_KEY: 'x' });
    expect(Object.values(env)).not.toContain('secret');
    expect(env.XDG_CONFIG_HOME).toBe('/run/config');
  });
});
