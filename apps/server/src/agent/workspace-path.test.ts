import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentPath } from './workspace-path';

describe('Muse file-tool paths', () => {
  it('keeps reads inside public repo/workspace and writes inside workspace after resolving symlinks', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ce-agent-path-')));
    try {
      const repoRoot = join(root, 'repo'), workspace = join(repoRoot, '.data', 'muse-agent'), outside = join(root, 'private');
      await mkdir(workspace, { recursive: true }); await mkdir(outside);
      await writeFile(join(repoRoot, 'manifest.json'), '{}'); await writeFile(join(outside, 'secret'), 'private');
      await symlink(outside, join(workspace, 'escape'));
      await symlink(join(outside, 'missing'), join(workspace, 'dangling'));
      const check = (path: string, write: boolean) => resolveAgentPath(path, { workspace, repoRoot, write });
      expect(await check(join(repoRoot, 'manifest.json'), false)).toBe(join(repoRoot, 'manifest.json'));
      expect(await check('connectors/new/index.mjs', true)).toBe(join(workspace, 'connectors/new/index.mjs'));
      expect(await check('escape/secret', false)).toBeUndefined();
      expect(await check('escape/new.mjs', true)).toBeUndefined();
      expect(await check('dangling', true)).toBeUndefined();
      expect(await check(join(repoRoot, 'new.mjs'), true)).toBeUndefined();
      for (const name of ['.env', '.env.local', '.git/config', '.certs/key.pem', '.data/space.json']) {
        const file = join(repoRoot, name); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'private');
        expect(await check(file, false)).toBeUndefined();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
