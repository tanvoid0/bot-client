import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const DEFAULT_LMSTUDIO_BASE = 'http://localhost:1234';

export interface LMStudioProviderConfig {
  baseURL?: string;
}

export class LMStudioProvider extends BaseProvider {
  private readonly baseURL: string;
  private _client: ReturnType<BaseProvider['createClient']> | null = null;

  constructor(config?: LMStudioProviderConfig) {
    super();
    this.baseURL = config?.baseURL ?? DEFAULT_LMSTUDIO_BASE;
  }

  private getClient(): ReturnType<BaseProvider['createClient']> {
    if (this._client) return this._client;
    this._client = this.createClient(this.baseURL);
    return this._client;
  }

  async testConnection(): Promise<boolean> {
    try {
      const client = this.getClient();
      await client.get('/v1/models');
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    try {
      const client = this.getClient();
      const response = await client.get('/v1/models');

      const models = response.data.data || [];
      this._supportedModels = models.map((m: { id: string }) => m.id);

      return this._supportedModels;
    } catch {
      return [];
    }
  }

  get providerId(): string {
    return 'lmstudio';
  }

  get providerName(): string {
    return 'LM Studio';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      const client = this.getClient();
      const messages = buildChatMessages(request);
      const response = await client.post('/v1/chat/completions', {
        model: request.modelId ?? this.supportedModels[0],
        messages,
        max_tokens: request.maxTokens ?? 1000,
        temperature: request.temperature ?? 0.7
      });

      const content = response.data.choices?.[0]?.message?.content ?? '';
      return this.createResponse(true, content, undefined, request.modelId);
    } catch (error) {
      this.handleError(error, 'LM Studio processing');
    }
  }
}
