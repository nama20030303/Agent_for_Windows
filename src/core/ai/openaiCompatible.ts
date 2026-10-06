import type { AIProviderSettings, ChatMessage, TokenUsage, ToolDefinition } from '../shared/types.js';
import {
  AIProviderError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type RawToolCall,
  type StreamHandlers
} from './provider.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('ai');

interface RetryOptions {
  retries: number;
  baseDelayMs: number;
}

export function mapHttpError(status: number, body: string): AIProviderError {
  const snippet = body.slice(0, 400);
  switch (status) {
    case 400:
      return new AIProviderError(`Bad request (400). The model rejected the payload: ${snippet}`, 400, false, 'invalid_response');
    case 401:
      return new AIProviderError('Authentication failed (401). Check the API key in Settings.', 401, false, 'auth');
    case 403:
      return new AIProviderError('Access denied (403). The API key is not allowed to use this model.', 403, false, 'auth');
    case 404:
      return new AIProviderError('Endpoint or model not found (404). Check the Base URL and model name.', 404, false, 'not_found');
    case 408:
      return new AIProviderError('The provider timed out (408).', 408, true, 'timeout');
    case 429:
      return new AIProviderError('Rate limited (429). Retrying with backoff.', 429, true, 'rate_limit');
    case 500:
    case 502:
    case 503:
    case 504:
      return new AIProviderError(`Provider error (${status}). Retrying with backoff.`, status, true, 'server');
    default:
      return new AIProviderError(`Unexpected provider response ${status}: ${snippet}`, status, status >= 500, 'unknown');
  }
}

function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }))
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toWireTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

/**
 * Reasoning models (Nemotron, DeepSeek-R1 and friends) put their scratchpad in
 * `reasoning_content` and may leave `content` empty. Read every spelling in use.
 */
function readReasoning(source: any): string | undefined {
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = source?.[field];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string = 'openai-compatible';
  private tokens: TokenUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(
    public settings: AIProviderSettings,
    private retry: RetryOptions = { retries: 3, baseDelayMs: 800 }
  ) {}

  describe(): { model: string; baseUrl: string } {
    return { model: this.settings.model, baseUrl: this.settings.baseUrl };
  }

  usage(): TokenUsage {
    return { ...this.tokens };
  }

  resetUsage(): void {
    this.tokens = { requests: 0, inputTokens: 0, outputTokens: 0 };
  }

  private url(pathname: string): string {
    const base = this.settings.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/v1') || /\/v\d+$/.test(base) ? `${base}${pathname}` : `${base}/v1${pathname}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey) headers.Authorization = `Bearer ${this.settings.apiKey}`;
    return headers;
  }

  private async fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let lastError: AIProviderError | null = null;
    for (let attempt = 0; attempt <= this.retry.retries; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs || 120_000);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (res.ok) return res;
        const body = await res.text().catch(() => '');
        const error = mapHttpError(res.status, body);
        if (!error.retryable || attempt === this.retry.retries) throw error;
        lastError = error;
      } catch (err) {
        if (signal?.aborted) throw new AIProviderError('Request cancelled by the user.', undefined, false, 'cancelled');
        const e = err as Error;
        if (e instanceof AIProviderError) {
          if (!e.retryable || attempt === this.retry.retries) throw e;
          lastError = e;
        } else if (e.name === 'AbortError') {
          lastError = new AIProviderError(`Request timed out after ${this.settings.timeoutMs} ms.`, 408, true, 'timeout');
          if (attempt === this.retry.retries) throw lastError;
        } else {
          lastError = new AIProviderError(`Network error: ${e.message}`, undefined, true, 'network');
          if (attempt === this.retry.retries) throw lastError;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      const delay = this.retry.baseDelayMs * 2 ** attempt + Math.random() * 200;
      log.warn('Retrying provider request', { attempt: attempt + 1, delay: Math.round(delay), reason: lastError?.message });
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastError ?? new AIProviderError('Request failed.', undefined, false, 'unknown');
  }

  private body(request: ChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: this.settings.model,
      messages: toWireMessages(request.messages),
      tools: request.tools?.length ? toWireTools(request.tools) : undefined,
      tool_choice: request.tools?.length ? 'auto' : undefined,
      temperature: request.temperature ?? this.settings.temperature,
      max_tokens: request.maxTokens ?? this.settings.maxTokens,
      stream
    });
  }

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.fetchWithRetry(
      this.url('/chat/completions'),
      { method: 'POST', headers: this.headers(), body: this.body(request, false) },
      request.signal
    );
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new AIProviderError('Provider returned a non-JSON response.', res.status, false, 'invalid_response');
    }
    const choice = json?.choices?.[0];
    if (!choice) throw new AIProviderError('Provider response contained no choices.', res.status, false, 'invalid_response');
    const message = choice.message ?? {};
    const toolCalls: RawToolCall[] = (message.tool_calls ?? []).map((t: any, i: number) => ({
      id: t.id ?? `call_${i}`,
      name: t.function?.name ?? '',
      arguments: t.function?.arguments ?? '{}'
    }));
    this.tokens.requests += 1;
    this.tokens.inputTokens += json?.usage?.prompt_tokens ?? 0;
    this.tokens.outputTokens += json?.usage?.completion_tokens ?? 0;
    return {
      content: typeof message.content === 'string' ? message.content : '',
      reasoning: readReasoning(message),
      toolCalls,
      finishReason: choice.finish_reason ?? 'stop',
      usage: { inputTokens: json?.usage?.prompt_tokens ?? 0, outputTokens: json?.usage?.completion_tokens ?? 0 },
      raw: json
    };
  }

  async streamMessage(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const res = await this.fetchWithRetry(
      this.url('/chat/completions'),
      { method: 'POST', headers: { ...this.headers(), Accept: 'text/event-stream' }, body: this.body(request, true) },
      request.signal
    );
    if (!res.body) throw new AIProviderError('Streaming response had no body.', res.status, false, 'invalid_response');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    const partials = new Map<number, RawToolCall>();
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            let json: any;
            try {
              json = JSON.parse(payload);
            } catch {
              continue; // tolerate keep-alive / malformed frames
            }
            if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
            const choice = json.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content) {
              content += delta.content;
              handlers.onDelta?.(delta.content);
            }
            // Thinking models stream their scratchpad separately; collect it but
            // never forward it to the UI.
            const reasoningDelta = readReasoning(delta);
            if (reasoningDelta) reasoning += reasoningDelta;
            for (const tc of delta.tool_calls ?? []) {
              const index = tc.index ?? 0;
              const existing = partials.get(index) ?? { id: tc.id ?? `call_${index}`, name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              partials.set(index, existing);
              handlers.onToolCallDelta?.({ index, id: existing.id, name: tc.function?.name, argumentsDelta: tc.function?.arguments });
            }
          }
        }
      }
    } catch (err) {
      if (request.signal?.aborted) throw new AIProviderError('Request cancelled by the user.', undefined, false, 'cancelled');
      throw new AIProviderError(`Stream failed: ${(err as Error).message}`, undefined, true, 'network');
    }

    this.tokens.requests += 1;
    this.tokens.inputTokens += usage?.inputTokens ?? 0;
    this.tokens.outputTokens += usage?.outputTokens ?? 0;

    return { content, reasoning: reasoning || undefined, toolCalls: [...partials.values()].filter((t) => t.name), finishReason, usage };
  }

  async getModels(): Promise<string[]> {
    try {
      const res = await this.fetchWithRetry(this.url('/models'), { method: 'GET', headers: this.headers() });
      const json: any = await res.json();
      return (json?.data ?? []).map((m: any) => m.id).filter(Boolean);
    } catch {
      return [];
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string; modelAvailable?: boolean; models?: string[] }> {
    if (!this.settings.baseUrl) return { ok: false, message: 'Base URL is not configured.' };
    try {
      const models = await this.getModels();
      const response = await this.sendMessage({
        messages: [
          { role: 'system', content: 'Reply with the single word: ready' },
          { role: 'user', content: 'ping' }
        ],
        maxTokens: 16,
        temperature: 0
      });
      const modelAvailable = models.length === 0 ? undefined : models.includes(this.settings.model);
      return {
        ok: true,
        message: `Connection successful. Model responded (${response.content.trim().slice(0, 40) || 'empty content'}).`,
        modelAvailable,
        models
      };
    } catch (err) {
      const e = err as AIProviderError;
      return { ok: false, message: e.message, models: [] };
    }
  }
}
