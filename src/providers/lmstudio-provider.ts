/** @module llmwire/lmstudio */
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { AIRequest, AIResponse } from '../types/index.js';

export interface LMStudioProviderConfig extends Omit<OpenAICompatibleConfig, 'id' | 'name' | 'requireApiKey' | 'apiKeyEnv'> {
  baseURL?: string;
}

const DEFAULT_LMSTUDIO_BASE = 'http://localhost:1234';

export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(config: LMStudioProviderConfig = {}) {
    super({
      baseURL: DEFAULT_LMSTUDIO_BASE,
      // Embedding models cannot answer /chat/completions, so keep them out of the default pick.
      modelFilter: (id) => !/embed/i.test(id),
      defaultMaxTokens: 1000,
      ...config,
      id: 'lmstudio',
      name: 'LM Studio',
    });
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!request.modelId && !this.supportedModels[0]) {
      return this.fail(
        this.error('NO_MODEL', 'No chat models available (only embedding models may be loaded)', {
          hint: 'Load a chat model in LM Studio, or pass modelId.',
        })
      );
    }
    return super.process(request);
  }
}
