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

const DEFAULT_TIMEOUT_MS = 30000;

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** JSON-serialised. Presence makes the default method POST. */
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  signal?: AbortSignal;
  /** Whole-request timeout in ms; 0 disables it (streams). Default 30000. */
  timeout?: number;
}

/** A non-2xx reply. `json` is the parsed body when it was JSON, so `handleError` can lift the API's own message. */
export class HttpError extends Error {
  readonly json: any;
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    try {
      this.json = body ? JSON.parse(body) : undefined;
    } catch {
      this.json = undefined;
    }
  }
}

/** Caller's signal, aborted early by the timeout too. Passes the caller's signal through untouched when there is no timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return signal;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export abstract class BaseProvider implements AIProvider {
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

  /** JSON request on the global `fetch`. Non-2xx throws [HttpError]; the JSON body (if any) is on `.json`. */
  protected async http<T = any>(url: string, options: HttpOptions = {}): Promise<T> {
    const res = await this.fetchRaw(url, options);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  /** Streaming request: resolves to the body as an async iterable of bytes. Non-2xx throws [HttpError]. */
  protected async httpStream(url: string, options: HttpOptions = {}): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.fetchRaw(url, options);
    if (!res.body) return (async function* () {})();
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }

  private async fetchRaw(url: string, options: HttpOptions): Promise<Response> {
    const target = new URL(url);
    for (const [k, v] of Object.entries(options.params ?? {})) target.searchParams.set(k, v);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers };
    const res = await fetch(target, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: withTimeout(options.signal, options.timeout ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new HttpError(res.status, body);
    }
    return res;
  }

  protected handleError(error: unknown, operation: string): never {
    const err = error as { json?: { error?: { message?: string } }; message?: string };
    const message = err.json?.error?.message || err.message || 'Unknown error';
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
 * Splits a byte stream (a `fetch` body, or any async iterable of chunks) into lines.
 *
 * Both streaming APIs frame their chunks by newline -- SSE for Gemini, NDJSON
 * for Ollama -- and neither guarantees a network chunk ends on one, so the
 * tail is carried into the next read rather than parsed as a broken line.
 */
export async function* streamLines(
  stream: AsyncIterable<Uint8Array | string>,
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
