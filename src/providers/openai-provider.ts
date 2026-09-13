import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const DEFAULT_OPENAI_BASE = 'https://api.openai.com';

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

export class OpenAIProvider extends BaseProvider {
  private apiKey?: string;
  private baseURL: string;
  private readonly headers: Record<string, string>;

  constructor(config?: OpenAIProviderConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.BOT_CLIENT_OPENAI_KEY;
    this.baseURL = config?.baseURL ?? DEFAULT_OPENAI_BASE;
    this.headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.http(`${this.baseURL}/v1/models`, { headers: this.headers });
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    if (!this.apiKey) return [];

    try {
      const response = await this.http(`${this.baseURL}/v1/models`, { headers: this.headers });

      const models = response.data || [];
      this._supportedModels = models
        .filter((m: { id?: string }) => m.id?.includes('gpt'))
        .map((m: { id: string }) => m.id);

      return this._supportedModels;
    } catch {
      return [];
    }
  }

  get providerId(): string {
    return 'openai';
  }

  get providerName(): string {
    return 'OpenAI';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      return this.createResponse(false, undefined, 'OpenAI API key required');
    }

    try {
      const messages = buildChatMessages(request);
      const response = await this.http(`${this.baseURL}/v1/chat/completions`, { headers: this.headers, body: {
        model: request.modelId ?? this.supportedModels[0],
        messages,
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
        temperature: request.temperature ?? 0.7,
        ...(request.jsonMode && { response_format: { type: 'json_object' } })
      } });

      const content = response.choices?.[0]?.message?.content ?? '';
      const usage = response.usage;
      return this.createResponse(true, content, undefined, request.modelId, {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens
      });
    } catch (error) {
      this.handleError(error, 'OpenAI processing');
    }
  }
}
