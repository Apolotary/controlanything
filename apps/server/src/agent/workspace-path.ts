import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const within = (file: string, root: string) => file === root || file.startsWith(root + sep);
const protectedPath = (file: string) => file.split(sep).some((part) =>
  (part.startsWith('.env') && part !== '.env.example') || ['.git', '.certs', '.ssh', '.aws', '.npmrc', '.netrc'].includes(part))
  || /\.(?:pem|key|p12|pfx|mobileprovision)$/i.test(file);

/** Canonical path checks for the file tools. This is accidental-secret protection, not a shell/OS sandbox. */
export async function resolveAgentPath(path: string, options: { workspace: string; repoRoot: string; write: boolean }): Promise<string | undefined> {
  const workspace = await realpath(options.workspace);
  const repo = await realpath(options.repoRoot);
  let candidate = resolve(workspace, path);
  const missing: string[] = [];
  for (;;) {
    try {
      candidate = join(await realpath(candidate), ...missing);
      break;
    } catch (error) {
      if (!options.write || (error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      // A dangling symlink must not be mistaken for a missing file and then followed by writeFile.
      if (await lstat(candidate).then(() => true, () => false)) return undefined;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
  if (protectedPath(candidate)) return undefined;
  if (within(candidate, workspace)) return candidate;
  if (!options.write && within(candidate, repo) && !candidate.split(sep).includes('.data')) return candidate;
  return undefined;
}
