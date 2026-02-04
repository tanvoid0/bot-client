import axios, { AxiosInstance } from 'axios';
import { AIProvider, AIRequest, AIResponse, AIError } from '../types/index.js';

/** Build OpenAI-style messages array from request (systemPrompt + history + current prompt). */
export function buildChatMessages(request: AIRequest): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  if (request.history?.length) {
    for (const h of request.history) {
      if (h.role === 'system' || h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }
  }
  messages.push({ role: 'user', content: request.prompt });
  return messages;
}

export abstract class BaseProvider implements AIProvider {
  protected client!: AxiosInstance;
  protected _supportedModels: string[] = [];

  constructor() {
    // Simple initialization
  }

  abstract get providerId(): string;
  abstract get providerName(): string;
  abstract process(request: AIRequest): Promise<AIResponse>;
  abstract discoverModels(): Promise<string[]>;

  get supportedModels(): string[] {
    return this._supportedModels;
  }

  isModelSupported(modelId: string): boolean {
    return this.supportedModels.includes(modelId);
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.process({ prompt: 'Hello', maxTokens: 10 });
      const hasData = response.data === '' || (typeof response.data === 'string' && response.data.length > 0);
      return response.success && hasData;
    } catch {
      return false;
    }
  }

  protected createClient(baseURL?: string, options?: { headers?: Record<string, string> }): AxiosInstance {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options?.headers) {
      Object.assign(headers, options.headers);
    }
    const client = axios.create({
      timeout: 30000,
      headers,
      ...(baseURL && { baseURL })
    });
    return client;
  }

  protected handleError(error: unknown, operation: string): never {
    const err = error as { response?: { data?: { error?: { message?: string } } }; message?: string };
    const message = err.response?.data?.error?.message || err.message || 'Unknown error';
    throw new AIError(`${operation} failed: ${message}`, this.providerId);
  }

  protected createResponse(success: boolean, data?: string, error?: string, modelUsed?: string): AIResponse {
    return {
      success,
      data,
      error,
      modelUsed: modelUsed || this.supportedModels[0] || 'unknown',
      providerId: this.providerId,
      processingTime: 0,
      confidence: success ? 0.8 : 0
    };
  }
}
