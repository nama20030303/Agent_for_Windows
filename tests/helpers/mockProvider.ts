import type { AIProvider, ChatRequest, ChatResponse, StreamHandlers } from '../../src/core/ai/provider.js';
import type { AIProviderSettings, TokenUsage } from '../../src/core/shared/types.js';

export interface ScriptedTurn {
  content?: string;
  /** Simulates a thinking model that replies with a scratchpad and no answer. */
  reasoning?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  finishReason?: string;
}

/**
 * Deterministic provider used only by the test-suite: it replays a scripted
 * sequence of model turns so the agent loop can be exercised without network.
 */
export class MockProvider implements AIProvider {
  readonly id = 'mock';
  settings: AIProviderSettings = {
    provider: 'custom',
    baseUrl: 'http://mock',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 1000,
    timeoutMs: 10_000,
    streaming: false
  };
  readonly requests: ChatRequest[] = [];
  private index = 0;
  private counter = 0;

  constructor(private script: ScriptedTurn[] | ((request: ChatRequest, turn: number) => ScriptedTurn)) {}

  private next(request: ChatRequest): ChatResponse {
    this.requests.push(request);
    const turn = typeof this.script === 'function' ? this.script(request, this.index) : this.script[this.index];
    this.index++;
    const spec = turn ?? { content: 'No more scripted turns.' };
    return {
      content: spec.content ?? '',
      reasoning: spec.reasoning,
      toolCalls: (spec.toolCalls ?? []).map((t) => ({
        id: `call_${++this.counter}`,
        name: t.name,
        arguments: JSON.stringify(t.arguments)
      })),
      finishReason: spec.finishReason ?? (spec.toolCalls?.length ? 'tool_calls' : 'stop'),
      usage: { inputTokens: 100, outputTokens: 50 }
    };
  }

  async findWorkingSetup() {
    return { ok: true, model: this.settings.model, apiStyle: 'chat' as const, tried: [], models: [this.settings.model], message: 'mock' };
  }

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    return this.next(request);
  }

  async streamMessage(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const response = this.next(request);
    if (response.content) handlers.onDelta?.(response.content);
    return response;
  }

  async testConnection() {
    return { ok: true, message: 'mock' };
  }

  async getModels() {
    return ['mock-model'];
  }

  describe(): { model: string; baseUrl: string } {
    return { model: this.settings.model, baseUrl: this.settings.baseUrl };
  }

  usage(): TokenUsage {
    return { requests: this.index, inputTokens: 100 * this.index, outputTokens: 50 * this.index };
  }
}
