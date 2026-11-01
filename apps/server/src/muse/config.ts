/** Which Meta models the server uses, and whether calls are live or FIXTURE. Never log `apiKey`. */
export const DEFAULT_MUSE_MODEL = 'muse-spark-1.3';
export const DEFAULT_MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const DEFAULT_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ModelMode = 'live' | 'fixture';

export interface MuseConfig {
  mode: ModelMode;
  /** empty in fixture mode; never print it */
  apiKey: string;
  model: string;
  baseUrl: string;
  reasoningEffort?: ReasoningEffort;
  transcribeModel: string;
  fixtureDelayMs: number;
  /** live mode: save keyed responses here (MUSE_RECORD=1) */
  recordDir?: string;
  /** fixture mode: replay recorded responses from here */
  replayDir?: string;
  warnings: string[];
}

/** MODEL_MODE (live|fixture) wins; otherwise live when MODEL_API_KEY is set, else fixture. */
export function resolveMuseConfig(env: NodeJS.ProcessEnv): MuseConfig {
  const warnings: string[] = [];
  const key = env.MODEL_API_KEY?.trim() ?? '';
  const forced = (env.MODEL_MODE ?? '').trim().toLowerCase();
  let mode: ModelMode = key ? 'live' : 'fixture';
  if (forced === 'fixture') mode = 'fixture';
  else if (forced === 'live' && !key) warnings.push('MODEL_MODE=live but MODEL_API_KEY is empty; using FIXTURE mode');
  else if (forced && forced !== 'live') warnings.push(`unknown MODEL_MODE "${forced}"; using ${mode}`);

  const effortRaw = env.MUSE_REASONING_EFFORT?.trim().toLowerCase();
  let reasoningEffort: ReasoningEffort | undefined;
  if (effortRaw) {
    if ((REASONING_EFFORTS as readonly string[]).includes(effortRaw)) reasoningEffort = effortRaw as ReasoningEffort;
    else warnings.push(`ignoring MUSE_REASONING_EFFORT "${effortRaw}" (allowed: ${REASONING_EFFORTS.join(', ')})`);
  }
  const delay = Number(env.FIXTURE_DELAY_MS ?? 300);
  return {
    mode,
    apiKey: mode === 'live' ? key : '',
    model: env.MUSE_MODEL?.trim() || DEFAULT_MUSE_MODEL,
    baseUrl: (env.MUSE_API_BASE?.trim() || DEFAULT_MUSE_BASE_URL).replace(/\/+$/, ''),
    reasoningEffort,
    transcribeModel: env.MUSE_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
    fixtureDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 300,
    warnings,
  };
}
