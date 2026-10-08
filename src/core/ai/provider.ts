import type { AIProviderSettings, ChatMessage, ToolDefinition, TokenUsage } from '../shared/types.js';

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /**
   * The caller needs an action, not an opinion: this turn is only useful if it
   * produces a tool call. Set in Agent/Auto mode. It lets the provider treat a
   * chatty reply as proof that the endpoint cannot do function calling and
   * switch to the textual protocol, instead of returning prose nobody can run.
   */
  requireToolCall?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface RawToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResponse {
  content: string;
  toolCalls: RawToolCall[];
  /**
   * Internal reasoning emitted by thinking models in `reasoning_content`.
   * Captured only so the application can detect a reasoning-only reply and
   * report it honestly — it is never shown to the user or persisted.
   */
  reasoning?: string;
  finishReason: string;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
}

export interface StreamHandlers {
  onDelta?: (text: string) => void;
  /**
   * The provider is discarding what it streamed so far and starting the answer
   * again (it fell back to the textual tool protocol). The UI must drop the
   * partial message rather than append to it.
   */
  onRestart?: () => void;
  onToolCallDelta?: (partial: { index: number; id?: string; name?: string; argumentsDelta?: string }) => void;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly kind:
      | 'auth'
      | 'not_found'
      | 'rate_limit'
      | 'timeout'
      | 'server'
      | 'network'
      | 'invalid_response'
      | 'cancelled'
      | 'unknown' = 'unknown'
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export interface AIProvider {
  readonly id: string;
  settings: AIProviderSettings;
  sendMessage(request: ChatRequest): Promise<ChatResponse>;
  streamMessage(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse>;
  testConnection(): Promise<{
    ok: boolean;
    message: string;
    modelAvailable?: boolean;
    models?: string[];
    /** Whether the endpoint actually returned a native tool call when asked. */
    toolCalling?: boolean;
  }>;
  getModels(): Promise<string[]>;
  usage(): TokenUsage;
  /** Model and endpoint, for diagnostics. Never includes the API key. */
  describe(): { model: string; baseUrl: string; nativeToolCalls?: 'unknown' | 'yes' | 'no' };
}
