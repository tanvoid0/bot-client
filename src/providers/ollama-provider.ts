import {
  AIRequest,
  AIResponse,
  AIProviderConfig
} from '../types/index.js';
import { BaseProvider } from './base-provider.js';

export interface OllamaConfig {
  host?: string;
  port?: number;
  supportedModels?: string[];
  timeout?: number;
  retries?: number;
}

export class OllamaProvider extends BaseProvider {
  private host: string;
  private port: number;
  private _supportedModels: string[] = [];

  constructor(
    config: AIProviderConfig, 
    ollamaConfig?: OllamaConfig
  ) {
    super(config);
    this.host = ollamaConfig?.host || 'localhost';
    this.port = ollamaConfig?.port || 11434;
    
    // Initialize supported models from config or fallback to defaults
    if (ollamaConfig?.supportedModels) {
      this._supportedModels = ollamaConfig.supportedModels;
    }
  }

  get providerId(): string {
    return 'ollama';
  }

  get providerName(): string {
    return 'Ollama';
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
          throw new Error('No models available in Ollama');
        }
      }
      
      const client = this.getClient();
      const response = await client.post('/api/chat', {
        model: modelToUse,
        messages: this.buildMessages(mergedRequest),
        options: {
          temperature: mergedRequest.temperature,
          num_predict: mergedRequest.maxTokens
        }
      });

      const data = response.data;
      const content = data.message?.content || '';
      const usage = data.eval_count || 0;

      return this.createSuccessResponse(
        content,
        modelToUse,
        usage
      );

    } catch (error) {
      this.handleError(error, 'Ollama processing');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // First try to get available models
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _models = await this.fetchAvailableModels();
      return true;
    } catch (error) {
      return false;
    }
  }

  async fetchAvailableModels(): Promise<string[]> {
    try {
      const client = this.getClient();
      const response = await client.get('/api/tags');
      
      const models = response.data.models || [];
      this._supportedModels = models.map((model: any) => model.name);
      
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
