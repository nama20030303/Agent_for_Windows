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
import { withForcedBlock, withTextToolProtocol } from './textToolProtocol.js';
import { extractTextToolCalls } from './toolCallFallback.js';

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

/** How a single HTTP attempt asks for a tool call. */
type WireMode = 'native' | 'text' | 'forced';

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

/**
 * In compatibility mode the tool call is ordinary text, so it would otherwise
 * be typed out in the conversation. Forward the prose, stop at the fence.
 */
const HIDDEN = Symbol('hideToolBlocks');

export function hideToolBlocks(handlers: StreamHandlers): StreamHandlers {
  if ((handlers as any)[HIDDEN]) return handlers;
  let seen = '';
  let suppressed = false;
  const wrapped: StreamHandlers = {
    ...handlers,
    onDelta: (text: string) => {
      if (suppressed) return;
      seen += text;
      const fence = seen.indexOf('```');
      if (fence === -1) {
        handlers.onDelta?.(text);
        return;
      }
      suppressed = true;
      // Emit only the part that precedes the fence.
      const visibleSoFar = seen.slice(0, fence);
      const alreadyEmitted = seen.length - text.length;
      if (visibleSoFar.length > alreadyEmitted) handlers.onDelta?.(visibleSoFar.slice(alreadyEmitted));
    }
  };
  (wrapped as any)[HIDDEN] = true;
  return wrapped;
}

/**
 * The retry carries the model's own failed attempt, so it can see what was
 * wrong instead of repeating it.
 */
function retryRequest(request: ChatRequest, previous: ChatResponse): ChatRequest {
  const attempt = previous.content.trim();
  if (!attempt) return request;
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: attempt.slice(0, 2000) },
      {
        role: 'user',
        content:
          'That reply changed nothing on the computer, because describing an action does not perform it. ' +
          'This endpoint has no native function calling, so use the tool protocol from the system prompt: ' +
          'reply with one fenced tool_call block containing a single JSON object, exactly like the example.'
      }
    ]
  };
}

/** The tools a coding run cannot do without, in priority order. */
const CORE_TOOLS = [
  'finish',
  'write_file',
  'read_file',
  'edit_file',
  'list_directory',
  'execute_command',
  'run_tests',
  'ask_user'
];

/**
 * The smallest request that can still do the job: the system prompt, the tail
 * of the conversation and only the essential tools. Used when an endpoint
 * answers a full request with silence.
 */
function shrinkRequest(request: ChatRequest): ChatRequest {
  const system = request.messages.filter((m) => m.role === 'system').slice(0, 1);
  const rest = request.messages.filter((m) => m.role !== 'system');
  // Never start the tail on a tool result: it would have no call to belong to.
  let tail = rest.slice(-6);
  while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);

  const tools = request.tools?.length
    ? request.tools.filter((t) => CORE_TOOLS.includes(t.name))
    : request.tools;

  return { ...request, messages: [...system, ...tail], tools: tools?.length ? tools : request.tools };
}

function toWireTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

/**
 * `content` is a string in the OpenAI spec, but gateways in the wild also send
 * an array of parts, and completion-style proxies send `text`. Read all of
 * them: treating a valid answer as "empty" is how the agent ends up reporting
 * a configuration problem that does not exist.
 */
function readContent(message: any, choice?: any): string {
  const value = message?.content;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')))
      .filter((part: unknown): part is string => typeof part === 'string')
      .join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  return '';
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

  /**
   * Whether this endpoint really emits native tool calls. Decided from what it
   * actually does, not from what it claims: some endpoints accept the `tools`
   * parameter and then answer with an empty completion. Once proven absent,
   * every later request uses the textual protocol directly.
   */
  private nativeTools: 'unknown' | 'yes' | 'no' = 'unknown';

  /** Set when the endpoint only answers if max_tokens is left out entirely. */
  private omitMaxTokens = false;

  /** Set when it only answers to a small payload (few tools, short history). */
  private reducedPayload = false;

  constructor(
    public settings: AIProviderSettings,
    private retry: RetryOptions = { retries: 3, baseDelayMs: 800 }
  ) {}

  describe(): {
    model: string;
    baseUrl: string;
    nativeToolCalls?: 'unknown' | 'yes' | 'no';
    maxTokensOmitted?: boolean;
    payloadReduced?: boolean;
  } {
    return {
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      nativeToolCalls: this.nativeTools,
      maxTokensOmitted: this.omitMaxTokens,
      payloadReduced: this.reducedPayload
    };
  }

  /** True once the endpoint has been shown not to support function calling. */
  get usesTextToolProtocol(): boolean {
    return this.nativeTools === 'no';
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

  /**
   * `undefined` removes the field from the payload entirely, which is both the
   * "no limit" setting and the recovery for endpoints that answer with nothing
   * when max_tokens exceeds what the model allows.
   */
  private tokenBudget(request: ChatRequest): number | undefined {
    if (this.omitMaxTokens) return undefined;
    const value = request.maxTokens ?? this.settings.maxTokens;
    return value && value > 0 ? value : undefined;
  }

  private body(request: ChatRequest, stream: boolean, mode: WireMode): string {
    const textMode = mode !== 'native';
    const useTools = !textMode && !!request.tools?.length;
    let messages = textMode && request.tools?.length
      ? withTextToolProtocol(request.messages, request.tools)
      : request.messages;
    if (mode === 'forced') messages = withForcedBlock(messages);
    return JSON.stringify({
      model: this.settings.model,
      messages: toWireMessages(messages),
      tools: useTools ? toWireTools(request.tools!) : undefined,
      tool_choice: useTools ? 'auto' : undefined,
      temperature: request.temperature ?? this.settings.temperature,
      max_tokens: this.tokenBudget(request),
      stream
    });
  }

  /**
   * An endpoint that answers a tools-bearing request with nothing at all is
   * telling us it cannot handle `tools`. Rather than reporting a dead end,
   * drop the parameter, describe the tools in the prompt and try once more.
   */
  /** The turn produced nothing the application can run. */
  private lacksCall(request: ChatRequest, response: ChatResponse): boolean {
    if (!request.tools?.length) return false;
    if (response.toolCalls.length) return false;
    // A truncated reply says nothing about capability; it is a budget problem.
    if (response.finishReason === 'length') return false;

    // Nothing at all came back: the endpoint choked on the `tools` parameter.
    if (!response.content.trim()) return true;

    // It answered, but the caller needed an action. If the text already holds a
    // usable call the endpoint is fine as it is; otherwise this model is not
    // going to emit native calls, so stop asking it to.
    if (!request.requireToolCall) return false;
    return this.textCalls(request, response.content) === 0;
  }

  private needsTextProtocol(request: ChatRequest, response: ChatResponse): boolean {
    return this.nativeTools !== 'no' && this.lacksCall(request, response);
  }

  /** Nothing usable at all: no answer, no reasoning, no call. */
  private isSilent(response: ChatResponse): boolean {
    return !response.content.trim() && !response.reasoning?.trim() && response.toolCalls.length === 0;
  }

  /**
   * Run one attempt, and if the endpoint says literally nothing, find a shape
   * of request it will answer. Both discoveries stick for the session.
   */
  private async attempt(request: ChatRequest, mode: WireMode, handlers?: StreamHandlers): Promise<ChatResponse> {
    const run = (req: ChatRequest) =>
      handlers ? this.streamOnce(req, handlers, mode) : this.sendOnce(req, mode);

    const shaped = this.reducedPayload ? shrinkRequest(request) : request;
    const first = await run(shaped);
    if (!this.isSilent(first)) return first;

    // A silent reply to a tools request is most often the tools parameter
    // itself. Let the caller try the textual protocol before reshaping the
    // request, so the cheaper and more likely fix is attempted first.
    if (mode === 'native' && request.tools?.length) return first;

    // A. The token budget may exceed what this model accepts.
    if (!this.omitMaxTokens && this.tokenBudget(request) !== undefined) {
      this.omitMaxTokens = true;
      log.warn('Empty reply; retrying without max_tokens', { model: this.settings.model });
      handlers?.onRestart?.();
      const retry = await run(shaped);
      if (!this.isSilent(retry)) return retry;
    }

    // B. The payload may simply be too big for the endpoint to handle.
    if (!this.reducedPayload) {
      log.warn('Empty reply; retrying with a reduced payload', { model: this.settings.model });
      handlers?.onRestart?.();
      const retry = await run(shrinkRequest(request));
      if (!this.isSilent(retry)) {
        this.reducedPayload = true;
        return retry;
      }
    }
    return first;
  }

  private textCalls(request: ChatRequest, content: string): number {
    return extractTextToolCalls(content, request.tools?.map((t) => t.name)).calls.length;
  }

  /**
   * The model was prefilled with an open brace, so its continuation is the
   * rest of the JSON. Put the brace back before anyone tries to parse it.
   */
  private repairPrefilled(request: ChatRequest, response: ChatResponse): ChatResponse {
    if (this.textCalls(request, response.content)) return response;
    const patched = `{${response.content.trimStart()}`;
    if (!this.textCalls(request, patched)) return response;
    return { ...response, content: patched };
  }

  private noteCapability(request: ChatRequest, response: ChatResponse): void {
    if (request.tools?.length && response.toolCalls.length) this.nativeTools = 'yes';
  }

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const first = await this.attempt(request, this.usesTextToolProtocol ? 'text' : 'native');
    if (!this.lacksCall(request, first)) {
      this.noteCapability(request, first);
      return first;
    }

    // Step 2: describe the tools in the prompt, show a worked example, and
    // show the model its own failed attempt.
    const wasNative = this.nativeTools !== 'no';
    this.nativeTools = 'no';
    if (wasNative) {
      log.warn('Endpoint produced no tool call; switching to the textual tool protocol', {
        model: this.settings.model,
        hadContent: !!first.content.trim()
      });
    }
    const second = await this.attempt(retryRequest(request, first), 'text');
    if (!this.lacksCall(request, second)) return second;

    // Step 3: open the block for it and let it only finish the JSON.
    log.warn('Still no tool call in compatibility mode; forcing the block open', { model: this.settings.model });
    try {
      const third = await this.attempt(retryRequest(request, second), 'forced');
      return this.repairPrefilled(request, third);
    } catch (err) {
      // Not every endpoint accepts a trailing assistant message. Falling back
      // to the previous answer keeps the run alive and reportable.
      log.warn('Forced-block attempt rejected by the endpoint', { reason: (err as Error).message });
      return second;
    }
  }

  private async sendOnce(request: ChatRequest, mode: WireMode): Promise<ChatResponse> {
    const res = await this.fetchWithRetry(
      this.url('/chat/completions'),
      { method: 'POST', headers: this.headers(), body: this.body(request, false, mode) },
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
    // Pre-2023-11 shape, still emitted by several gateways and by llama.cpp.
    if (!toolCalls.length && message.function_call?.name) {
      toolCalls.push({
        id: 'call_0',
        name: message.function_call.name,
        arguments:
          typeof message.function_call.arguments === 'string'
            ? message.function_call.arguments
            : JSON.stringify(message.function_call.arguments ?? {})
      });
    }
    this.tokens.requests += 1;
    this.tokens.inputTokens += json?.usage?.prompt_tokens ?? 0;
    this.tokens.outputTokens += json?.usage?.completion_tokens ?? 0;
    return {
      content: readContent(message, choice),
      reasoning: readReasoning(message),
      toolCalls,
      finishReason: choice.finish_reason ?? 'stop',
      usage: { inputTokens: json?.usage?.prompt_tokens ?? 0, outputTokens: json?.usage?.completion_tokens ?? 0 },
      raw: json
    };
  }

  async streamMessage(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const first = await this.attempt(request, this.usesTextToolProtocol ? 'text' : 'native', handlers);
    if (!this.lacksCall(request, first)) {
      this.noteCapability(request, first);
      return first;
    }
    this.nativeTools = 'no';
    log.warn('Endpoint streamed no tool call; switching to the textual tool protocol', {
      model: this.settings.model,
      hadContent: !!first.content.trim()
    });
    // Each retry replaces the answer, so the UI must drop what it has shown.
    handlers.onRestart?.();
    const second = await this.attempt(retryRequest(request, first), 'text', handlers);
    if (!this.lacksCall(request, second)) return second;

    handlers.onRestart?.();
    try {
      const third = await this.attempt(retryRequest(request, second), 'forced', handlers);
      return this.repairPrefilled(request, third);
    } catch (err) {
      log.warn('Forced-block attempt rejected by the endpoint', { reason: (err as Error).message });
      return second;
    }
  }

  private async streamOnce(request: ChatRequest, handlers: StreamHandlers, mode: WireMode): Promise<ChatResponse> {
    if (mode !== 'native') handlers = hideToolBlocks(handlers);
    const res = await this.fetchWithRetry(
      this.url('/chat/completions'),
      {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: this.body(request, true, mode)
      },
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
            const chunk = readContent(delta, choice);
            if (chunk) {
              content += chunk;
              handlers.onDelta?.(chunk);
            }
            // Thinking models stream their scratchpad separately; collect it but
            // never forward it to the UI.
            const reasoningDelta = readReasoning(delta);
            if (reasoningDelta) reasoning += reasoningDelta;
            if (delta.function_call?.name || delta.function_call?.arguments) {
              const existing = partials.get(0) ?? { id: 'call_0', name: '', arguments: '' };
              if (delta.function_call.name) existing.name = delta.function_call.name;
              if (typeof delta.function_call.arguments === 'string') existing.arguments += delta.function_call.arguments;
              partials.set(0, existing);
            }
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

  async testConnection(): Promise<{
    ok: boolean;
    message: string;
    modelAvailable?: boolean;
    models?: string[];
    toolCalling?: boolean;
  }> {
    if (!this.settings.baseUrl) return { ok: false, message: 'Base URL is not configured.' };
    try {
      const models = await this.getModels();
      const response = await this.sendMessage({
        messages: [
          { role: 'system', content: 'Reply with the single word: ready' },
          { role: 'user', content: 'ping' }
        ],
        maxTokens: 512,
        temperature: 0
      });
      const modelAvailable = models.length === 0 ? undefined : models.includes(this.settings.model);
      const toolCalling = await this.probeToolCalling();

      const reachable = response.content.trim() || (response.reasoning ? 'reasoning only' : 'empty content');
      const toolNote =
        toolCalling === true
          ? 'Native tool calling works.'
          : toolCalling === false
            ? 'This endpoint did not return a native tool call, so the agent switched to its textual tool ' +
              'protocol automatically. That works, but it depends on the model following the format — a ' +
              'model advertised with function calling is more reliable.'
            : 'Tool calling could not be verified.';

      return {
        ok: true,
        message: `Connection successful. Model responded (${reachable}). ${toolNote}`,
        modelAvailable,
        models,
        toolCalling
      };
    } catch (err) {
      const e = err as AIProviderError;
      return { ok: false, message: e.message, models: [] };
    }
  }

  /**
   * Ask the model to make one trivial tool call. Whether it comes back decides
   * if this endpoint can drive the agent natively — the single most important
   * capability, and the one providers document least reliably.
   */
  private async probeToolCalling(): Promise<boolean | undefined> {
    try {
      const response = await this.sendMessage({
        messages: [{ role: 'user', content: 'Call the tool `ping_probe` with value "x". Use the tool, do not answer in text.' }],
        tools: [
          {
            name: 'ping_probe',
            description: 'Connectivity probe. Call it with the given value.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string', description: 'Any string' } },
              required: ['value'],
              additionalProperties: false
            },
            category: 'meta',
            risk: 'SAFE',
            mutating: false
          }
        ],
        maxTokens: 1024,
        temperature: 0
      });
      if (response.toolCalls.some((call) => call.name === 'ping_probe')) return true;
      // A textual call still proves the agent can drive this endpoint, but it
      // is not native support, so remember that and report it as such.
      if (extractTextToolCalls(response.content).calls.some((call) => call.name === 'ping_probe')) {
        this.nativeTools = 'no';
      }
      return false;
    } catch {
      return undefined;
    }
  }
}
