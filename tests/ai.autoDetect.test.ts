/**
 * Provider detection: the user pastes a key and the application works out which
 * host serves it, instead of making them hunt for a base URL.
 */
import { describe, it, expect } from 'vitest';
import { detectProvider, matchScore, KNOWN_PROVIDERS } from '../src/core/ai/autoDetect.js';

const KEY = 'sk-test-key';
const WANTED = 'am/nemotron-3-ultra-550b-a55b';

/** A fake network where only `host` answers, advertising `models`. */
function network(host: string, models: string[], status = 200): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    if (!url.startsWith(host)) throw new Error('ECONNREFUSED');
    if (status !== 200) return new Response('nope', { status });
    return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
}

describe('model id matching', () => {
  it('matches the same model across provider naming conventions', () => {
    expect(matchScore(WANTED, 'nvidia/nemotron-3-ultra-550b-a55b')).toBeGreaterThan(0);
    expect(matchScore(WANTED, 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B')).toBeGreaterThan(0);
    expect(matchScore(WANTED, 'nemotron-3-ultra-550b-a55b:free')).toBeGreaterThan(0);
  });

  it('does not match unrelated models', () => {
    expect(matchScore(WANTED, 'gpt-4o-mini')).toBe(0);
    expect(matchScore(WANTED, 'llama-3.1-8b-instruct')).toBe(0);
  });
});

describe('detectProvider', () => {
  it('finds the host that serves the wanted model and reports its exact model id', async () => {
    const result = await detectProvider({
      apiKey: KEY,
      model: WANTED,
      fetchImpl: network('https://api.deepinfra.com', ['meta/llama-3', 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B'])
    });

    expect(result.ok).toBe(true);
    expect(result.best?.baseUrl).toBe('https://api.deepinfra.com/v1/openai');
    expect(result.best?.model).toBe('nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B');
    expect(result.message).toMatch(/accepted the key/);
  });

  it('reports honestly when the key works but the model is absent', async () => {
    const result = await detectProvider({
      apiKey: KEY,
      model: WANTED,
      fetchImpl: network('https://api.openai.com', ['gpt-4o', 'gpt-4o-mini'])
    });

    expect(result.ok).toBe(false);
    expect(result.reachable).toHaveLength(1);
    expect(result.message).toMatch(/none of the hosts advertise a model matching/);
  });

  it('distinguishes a rejected key from an unreachable host', async () => {
    const result = await detectProvider({
      apiKey: KEY,
      model: WANTED,
      fetchImpl: network('https://api.together.xyz', [], 401)
    });

    expect(result.ok).toBe(false);
    expect(result.attempts.find((a) => a.label === 'Together AI')?.status).toBe('key rejected');
    expect(result.attempts.some((a) => a.status === 'unreachable')).toBe(true);
    expect(result.message).toMatch(/No known provider accepted this key/);
  });

  it('tries the endpoint already configured before anything else', async () => {
    const tried: string[] = [];
    const fetchImpl = (async (input: any) => {
      tried.push(String(input));
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await detectProvider({ apiKey: KEY, model: WANTED, currentBaseUrl: 'https://my-own-host.example/v1', fetchImpl });
    expect(tried[0]).toBe('https://my-own-host.example/v1/models');
  });

  it('tries a host matching the key prefix first', async () => {
    const tried: string[] = [];
    const fetchImpl = (async (input: any) => {
      tried.push(String(input));
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await detectProvider({ apiKey: 'sk-or-v1-abc', model: WANTED, fetchImpl });
    expect(tried[0]).toContain('openrouter.ai');
  });

  it('knows the hosts that actually serve this model family', () => {
    const urls = KNOWN_PROVIDERS.map((p) => p.baseUrl);
    expect(urls).toContain('https://openrouter.ai/api/v1');
    expect(urls).toContain('https://api.deepinfra.com/v1/openai');
    expect(urls).toContain('https://api.together.xyz/v1');
    expect(urls).toContain('https://integrate.api.nvidia.com/v1');
  });
});
