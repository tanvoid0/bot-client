import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  TokenUsage,
  FinishReason,
  BaseProviderConfig,
  Message,
  MessagePart,
  ImagePart,
  ToolCall,
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

/** The conversation as one list: systemPrompt, then `messages`, then `prompt` as a user turn. */
export function buildChatMessages(request: AIRequest): Message[] {
  const messages: Message[] = [];
  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  for (const m of request.messages ?? []) messages.push(m);
  if (request.prompt !== undefined) messages.push({ role: 'user', content: request.prompt });
  return messages;
}

/** A one-shot answer as the chunks a stream would have produced. */
export function* chunksOf(response: AIResponse): Generator<AIStreamChunk, void, void> {
  const modelUsed = response.modelUsed;
  if (response.reasoning) yield { type: 'reasoning', text: response.reasoning, modelUsed };
  if (response.data) yield { type: 'text', text: response.data, modelUsed };
  for (const toolCall of response.toolCalls ?? []) yield { type: 'tool-call', toolCall, modelUsed };
  yield {
    type: 'done',
    modelUsed,
    usage: response.usage,
    finishReason: response.finishReason ?? 'unknown',
    ...(response.toolCalls && { toolCalls: response.toolCalls }),
    ...(response.requestId && { requestId: response.requestId }),
  };
}

/** A message's content as parts, so providers handle one shape. */
export function partsOf(content: string | MessagePart[]): MessagePart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** The text of a message, image parts dropped; for hosts that take a plain string. */
export function textOf(content: string | MessagePart[]): string {
  return typeof content === 'string' ? content : content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
}

const MAGIC: Array<[string, string]> = [
  ['iVBORw', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
];

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The inline bytes of an image part as `{ mimeType, data }` (base64), or
 * undefined when the part is a remote URL the provider must fetch itself.
 */
export function inlineImage(part: ImagePart): { mimeType: string; data: string } | undefined {
  let data: string | undefined;
  let mimeType = part.mimeType;
  if (part.data instanceof Uint8Array) data = toBase64(part.data);
  else if (typeof part.data === 'string') data = part.data;
  else if (part.url?.startsWith('data:')) {
    const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(part.url);
    if (!m) throw new AIError('Malformed data: URL in image part', 'request', undefined, undefined, 'INVALID_REQUEST');
    data = m[2];
    mimeType ??= m[1];
  }
  if (data === undefined) return undefined;
  return { mimeType: mimeType ?? MAGIC.find(([magic]) => data!.startsWith(magic))?.[1] ?? 'image/png', data };
}

/** First set environment variable among `names`, or undefined (also when there is no `process`). */
export function firstEnv(names: string[]): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `providerOptions` merged last into a wire body. One level deep: a nested
 * object (`options` on Ollama, `generationConfig` on Gemini) is extended, not
 * replaced, so `{ options: { num_ctx: 8192 } }` keeps the temperature.
 */
export function mergeBody(body: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> {
  if (!extra) return body;
  const out = { ...body };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] = isPlain(v) && isPlain(cur) ? { ...cur, ...v } : v;
  }
  return out;
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
  toolCalls?: ToolCall[];
}

export abstract class BaseProvider implements AIProvider {
  protected _supportedModels: string[] = [];
  protected readonly baseConfig: BaseProviderConfig;
  private discoveredAt?: number;

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
    yield* chunksOf(response);
  }

  get supportedModels(): string[] {
    return this._supportedModels;
  }

  /** Records what discovery found, keeping any seeded `models` first so the caller's chosen default stays the default. */
  protected setDiscovered(ids: string[]): string[] {
    const seed = this.baseConfig.models ?? [];
    this._supportedModels = Array.from(new Set([...seed, ...ids]));
    this.discoveredAt = Date.now();
    return this._supportedModels;
  }

  /** The last successful discovery, while younger than `modelCacheTtlMs` (default 5 min; 0 disables). */
  protected cached(): string[] | null {
    const ttl = this.baseConfig.modelCacheTtlMs ?? 300_000;
    return this.discoveredAt !== undefined && Date.now() - this.discoveredAt < ttl ? this._supportedModels : null;
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
    // A 200 whose only content is a content_filter finish is a refusal, not an answer.
    if (extra.finishReason === 'content_filter' && !data) {
      return this.fail(
        this.error('CONTENT_FILTER', `${this.providerName} blocked the answer`, { model: extra.modelUsed }),
        extra.modelUsed
      );
    }
    const usage = extra.usage;
    const toolCalls = extra.toolCalls?.length ? extra.toolCalls : undefined;
    return {
      success: true,
      data,
      ...(extra.reasoning && { reasoning: extra.reasoning }),
      modelUsed: extra.modelUsed || this.supportedModels[0] || 'unknown',
      providerId: this.providerId,
      finishReason: toolCalls ? 'tool_calls' : (extra.finishReason ?? 'unknown'),
      ...(toolCalls && { toolCalls }),
      ...(extra.requestId && { requestId: extra.requestId }),
      ...(usage && { usage }),
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

}
