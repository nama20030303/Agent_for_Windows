/**
 * A gateway that accepts a request for a model it does not host answers with
 * an empty completion, which is indistinguishable from a broken app. The user
 * should not have to guess which model works.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleProvider, rankModels } from '../src/core/ai/openaiCompatible.js';
import { buildResponsesBody, parseResponsesJson } from '../src/core/ai/responsesApi.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function provider(model = 'am/nemotron-3-ultra-550b-a55b') {
  return new OpenAICompatibleProvider({
    provider: 'openai-compatible',
    baseUrl: 'https://anymodel.invalid/v1',
    model,
    temperature: 0.2,
    maxTokens: 0,
    timeoutMs: 5000,
    streaming: false,
    apiKey: 'sk'
  } as any);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const EMPTY = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
const READY = { choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] };

describe('ranking the catalogue', () => {
  it('tries the same family first, then capable models, and skips non-text ones', () => {
    const ranked = rankModels(
      ['text-embedding-3', 'whisper-1', 'gpt-5.4', 'claude-sonnet-4.6', 'nemotron-mini', 'flux-image'],
      'am/nemotron-3-ultra-550b-a55b'
    );
    expect(ranked[0]).toBe('nemotron-mini');
    expect(ranked.slice(1, 3)).toEqual(['claude-sonnet-4.6', 'gpt-5.4']);
    expect(ranked.slice(-3)).toEqual(['flux-image', 'text-embedding-3', 'whisper-1']);
  });
});

describe('finding a model that answers', () => {
  it('walks the catalogue and keeps the first that produces text', async () => {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/models')) {
        return json({ data: [{ id: 'am/nemotron-3-ultra-550b-a55b' }, { id: 'claude-sonnet-4.6' }] });
      }
      const body = JSON.parse(init.body);
      asked.push(body.model);
      return json(body.model === 'claude-sonnet-4.6' ? READY : EMPTY);
    }) as any;

    const p = provider();
    const found = await p.findWorkingSetup();

    expect(found.ok).toBe(true);
    expect(found.model).toBe('claude-sonnet-4.6');
    expect(found.message).toContain('claude-sonnet-4.6');
    // The configured model is tried first, so the user is not switched needlessly.
    expect(asked[0]).toBe('am/nemotron-3-ultra-550b-a55b');
    expect(p.describe().model).toBe('claude-sonnet-4.6');
  });

  it('says so plainly when the endpoint lists nothing', async () => {
    globalThis.fetch = (async (url: any) =>
      String(url).endsWith('/models') ? json({ data: [] }) : json(EMPTY)) as any;

    const found = await provider().findWorkingSetup();
    expect(found.ok).toBe(false);
    expect(found.message).toMatch(/did not return a model list/i);
  });

  it('restores the configured model when nothing works', async () => {
    globalThis.fetch = (async (url: any) =>
      String(url).endsWith('/models') ? json({ data: [{ id: 'a' }, { id: 'b' }] }) : json(EMPTY)) as any;

    const p = provider();
    const found = await p.findWorkingSetup();
    expect(found.ok).toBe(false);
    expect(found.tried.length).toBeGreaterThan(1);
    expect(p.describe().model).toBe('am/nemotron-3-ultra-550b-a55b');
  });
});

describe('the /v1/responses shape', () => {
  it('builds a request the way that API expects', () => {
    const body = buildResponsesBody(
      'm',
      [
        { role: 'system', content: 'be good' },
        { role: 'user', content: 'hi' },
        { role: 'tool', name: 'read_file', content: 'ok' }
      ],
      undefined,
      undefined,
      0.2
    );
    expect(body.instructions).toBe('be good');
    expect(body.input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'Tool result (read_file): ok' }
    ]);
    expect('max_output_tokens' in body).toBe(false);
  });

  it('reads text and function calls back out', () => {
    const parsed = parseResponsesJson({
      output: [
        { type: 'reasoning', content: [{ text: 'thinking' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"a"}' }
      ],
      usage: { input_tokens: 3, output_tokens: 4 }
    });
    expect(parsed.content).toBe('Hello');
    expect(parsed.reasoning).toBe('thinking');
    expect(parsed.toolCalls[0]).toEqual({ id: 'c1', name: 'write_file', arguments: '{"path":"a"}' });
  });

  it('falls back to /responses when /chat/completions stays silent', async () => {
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      paths.push(new URL(String(url)).pathname);
      return String(url).endsWith('/responses')
        ? json({ output: [{ type: 'message', content: [{ text: 'Hello' }] }] })
        : json(EMPTY);
    }) as any;

    const p = provider();
    const response = await p.sendMessage({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.content).toBe('Hello');
    expect(paths.at(-1)).toBe('/v1/responses');
    expect(p.describe().apiStyle).toBe('responses');

    // And it stays there.
    paths.length = 0;
    await p.sendMessage({ messages: [{ role: 'user', content: 'again' }] });
    expect(paths).toEqual(['/v1/responses']);
  });
});
