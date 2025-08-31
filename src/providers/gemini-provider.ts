import {
  AIRequest,
  AIResponse,
  AIProviderConfig
} from '../types/index.js';
import { BaseProvider } from './base-provider.js';

export interface GeminiConfig {
  apiKey?: string;
  baseURL?: string;
  supportedModels?: string[];
  timeout?: number;
  retries?: number;
}

export class GeminiProvider extends BaseProvider {
  private apiKey?: string;
  private baseURL: string;
  private _supportedModels: string[] = [];

  constructor(
    config: AIProviderConfig, 
    geminiConfig?: GeminiConfig
  ) {
    super(config);
    this.apiKey = geminiConfig?.apiKey;
    this.baseURL = geminiConfig?.baseURL || 'https://generativelanguage.googleapis.com';
    
    // Initialize supported models from config or fallback to defaults
    if (geminiConfig?.supportedModels) {
      this._supportedModels = geminiConfig.supportedModels;
    }
  }

  get providerId(): string {
    return 'gemini';
  }

  get providerName(): string {
    return 'Google Gemini';
  }

  get supportedModels(): string[] {
    return this._supportedModels.length > 0 ? this._supportedModels : this.config.supportedModels;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      if (!this.apiKey) {
        throw new Error('Gemini API key is required');
      }

      const mergedRequest = this.mergeRequestOptions(request);
      
      const client = this.getClient();
      const response = await client.post(`/v1beta/models/${mergedRequest.modelId}:generateContent`, {
        contents: this.buildContents(mergedRequest),
        generationConfig: {
          maxOutputTokens: mergedRequest.maxTokens,
          temperature: mergedRequest.temperature,
          topP: 0.8,
          topK: 40
        }
      }, {
        params: {
          key: this.apiKey
        }
      });

      const data = response.data;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const usage = data.usageMetadata;

      return this.createSuccessResponse(
        content,
        mergedRequest.modelId,
        usage?.totalTokenCount
      );

    } catch (error) {
      this.handleError(error, 'Gemini processing');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.apiKey) {
        return false;
      }
      // Try to get available models
      await this.fetchAvailableModels();
      return true;
    } catch (error) {
      return false;
    }
  }

  async fetchAvailableModels(): Promise<string[]> {
    try {
      if (!this.apiKey) {
        return this.config.supportedModels;
      }

      const client = this.getClient();
      const response = await client.get('/v1beta/models', {
        params: {
          key: this.apiKey
        }
      });
      
      const models = response.data.models || [];
      this._supportedModels = models
        .filter((model: any) => model.name.includes('gemini'))
        .map((model: any) => model.name.split('/').pop());
      
      return this._supportedModels;
    } catch (error) {
      // Fallback to configured models if API call fails
      return this.config.supportedModels;
    }
  }

  protected override createClient() {
    const client = super.createClient();
    client.defaults.baseURL = this.baseURL;
    return client;
  }

  private buildContents(request: AIRequest): Array<{ role: string; parts: Array<{ text: string }> }> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    // Add system prompt if provided
    if (request.systemPrompt) {
      contents.push({
        role: 'user',
        parts: [{ text: request.systemPrompt }]
      });
    }

    // Add conversation history
    if (request.history && request.history.length > 0) {
      request.history.forEach(msg => {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      });
    }

    // Add current prompt
    contents.push({
      role: 'user',
      parts: [{ text: request.prompt }]
    });

    return contents;
  }
}
