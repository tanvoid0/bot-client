import {
  AIRequest,
  AIResponse,
  AIProviderConfig
} from '../types/index.js';
import { BaseProvider } from './base-provider.js';

export interface LMStudioConfig {
  host?: string;
  port?: number;
  supportedModels?: string[];
  timeout?: number;
  retries?: number;
}

export class LMStudioProvider extends BaseProvider {
  private host: string;
  private port: number;
  private _supportedModels: string[] = [];

  constructor(
    config: AIProviderConfig, 
    lmstudioConfig?: LMStudioConfig
  ) {
    super(config);
    this.host = lmstudioConfig?.host || 'localhost';
    this.port = lmstudioConfig?.port || 1234;
    
    // Initialize supported models from config or fallback to defaults
    if (lmstudioConfig?.supportedModels) {
      this._supportedModels = lmstudioConfig.supportedModels;
    }
  }

  get providerId(): string {
    return 'lmstudio';
  }

  get providerName(): string {
    return 'LM Studio';
  }

  get supportedModels(): string[] {
    return this._supportedModels.length > 0 ? this._supportedModels : this.config.supportedModels;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      const mergedRequest = this.mergeRequestOptions(request);
      
      // If no model is specified, try to get the first available model
      let modelToUse = mergedRequest.modelId;
      if (!modelToUse) {
        const availableModels = await this.fetchAvailableModels();
        if (availableModels.length > 0) {
          modelToUse = availableModels[0];
        } else {
          throw new Error('No models available in LM Studio');
        }
      }
      
      const client = this.getClient();
      const response = await client.post('/v1/chat/completions', {
        model: modelToUse,
        messages: this.buildMessages(mergedRequest),
        max_tokens: mergedRequest.maxTokens,
        temperature: mergedRequest.temperature
      });

      const data = response.data;
      const content = data.choices?.[0]?.message?.content || '';
      const usage = data.usage?.total_tokens || 0;

      return this.createSuccessResponse(
        content,
        modelToUse,
        usage
      );

    } catch (error) {
      this.handleError(error, 'LM Studio processing');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Try to get available models
      await this.fetchAvailableModels();
      return true;
    } catch (error) {
      return false;
    }
  }

  async fetchAvailableModels(): Promise<string[]> {
    try {
      const client = this.getClient();
      const response = await client.get('/v1/models');
      const models = response.data.data || [];
      this._supportedModels = models.map((model: any) => model.id);
      return this._supportedModels;
    } catch (error) {
      // Fallback to configured models if API call fails
      return this.config.supportedModels;
    }
  }

  protected override createClient() {
    const client = super.createClient();
    client.defaults.baseURL = `http://${this.host}:${this.port}`;
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
}
