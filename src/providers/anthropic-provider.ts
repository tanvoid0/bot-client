import {
  AIRequest,
  AIResponse,
  AIProviderConfig
} from '../types/index.js';
import { BaseProvider } from './base-provider.js';

export interface AnthropicConfig {
  apiKey?: string;
  baseURL?: string;
  supportedModels?: string[];
  timeout?: number;
  retries?: number;
}

export class AnthropicProvider extends BaseProvider {
  private apiKey?: string;
  private baseURL: string;

  constructor(
    config: AIProviderConfig, 
    anthropicConfig?: AnthropicConfig
  ) {
    super(config);
    this.apiKey = anthropicConfig?.apiKey;
    this.baseURL = anthropicConfig?.baseURL || 'https://api.anthropic.com';
  }

  get providerId(): string {
    return 'anthropic';
  }

  get providerName(): string {
    return 'Anthropic';
  }

  get supportedModels(): string[] {
    return this.config.supportedModels;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      if (!this.apiKey) {
        throw new Error('Anthropic API key is required');
      }

      const mergedRequest = this.mergeRequestOptions(request);
      
      const client = this.getClient();
      const response = await client.post('/v1/messages', {
        model: mergedRequest.modelId,
        messages: this.buildMessages(mergedRequest),
        max_tokens: mergedRequest.maxTokens,
        temperature: mergedRequest.temperature
      });

      const data = response.data;
      const content = data.content?.[0]?.text || '';
      const usage = data.usage;

      return this.createSuccessResponse(
        content,
        mergedRequest.modelId,
        (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        this.calculateCost(usage?.input_tokens, usage?.output_tokens, mergedRequest.modelId)
      );

    } catch (error) {
      this.handleError(error, 'Anthropic processing');
    }
  }

  protected override createClient() {
    const client = super.createClient();
    client.defaults.baseURL = this.baseURL;
    return client;
  }

  private buildMessages(request: AIRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // Anthropic doesn't use system messages in the same way, so we prepend to the first user message
    let firstUserMessage = request.prompt;
    if (request.systemPrompt) {
      firstUserMessage = `${request.systemPrompt}\n\n${request.prompt}`;
    }

    if (request.history && request.history.length > 0) {
      request.history.forEach(msg => {
        messages.push({ 
          role: msg.role === 'assistant' ? 'assistant' : 'user', 
          content: msg.content 
        });
      });
    }

    messages.push({ role: 'user', content: firstUserMessage });

    return messages;
  }

  private calculateCost(inputTokens?: number, outputTokens?: number, model?: string): number | undefined {
    if (!inputTokens || !outputTokens || !model) return undefined;
    
    // Simplified cost calculation - can be enhanced with actual pricing
    const inputCostPer1k = model.includes('claude-3-opus') ? 0.015 : 0.003;
    const outputCostPer1k = model.includes('claude-3-opus') ? 0.075 : 0.015;
    
    return (inputTokens / 1000) * inputCostPer1k + (outputTokens / 1000) * outputCostPer1k;
  }
}
