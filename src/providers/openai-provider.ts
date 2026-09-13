import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';

export interface OpenAIProviderConfig extends Omit<OpenAICompatibleConfig, 'id' | 'name' | 'requireApiKey' | 'apiKeyEnv'> {
  apiKey?: string;
  baseURL?: string;
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: OpenAIProviderConfig = {}) {
    super({
      modelFilter: (id) => id.includes('gpt') || /^o\d/.test(id),
      ...config,
      id: 'openai',
      name: 'OpenAI',
      requireApiKey: true,
      apiKeyEnv: ['OPENAI_API_KEY', 'BOT_CLIENT_OPENAI_KEY'],
    });
  }
}
