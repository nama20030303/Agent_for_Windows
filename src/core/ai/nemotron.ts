import type { AIProviderSettings } from '../shared/types.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';

export const NEMOTRON_MODEL = 'am/nemotron-3-ultra-550b-a55b';

export const DEFAULT_AI_SETTINGS: AIProviderSettings = {
  provider: 'nemotron',
  // No endpoint is guessed: the user supplies the OpenAI-compatible base URL of
  // whichever host serves the model. Inventing a default only produces
  // confusing DNS failures.
  baseUrl: '',
  model: NEMOTRON_MODEL,
  temperature: 0.2,
  // Reasoning models spend tokens on an internal scratchpad before answering;
  // a small ceiling makes them return nothing at all.
  maxTokens: 16_384,
  timeoutMs: 180_000,
  streaming: true
};

/**
 * Nemotron is consumed through its OpenAI-compatible chat-completions API.
 * Only defaults differ from the generic provider, so the vendor is never
 * hard-coded anywhere else in the application.
 */
export class NemotronProvider extends OpenAICompatibleProvider {
  override readonly id: string = 'nemotron';

  constructor(settings: Partial<AIProviderSettings> = {}) {
    super({ ...DEFAULT_AI_SETTINGS, ...settings, model: settings.model || NEMOTRON_MODEL });
  }
}
