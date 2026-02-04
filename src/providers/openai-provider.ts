import axios, { AxiosInstance } from 'axios';
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
  private _client: AxiosInstance | null = null;

  constructor(config?: OpenAIProviderConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.BOT_CLIENT_OPENAI_KEY;
    this.baseURL = config?.baseURL ?? DEFAULT_OPENAI_BASE;
  }

  private getClient(): AxiosInstance {
    if (this._client) return this._client;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    this._client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers
    });
    return this._client;
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const client = this.getClient();
      await client.get('/v1/models');
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    if (!this.apiKey) return [];

    try {
      const client = this.getClient();
      const response = await client.get('/v1/models');

      const models = response.data.data || [];
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
      this.handleError(error, 'OpenAI processing');
    }
  }
}
