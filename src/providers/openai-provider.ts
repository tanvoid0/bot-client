import {
  AIRequest,
  AIResponse,
  AIProviderConfig
} from '../types/index.js';
import { BaseProvider } from './base-provider.js';

export interface OpenAIConfig {
  apiKey?: string;
  baseURL?: string;
  supportedModels?: string[];
  timeout?: number;
  retries?: number;
}

export class OpenAIProvider extends BaseProvider {
  private apiKey?: string;
  private baseURL: string;

  constructor(
    config: AIProviderConfig, 
    openaiConfig?: OpenAIConfig
  ) {
    super(config);
    this.apiKey = openaiConfig?.apiKey;
    this.baseURL = openaiConfig?.baseURL || 'https://api.openai.com';
  }

  get providerId(): string {
    return 'openai';
  }

  get providerName(): string {
    return 'OpenAI';
  }

  get supportedModels(): string[] {
    return this.config.supportedModels;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      if (!this.apiKey) {
        throw new Error('OpenAI API key is required');
      }

      const mergedRequest = this.mergeRequestOptions(request);
      
      const client = this.getClient();
      const response = await client.post('/v1/chat/completions', {
        model: mergedRequest.modelId,
        messages: this.buildMessages(mergedRequest),
        max_tokens: mergedRequest.maxTokens,
        temperature: mergedRequest.temperature,
        stream: false
      });

      const data = response.data;
      const content = data.choices?.[0]?.message?.content || '';
      const usage = data.usage;

      return this.createSuccessResponse(
        content,
        mergedRequest.modelId,
        usage?.total_tokens,
        this.calculateCost(usage?.total_tokens, mergedRequest.modelId)
      );

    } catch (error) {
      this.handleError(error, 'OpenAI processing');
    }
  }

  protected override createClient() {
    const client = super.createClient();
    client.defaults.baseURL = this.baseURL;
    return client;
  }

  private buildMessages(request: AIRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    if (request.history && request.history.length > 0) {
      request.history.forEach(msg => {
        messages.push({ role: msg.role, content: msg.content });
      });
    }

    messages.push({ role: 'user', content: request.prompt });

    return messages;
  }

  private calculateCost(tokens?: number, model?: string): number | undefined {
    if (!tokens || !model) return undefined;
    
    // Simplified cost calculation - can be enhanced with actual pricing
    const costPer1kTokens = model.includes('gpt-4') ? 0.03 : 0.002;
    return (tokens / 1000) * costPer1kTokens;
  }
}
