import axios, { AxiosInstance } from 'axios';
import { StringDecoder } from 'node:string_decoder';
import { AIProvider, AIRequest, AIResponse, AIError, AIStreamChunk, TokenUsage } from '../types/index.js';

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
  /**
   * Streams a completion. The default runs the ordinary [process] and hands
   * back its answer as a single chunk, so every provider can be *consumed* as
   * a stream even where the upstream API has no streaming endpoint -- callers
   * write one code path instead of two. Providers that do stream override it.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const response = await this.process(request);
    if (!response.success) {
      throw new Error(response.error ?? `${this.providerId} returned no response`);
    }
    yield {
      text: response.data ?? '',
      done: true,
      modelUsed: response.modelUsed,
      usage: {
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        totalTokens: response.tokensUsed,
      },
    };
  }



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

  protected createResponse(
    success: boolean,
    data?: string,
    error?: string,
    modelUsed?: string,
    usage?: TokenUsage
  ): AIResponse {
    return {
      success,
      data,
      error,
      modelUsed: modelUsed || this.supportedModels[0] || 'unknown',
      providerId: this.providerId,
      processingTime: 0,
      confidence: success ? 0.8 : 0,
      ...(usage?.promptTokens !== undefined && { promptTokens: usage.promptTokens }),
      ...(usage?.completionTokens !== undefined && { completionTokens: usage.completionTokens }),
      ...(usage?.totalTokens !== undefined && { tokensUsed: usage.totalTokens })
    };
  }
}

/**
 * Splits a Node readable (axios `responseType: 'stream'`) into lines.
 *
 * Both streaming APIs frame their chunks by newline -- SSE for Gemini, NDJSON
 * for Ollama -- and neither guarantees a network chunk ends on one, so the
 * tail is carried into the next read rather than parsed as a broken line.
 */
export async function* streamLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string, void, void> {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) yield buffer;
}

/** Drains a Node readable into a string -- used to read the error body of a non-2xx `responseType: 'stream'` response. */
export async function readStreamToString(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
