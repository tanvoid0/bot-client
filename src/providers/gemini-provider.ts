import axios, { AxiosInstance } from 'axios';
import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

export interface GeminiProviderConfig {
  apiKey?: string;
}

export class GeminiProvider extends BaseProvider {
  private apiKey?: string;
  private _client: AxiosInstance | null = null;

  constructor(config?: GeminiProviderConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.BOT_CLIENT_GEMINI_KEY;
  }

  private getClient(): AxiosInstance {
    if (this._client) return this._client;
    this._client = axios.create({
      baseURL: GEMINI_BASE,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    return this._client;
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const client = this.getClient();
      await client.get('/v1beta/models', { params: { key: this.apiKey } });
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    if (!this.apiKey) return [];

    try {
      const client = this.getClient();
      const response = await client.get('/v1beta/models', {
        params: { key: this.apiKey }
      });
      
      const models = response.data.models || [];
      this._supportedModels = models
        .filter((model: any) => model.name.includes('gemini'))
        .map((model: any) => model.name.split('/').pop());
      
      return this._supportedModels;
    } catch (error) {
      return [];
    }
  }

  get providerId(): string {
    return 'gemini';
  }

  get providerName(): string {
    return 'Google Gemini';
  }


  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      return this.createResponse(false, undefined, 'Gemini API key required');
    }

    try {
      const client = this.getClient();
      const modelId = request.modelId ?? this.supportedModels[0] ?? 'gemini-1.5-pro';
      const messages = buildChatMessages(request);
      const systemParts: Array<{ text: string }> = [];
      const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
      for (const m of messages) {
        if (m.role === 'system') {
          systemParts.push({ text: m.content });
        } else {
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          });
        }
      }
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 1000,
          temperature: request.temperature ?? 0.7
        }
      };
      if (systemParts.length > 0) {
        body.systemInstruction = { parts: systemParts };
      }
      const response = await client.post(`/v1beta/models/${modelId}:generateContent`, body, {
        params: { key: this.apiKey }
      });

      const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const modelUsed = request.modelId ?? modelId;
      return this.createResponse(true, content, undefined, modelUsed);
    } catch (error) {
      this.handleError(error, 'Gemini processing');
    }
  }
}
