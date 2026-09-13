import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const DEFAULT_LMSTUDIO_BASE = 'http://localhost:1234';

export interface LMStudioProviderConfig {
  baseURL?: string;
}

export class LMStudioProvider extends BaseProvider {
  private readonly baseURL: string;

  constructor(config?: LMStudioProviderConfig) {
    super();
    this.baseURL = config?.baseURL ?? DEFAULT_LMSTUDIO_BASE;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.http(`${this.baseURL}/v1/models`);
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    try {
      const response = await this.http(`${this.baseURL}/v1/models`);

      const models = response.data || [];
      // Only include chat/LLM models; exclude embedding models (e.g. "text-embedding-*") so
      // default model for generate() is valid for /v1/chat/completions.
      const chatModels = models.filter(
        (m: { id: string; object?: string }) => !/embed/i.test(m.id ?? '')
      );
      this._supportedModels = chatModels.map((m: { id: string }) => m.id);

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
      const defaultModel = this.supportedModels[0];
      if (!request.modelId && !defaultModel) {
        return this.createResponse(
          false,
          undefined,
          'No chat models available (only embedding models may be loaded)',
          undefined
        );
      }
      const messages = buildChatMessages(request);
      const response = await this.http(`${this.baseURL}/v1/chat/completions`, { body: {
        model: request.modelId ?? defaultModel,
        messages,
        max_tokens: request.maxTokens ?? 1000,
        temperature: request.temperature ?? 0.7
      } });

      const content = response.choices?.[0]?.message?.content ?? '';
      return this.createResponse(true, content, undefined, request.modelId);
    } catch (error) {
      this.handleError(error, 'LM Studio processing');
    }
  }
}
