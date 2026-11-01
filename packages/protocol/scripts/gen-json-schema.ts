/**
 * Writes packages/protocol/json-schema/<type>.json (full message: envelope + payload) and index.json,
 * for clients that are not TypeScript (Unity, ESP32 firmware, Python). Run by `npm run build`.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_TYPES, MessageSchemas, PROTOCOL_VERSION, toJsonSchema } from '../src/index';

const outDir = fileURLToPath(new URL('../json-schema/', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));

const index: Record<string, string> = {};
for (const type of MESSAGE_TYPES) {
  const schema = { title: type, ...toJsonSchema(MessageSchemas[type]) };
  const file = `${type}.json`;
  writeFileSync(join(outDir, file), `${JSON.stringify(schema, null, 2)}\n`);
  index[type] = file;
}
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ protocol: PROTOCOL_VERSION, messages: index }, null, 2)}\n`);
console.log(`wrote ${MESSAGE_TYPES.length} message schemas to ${outDir}`);
