import axios, { AxiosInstance } from 'axios';
import { AIRequest, AIResponse, AIStreamChunk } from '../types/index.js';
import { BaseProvider, buildChatMessages, streamLines, readStreamToString } from './base-provider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/**
 * Generous by default: structured replies (plans, tool calls) truncate
 * mid-JSON at the old 1000-token cap, which reads as a parse failure.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

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


  /** The request body both the one-shot and the streaming call send. */
  private buildBody(request: AIRequest): Record<string, unknown> {
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
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.7,
        ...(request.jsonMode && { responseMimeType: 'application/json' }),
        ...(request.responseSchema !== undefined && {
          responseSchema: request.responseSchema
        })
      }
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }
    return body;
  }

  /**
   * Gemini's `streamGenerateContent`, read as server-sent events.
   *
   * Same body as [process] -- system instruction, JSON mode and schema all
   * travel unchanged -- so a streamed answer is the same answer, delivered in
   * pieces. A chunk that does not parse is skipped rather than thrown on: it
   * is a half-written frame, and the next read completes it.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    if (!this.apiKey) {
      throw new Error('Gemini API key required');
    }
    const client = this.getClient();
    const modelId = request.modelId ?? this.supportedModels[0] ?? 'gemini-2.0-flash';
    const response = await client.post(
      `/v1beta/models/${modelId}:streamGenerateContent`,
      this.buildBody(request),
      {
        params: { key: this.apiKey, alt: 'sse' },
        responseType: 'stream',
        // 30s client default is a socket idle timeout, which kills a cold model load or a stall mid-stream.
        timeout: 0,
        signal: request.signal,
        validateStatus: () => true,
      },
    );

    if (response.status >= 300) {
      const text = await readStreamToString(response.data as AsyncIterable<Buffer>);
      throw new Error(`Gemini stream HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    for await (const line of streamLines(response.data as AsyncIterable<Buffer>)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const parts = parsed?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part?.text === 'string' && part.text.length > 0) {
            yield { text: part.text, modelUsed: modelId };
          }
        }
      }
      const meta = parsed?.usageMetadata;
      if (meta) {
        usage = {
          promptTokens: meta.promptTokenCount,
          completionTokens: meta.candidatesTokenCount,
          totalTokens: meta.totalTokenCount,
        };
      }
    }

    yield { text: '', done: true, modelUsed: modelId, usage };
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      return this.createResponse(false, undefined, 'Gemini API key required');
    }

    try {
      const client = this.getClient();
      const modelId = request.modelId ?? this.supportedModels[0] ?? 'gemini-2.0-flash';
      const response = await client.post(
        `/v1beta/models/${modelId}:generateContent`,
        this.buildBody(request),
        { params: { key: this.apiKey } }
      );

      const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const modelUsed = request.modelId ?? modelId;
      const usage = response.data.usageMetadata;
      return this.createResponse(true, content, undefined, modelUsed, {
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
        totalTokens: usage?.totalTokenCount
      });
    } catch (error) {
      this.handleError(error, 'Gemini processing');
    }
  }
}
