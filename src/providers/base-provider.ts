import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  TokenUsage,
  FinishReason,
  BaseProviderConfig,
} from '../types/index.js';
import { AIError, toAIError, type AIErrorCode, type Refinement, type ClassifyContext } from '../core/errors.js';
import {
  httpJson,
  httpStream as rawHttpStream,
  HttpError,
  streamLines,
  parseSSE,
  parseNDJSON,
  type HttpOptions,
  type HttpResult,
} from '../core/http.js';

export { HttpError, streamLines, parseSSE, parseNDJSON };
export type { HttpOptions, HttpResult };

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Build OpenAI-style messages array from request (systemPrompt + history + current prompt). */
export function buildChatMessages(request: AIRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
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

/** Sum of prompt and completion tokens when both are known. */
export function totalTokens(promptTokens?: number, completionTokens?: number): number | undefined {
  return promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined;
}

export interface OkExtra {
  reasoning?: string;
  modelUsed?: string;
  usage?: TokenUsage;
  finishReason?: FinishReason;
  requestId?: string;
}

export abstract class BaseProvider implements AIProvider {
  protected _supportedModels: string[] = [];
  protected readonly baseConfig: BaseProviderConfig;

  constructor(config: BaseProviderConfig = {}) {
    this.baseConfig = config;
    if (config.models) this._supportedModels = [...config.models];
  }

  abstract get providerId(): string;
  abstract get providerName(): string;
  abstract process(request: AIRequest): Promise<AIResponse>;
  abstract discoverModels(): Promise<string[]>;

  /** Origin this provider talks to; shown in `PROVIDER_UNREACHABLE` hints. */
  protected get baseURL(): string | undefined {
    return this.baseConfig.baseURL;
  }

  /**
   * Streams a completion. The default runs the ordinary [process] and hands
   * back its answer as a single chunk, so every provider can be *consumed* as
   * a stream even where the upstream API has no streaming endpoint -- callers
   * write one code path instead of two. Providers that do stream override it.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const response = await this.process(request);
    if (!response.success) {
      throw response.errorInfo ?? this.error('UNKNOWN', response.error ?? `${this.providerId} returned no response`);
    }
    if (response.reasoning) yield { text: '', reasoning: response.reasoning, modelUsed: response.modelUsed };
    yield {
      text: response.data ?? '',
      done: true,
      modelUsed: response.modelUsed,
      usage: response.usage,
      finishReason: response.finishReason,
      requestId: response.requestId,
    };
  }

  get supportedModels(): string[] {
    return this._supportedModels;
  }

  /** Records what discovery found, keeping any seeded `models` first so the caller's chosen default stays the default. */
  protected setDiscovered(ids: string[]): string[] {
    const seed = this.baseConfig.models ?? [];
    this._supportedModels = Array.from(new Set([...seed, ...ids]));
    return this._supportedModels;
  }

  isModelSupported(modelId: string): boolean {
    return this.supportedModels.includes(modelId);
  }

  /** Cheap by default: "up" means at least one model can be listed. No generation is sent. */
  async testConnection(): Promise<boolean> {
    try {
      return (await this.discoverModels()).length > 0;
    } catch {
      return false;
    }
  }

  // ---- errors -------------------------------------------------------------

  /**
   * Provider-specific reading of an error body. Return the fields you can
   * tell from it (`code`, `providerCode`, `hint`, `retryAfterMs`); the status
   * code default fills the rest.
   */
  protected classify(_status: number, _json: any, _text: string): Refinement {
    return {};
  }

  protected errorContext(model?: string): ClassifyContext {
    return {
      provider: this.providerId,
      providerName: this.providerName,
      model,
      baseURL: this.baseURL,
      refine: (status, json, text) => this.classify(status, json, text),
    };
  }

  /** Any thrown value → `AIError` carrying this provider's classification. */
  protected toError(error: unknown, model?: string): AIError {
    return toAIError(error, this.errorContext(model));
  }

  /** A fresh `AIError` for a failure this provider detects itself (no key, no model, blocked answer). */
  protected error(code: AIErrorCode, message: string, extra: { model?: string; hint?: string; details?: unknown } = {}): AIError {
    return toAIError(
      AIError.from({ message, provider: this.providerId, code, model: extra.model, hint: extra.hint, details: extra.details }),
      this.errorContext(extra.model)
    );
  }

  /** Throws the classified `AIError`. Kept for subclasses written against 1.x. */
  protected handleError(error: unknown, _operation?: string): never {
    throw this.toError(error);
  }

  // ---- http ---------------------------------------------------------------

  /** JSON request. Non-2xx throws [HttpError]; the JSON body (if any) is on `.json`. */
  protected async http<T = any>(url: string, options: HttpOptions = {}): Promise<T> {
    return (await this.httpFull<T>(url, options)).data;
  }

  /** JSON request with the reply's status and headers (request ids live there). */
  protected httpFull<T = any>(url: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
    return httpJson<T>(url, this.withDefaults(options));
  }

  /** Streaming request: the body as an async iterable of bytes, idle-guarded. Non-2xx throws [HttpError]. */
  protected httpStream(url: string, options: HttpOptions = {}): Promise<AsyncIterable<Uint8Array>> {
    return rawHttpStream(url, this.withDefaults(options));
  }

  private withDefaults(options: HttpOptions): HttpOptions {
    return {
      ...options,
      headers: { ...options.headers, ...this.baseConfig.headers },
      timeout: options.timeout ?? this.baseConfig.timeout,
      idleTimeout: options.idleTimeout ?? this.baseConfig.streamIdleTimeout,
      provider: this.providerId,
      fetch: options.fetch ?? this.baseConfig.fetch,
    };
  }

  /** The per-request knobs (`signal`, timeouts) as http options. */
  protected requestOptions(request: AIRequest): Pick<HttpOptions, 'signal' | 'timeout' | 'idleTimeout'> {
    return { signal: request.signal, timeout: request.timeout, idleTimeout: request.streamIdleTimeout };
  }

  // ---- responses ----------------------------------------------------------

  protected ok(data: string, extra: OkExtra = {}): AIResponse {
    const usage = extra.usage;
    return {
      success: true,
      data,
      ...(extra.reasoning && { reasoning: extra.reasoning }),
      modelUsed: extra.modelUsed || this.supportedModels[0] || 'unknown',
      providerId: this.providerId,
      finishReason: extra.finishReason ?? 'unknown',
      ...(extra.requestId && { requestId: extra.requestId }),
      ...(usage && { usage }),
      ...(usage?.promptTokens !== undefined && { promptTokens: usage.promptTokens }),
      ...(usage?.completionTokens !== undefined && { completionTokens: usage.completionTokens }),
      ...(usage?.totalTokens !== undefined && { tokensUsed: usage.totalTokens }),
    };
  }

  protected fail(error: AIError, modelUsed?: string): AIResponse {
    return {
      success: false,
      error: error.message,
      errorInfo: error,
      modelUsed: modelUsed ?? error.model ?? this.supportedModels[0] ?? 'unknown',
      providerId: this.providerId,
      finishReason: 'error',
      ...(error.requestId && { requestId: error.requestId }),
    };
  }

  /** @deprecated Use `ok()` / `fail()`. Kept for subclasses written against 1.x. */
  protected createResponse(
    success: boolean,
    data?: string,
    error?: string,
    modelUsed?: string,
    usage?: TokenUsage
  ): AIResponse {
    return success
      ? this.ok(data ?? '', { modelUsed, usage })
      : this.fail(this.error('UNKNOWN', error ?? 'Request failed', { model: modelUsed }), modelUsed);
  }
}
