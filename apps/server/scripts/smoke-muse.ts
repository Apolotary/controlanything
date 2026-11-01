/**
 * One small live call to check the Meta key and the adapter (costs a fraction of a cent):
 *   npm run smoke:muse -w @ce/server
 * Text-only by default; pass a JPEG path to also test vision: npm run smoke:muse -w @ce/server -- photo.jpg
 * Reads MODEL_API_KEY from the repo-root .env. Never prints the key.
 */
import { readFileSync } from 'node:fs';
import { PayloadSchemas } from '@ce/protocol';
import { loadDotEnv } from '../src/config';
import { createMuseChat, resolveMuseConfig, userMessage } from '../src/muse';

loadDotEnv();
const cfg = resolveMuseConfig(process.env);
if (cfg.mode !== 'live') {
  console.log('FIXTURE mode (no MODEL_API_KEY): nothing to check against the live API.');
  process.exit(0);
}
const muse = createMuseChat(cfg);
const image = process.argv[2];

const hello = await muse.chat([userMessage('Reply with exactly: ControlEverything online')], { maxTokens: 400, reasoningEffort: 'minimal', label: 'smoke' });
console.log(`text   ${JSON.stringify(hello.text)} (${hello.model}, ${hello.latencyMs} ms)`);

if (image) {
  const jpeg = readFileSync(image).toString('base64');
  const card = await muse.chatJson([userMessage('Identify the main electronic device in this photo.', [jpeg])], PayloadSchemas['device.card'], {
    name: 'device_card',
    reasoningEffort: 'low',
    label: 'smoke-vision',
  });
  console.log(`vision ${card.data.maker} ${card.data.name} (${card.data.category}, confidence ${card.data.confidence}) format=${card.format}`);
}
console.log('usage', muse.totals());
