import axios, { AxiosInstance } from 'axios';
import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com';

export interface AnthropicProviderConfig {
  apiKey?: string;
}

export class AnthropicProvider extends BaseProvider {
  private apiKey?: string;
  private _client: AxiosInstance | null = null;

  constructor(config?: AnthropicProviderConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.BOT_CLIENT_ANTHROPIC_KEY;
  }

  private getClient(): AxiosInstance {
    if (this._client) return this._client;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    this._client = axios.create({
      baseURL: ANTHROPIC_BASE,
      timeout: 30000,
      headers
    });
    return this._client;
  }

  async discoverModels(): Promise<string[]> {
    return [];
  }

  get providerId(): string {
    return 'anthropic';
  }

  get providerName(): string {
    return 'Anthropic';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      return this.createResponse(false, undefined, 'Anthropic API key required');
    }

    try {
      const client = this.getClient();
      const messages = buildChatMessages(request);
      const response = await client.post('/v1/messages', {
        model: request.modelId ?? 'claude-3-sonnet-20240229',
        messages,
        max_tokens: request.maxTokens ?? 1000,
        temperature: request.temperature ?? 0.7
      });

      const content = response.data.content?.[0]?.text ?? '';
      const modelUsed = request.modelId ?? 'claude-3-sonnet-20240229';
      return this.createResponse(true, content, undefined, modelUsed);
    } catch (error) {
      this.handleError(error, 'Anthropic processing');
    }
  }
}
