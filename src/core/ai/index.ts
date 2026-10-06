import type { AIProviderSettings } from '../shared/types.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { NemotronProvider, DEFAULT_AI_SETTINGS, NEMOTRON_MODEL } from './nemotron.js';
import type { AIProvider } from './provider.js';

export * from './provider.js';
export { OpenAICompatibleProvider, NemotronProvider, DEFAULT_AI_SETTINGS, NEMOTRON_MODEL };

export function createProvider(settings: AIProviderSettings): AIProvider {
  switch (settings.provider) {
    case 'nemotron':
      return new NemotronProvider(settings);
    case 'openai-compatible':
    case 'custom':
    default:
      return new OpenAICompatibleProvider(settings);
  }
}
