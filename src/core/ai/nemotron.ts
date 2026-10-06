import type { AIProviderSettings } from '../shared/types.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';

export const NEMOTRON_MODEL = 'am/nemotron-3-ultra-550b-a55b';

export const DEFAULT_AI_SETTINGS: AIProviderSettings = {
  provider: 'nemotron',
  baseUrl: 'https://api.nemotron.ai/v1',
  model: NEMOTRON_MODEL,
  temperature: 0.2,
  maxTokens: 8192,
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
