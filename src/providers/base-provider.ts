import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { AIProvider, AIRequest, AIResponse, AIProviderConfig, AIError } from '../types/index.js';

export abstract class BaseProvider implements AIProvider {
  protected client!: AxiosInstance;
  protected config: AIProviderConfig;
  private _clientInitialized = false;

  constructor(config: AIProviderConfig) {
    this.config = config;
    // Don't create client in constructor to avoid order issues
  }

  abstract get providerId(): string;
  abstract get providerName(): string;
  abstract get supportedModels(): string[];

  protected createClient(): AxiosInstance {
    const axiosConfig: AxiosRequestConfig = {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    return axios.create(axiosConfig);
  }

  protected getClient(): AxiosInstance {
    if (!this._clientInitialized) {
      this.client = this.createClient();
      this._clientInitialized = true;
    }
    return this.client;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  abstract process(_request: AIRequest): Promise<AIResponse>;

  isModelSupported(modelId: string): boolean {
    return this.supportedModels.includes(modelId);
  }

  getDefaultConfig(): AIProviderConfig {
    return this.config;
  }

  async testConnection(): Promise<boolean> {
    try {
      const testRequest: AIRequest = {
        prompt: 'Hello',
        modelId: this.config.defaultModel,
        maxTokens: 10
      };
      
      const response = await this.process(testRequest);
      return response.success;
    } catch (error) {
      return false;
    }
  }

  protected handleError(error: any, operation: string): never {
    const statusCode = error.response?.status;
    const message = error.response?.data?.error?.message || error.message || 'Unknown error';
    
    throw new AIError(
      `${operation} failed: ${message}`,
      this.providerName,
      statusCode,
      error.response?.data
    );
  }

  protected getDefaultModel(): string {
    return this.config.defaultModel;
  }

  protected mergeRequestOptions(request: AIRequest): AIRequest {
    return {
      ...request,
      modelId: request.modelId || this.config.defaultModel,
      maxTokens: request.maxTokens || this.config.defaultMaxTokens,
      temperature: request.temperature ?? this.config.defaultTemperature
    };
  }

  protected createSuccessResponse(data: string, modelUsed: string, tokensUsed?: number, cost?: number): AIResponse {
    const response: AIResponse = {
      success: true,
      data,
      modelUsed,
      providerId: this.providerId
    };

    if (tokensUsed !== undefined) {
      response.tokensUsed = tokensUsed;
    }

    if (cost !== undefined) {
      response.cost = cost;
    }

    return response;
  }

  protected createErrorResponse(error: string, modelUsed: string): AIResponse {
    return {
      success: false,
      error,
      modelUsed,
      providerId: this.providerId
    };
  }
}
