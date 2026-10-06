import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../src/core/ai/openaiCompatible.js';
import { NemotronProvider, NEMOTRON_MODEL } from '../src/core/ai/nemotron.js';
import { AIProviderError } from '../src/core/ai/provider.js';
import type { AIProviderSettings } from '../src/core/shared/types.js';

const settings: AIProviderSettings = {
  provider: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 2000,
  streaming: true
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(frames: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible provider', () => {
  it('sends a well-formed request and parses tool calls', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('test-model');
      expect(body.tools[0].function.name).toBe('read_file');
      return jsonResponse({
        choices: [
          {
            message: {
              content: 'reading',
              tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.py"}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider(settings);
    const response = await provider.sendMessage({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'read', category: 'filesystem', risk: 'SAFE', mutating: false, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
    });
    expect(response.toolCalls[0]).toMatchObject({ name: 'read_file' });
    expect(provider.usage()).toMatchObject({ requests: 1, inputTokens: 12, outputTokens: 4 });
  });

  it('maps authentication failures without retrying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider(settings, { retries: 3, baseDelayMs: 1 });
    await expect(provider.sendMessage({ messages: [] })).rejects.toThrow(/Authentication failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries rate limits with backoff and eventually succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls < 3) return jsonResponse({ error: 'slow down' }, 429);
      return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    });
    const provider = new OpenAICompatibleProvider(settings, { retries: 3, baseDelayMs: 1 });
    const response = await provider.sendMessage({ messages: [] });
    expect(response.content).toBe('ok');
    expect(calls).toBe(3);
  });

  it('surfaces server errors after exhausting retries', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({}, 503));
    const provider = new OpenAICompatibleProvider(settings, { retries: 1, baseDelayMs: 1 });
    await expect(provider.sendMessage({ messages: [] })).rejects.toBeInstanceOf(AIProviderError);
  });

  it('handles a non-JSON response without crashing', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>gateway</html>', { status: 200 }));
    const provider = new OpenAICompatibleProvider(settings, { retries: 0, baseDelayMs: 1 });
    await expect(provider.sendMessage({ messages: [] })).rejects.toThrow(/non-JSON/);
  });

  it('handles network failures', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('getaddrinfo ENOTFOUND example.test');
    });
    const provider = new OpenAICompatibleProvider(settings, { retries: 0, baseDelayMs: 1 });
    await expect(provider.sendMessage({ messages: [] })).rejects.toThrow(/Network error/);
  });

  it('streams deltas and assembles tool calls', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        'not-json-keepalive',
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'write_', arguments: '{"path":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] })
      ])
    );
    const provider = new OpenAICompatibleProvider(settings);
    const deltas: string[] = [];
    const response = await provider.streamMessage({ messages: [] }, { onDelta: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('Hello');
    expect(response.toolCalls[0]).toMatchObject({ name: 'write_file', arguments: '{"path":"a.txt"}' });
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const provider = new OpenAICompatibleProvider(settings, { retries: 0, baseDelayMs: 1 });
    const promise = provider.sendMessage({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('reports connection test results', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/models')
        ? jsonResponse({ data: [{ id: NEMOTRON_MODEL }] })
        : jsonResponse({ choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] })
    );
    const provider = new NemotronProvider({ baseUrl: 'https://example.test/v1', apiKey: 'k' });
    const result = await provider.testConnection();
    expect(result.ok).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(provider.settings.model).toBe(NEMOTRON_MODEL);
  });

  it('normalises base URLs with and without /v1', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return jsonResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] });
    });
    await new OpenAICompatibleProvider({ ...settings, baseUrl: 'https://a.test' }).sendMessage({ messages: [] });
    await new OpenAICompatibleProvider({ ...settings, baseUrl: 'https://a.test/v1/' }).sendMessage({ messages: [] });
    expect(seen).toEqual(['https://a.test/v1/chat/completions', 'https://a.test/v1/chat/completions']);
  });
});
