import { createLogger } from '../shared/logger.js';
import type { DetectedProvider, DetectionResult } from '../shared/types.js';

export type { DetectedProvider, DetectionResult };

const log = createLogger('ai.detect');

/**
 * Finding the right endpoint for a key is the single most common setup failure:
 * the same model is served by many hosts, each with its own base URL and its own
 * spelling of the model id. Rather than making the user guess, probe the known
 * OpenAI-compatible hosts with the key and report which one actually answers.
 */
export interface KnownProvider {
  id: string;
  label: string;
  baseUrl: string;
  /** Key prefixes that make this host very likely, so it is tried first. */
  keyPrefixes?: string[];
  /** Tried without a key — local inference servers. */
  local?: boolean;
}

export const KNOWN_PROVIDERS: KnownProvider[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyPrefixes: ['sk-or-'] },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', keyPrefixes: ['nvapi-'] },
  { id: 'naga', label: 'NagaAI', baseUrl: 'https://api.naga.ac/v1' },
  { id: 'fireworks', label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', keyPrefixes: ['fw_'] },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyPrefixes: ['gsk_'] },
  { id: 'hyperbolic', label: 'Hyperbolic', baseUrl: 'https://api.hyperbolic.xyz/v1' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyPrefixes: ['sk-proj-', 'sk-svcacct-'] },
  { id: 'local-nim', label: 'Local NIM / vLLM', baseUrl: 'http://localhost:8000/v1', local: true },
  { id: 'local-lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true },
  { id: 'local-ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', local: true }
];

/** Reduce a model id to comparable tokens: "am/nemotron-3-ultra-550b-a55b" → "nemotron3ultra550ba55b". */
function normalise(model: string): string {
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Score how well an advertised id matches the wanted one. 0 = unrelated. */
export function matchScore(wanted: string, candidate: string): number {
  const a = normalise(wanted);
  const b = normalise(candidate);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 80;

  // Compare on the distinctive stem, e.g. "nemotron3ultra".
  const stem = a.slice(0, Math.min(14, a.length));
  if (stem.length >= 6 && b.includes(stem)) return 60;
  return 0;
}

function orderProviders(apiKey: string, extra: string[]): KnownProvider[] {
  const custom: KnownProvider[] = extra
    .filter(Boolean)
    .map((baseUrl, i) => ({ id: `custom-${i}`, label: 'Configured endpoint', baseUrl }));
  const likely = KNOWN_PROVIDERS.filter((p) => p.keyPrefixes?.some((prefix) => apiKey.startsWith(prefix)));
  const rest = KNOWN_PROVIDERS.filter((p) => !likely.includes(p));
  return [...custom, ...likely, ...rest];
}

/**
 * Probe hosts until one authenticates and serves the wanted model.
 * The key is sent only to the hosts listed above, one at a time, newest first.
 */
export async function detectProvider(options: {
  apiKey: string;
  model: string;
  currentBaseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DetectionResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const attempts: DetectionResult['attempts'] = [];
  const reachable: DetectedProvider[] = [];
  let best: (DetectedProvider & { model: string; score: number }) | undefined;

  for (const provider of orderProviders(options.apiKey, [options.currentBaseUrl ?? ''])) {
    if (options.signal?.aborted) break;
    if (provider.local && options.apiKey && !provider.baseUrl.includes('localhost')) continue;

    const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const res = await doFetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          Accept: 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
        },
        signal: options.signal ?? timer
      });

      if (res.status === 401 || res.status === 403) {
        attempts.push({ label: provider.label, baseUrl: provider.baseUrl, status: 'key rejected' });
        continue;
      }
      if (!res.ok) {
        attempts.push({ label: provider.label, baseUrl: provider.baseUrl, status: `HTTP ${res.status}` });
        continue;
      }

      const json: any = await res.json().catch(() => null);
      const ids: string[] = (json?.data ?? json?.models ?? [])
        .map((m: any) => (typeof m === 'string' ? m : m?.id))
        .filter((id: unknown): id is string => typeof id === 'string');

      const scored = ids
        .map((id) => ({ id, score: matchScore(options.model, id) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score);

      const entry: DetectedProvider = {
        providerId: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        matches: scored.map((m) => m.id),
        models: ids.slice(0, 200)
      };
      reachable.push(entry);
      attempts.push({
        label: provider.label,
        baseUrl: provider.baseUrl,
        status: scored.length ? `serves ${scored[0].id}` : `authenticated, ${ids.length} other models`
      });

      if (scored.length && (!best || scored[0].score > best.score)) {
        best = { ...entry, model: scored[0].id, score: scored[0].score };
        if (scored[0].score === 100) break; // exact id — no need to keep probing
      }
    } catch (err) {
      attempts.push({
        label: provider.label,
        baseUrl: provider.baseUrl,
        status: (err as Error).name === 'TimeoutError' ? 'no response' : 'unreachable'
      });
    }
  }

  log.info('Provider detection finished', { reachable: reachable.length, matched: !!best });

  if (best) {
    return {
      ok: true,
      best,
      reachable,
      attempts,
      message: `${best.label} accepted the key and serves ${best.model}.`
    };
  }
  if (reachable.length) {
    const host = reachable[0];
    return {
      ok: false,
      reachable,
      attempts,
      message:
        `${host.label} accepted the key, but none of the hosts advertise a model matching ` +
        `"${options.model}". Pick one of the models it does offer.`
    };
  }
  return {
    ok: false,
    reachable,
    attempts,
    message:
      'No known provider accepted this key. Enter the base URL from your provider\'s documentation ' +
      '(the one ending in /v1) and use "Test connection".'
  };
}
