import type { AIError } from '../core/errors.js';
import type { RetryOptions } from '../core/retry.js';
import type { FetchLike } from '../core/http.js';

export { AIError } from '../core/errors.js';
export type { AIErrorCode } from '../core/errors.js';

// Core AI Provider Interface
export interface AIProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly supportedModels: string[];

  process(request: AIRequest): Promise<AIResponse>;
  /**
   * The same completion, delivered as it is written.
   *
   * Optional on the interface so a provider written before streaming existed
   * still satisfies it; `BaseProvider` supplies a one-chunk implementation, so
   * every provider that extends it can be consumed as a stream regardless.
   */
  processStream?(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void>;
  isModelSupported(modelId: string): boolean;
  testConnection(): Promise<boolean>;
  discoverModels(): Promise<string[]>;
}

/** Why the model stopped writing. `length` means it hit `maxTokens`. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';

/**
 * One piece of a streamed answer.
 *
 * [text] is what was written since the previous chunk, never the whole answer
 * so far -- a consumer appends. The final chunk carries `done` and, where the
 * provider reports it, the token usage for the whole call.
 */
export interface AIStreamChunk {
  text: string;
  /** Thinking written since the previous chunk, when the model exposes it. `text` is empty on such chunks. */
  reasoning?: string;
  done?: boolean;
  usage?: TokenUsage;
  modelUsed?: string;
  /** On the `done` chunk. */
  finishReason?: FinishReason;
  /** On the `done` chunk, or on an intermediate chunk when the factory ran the calls and continued. */
  toolCalls?: ToolCall[];
  /** On the `done` chunk, when the provider sends one. */
  requestId?: string;
  /** On the `done` chunk: wall time for the whole stream (set by the factory). */
  durationMs?: number;
  /** On the `done` chunk: ms until the first non-empty text chunk (set by the factory). */
  timeToFirstTokenMs?: number;
}

export interface TextPart {
  type: 'text';
  text: string;
}

/** An image for a vision model: a remote `url`, a `data:` URL, or raw bytes / base64 in `data`. */
export interface ImagePart {
  type: 'image';
  url?: string;
  data?: Uint8Array | string;
  /** Sniffed from the bytes (png, jpeg, gif, webp) or the `data:` URL when omitted. */
  mimeType?: string;
}

export type MessagePart = TextPart | ImagePart;

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | MessagePart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/**
 * The Standard Schema interface (https://standardschema.dev) that Zod, Valibot,
 * ArkType and others implement; `jsonSchema` is the Standard JSON Schema
 * extension some of them add.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    types?: { input: Input; output: Output };
    jsonSchema?: { input?: (options: { target: string }) => Record<string, unknown> };
  };
}

export type StandardResult<T> =
  | { value: T; issues?: undefined }
  | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };

/** A function the model may call. With `execute`, the factory runs it when `maxSteps > 1`. */
export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  execute?: (args: any, ctx: { signal?: AbortSignal }) => unknown | Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON; the raw string when the model sent arguments that are not JSON. */
  arguments: any;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result?: unknown;
  /** The tool threw; the message is sent back to the model as `{ error }`. */
  error?: string;
}

/** One round of the tool loop: what the model said, what it called, what came back. */
export interface Step {
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  usage?: TokenUsage;
}

// Base AI Request Interface
export interface AIRequest {
  /** Shorthand for a final user message; appended after `messages`. One of `prompt` or `messages` is required. */
  prompt?: string;
  /** The conversation so far. A user message may carry image parts. */
  messages?: Message[];
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** Ask the provider for JSON. Providers that support a native JSON mode use it. */
  jsonMode?: boolean;
  /**
   * Structured output: a JSON Schema object, or any Standard Schema (Zod,
   * Valibot, ArkType, ...). Implies `jsonMode`. The answer is parsed (and, for
   * a Standard Schema, validated) onto `response.object`; a bad answer fails
   * with `INVALID_JSON` or `SCHEMA_MISMATCH`. Not applied to streams.
   */
  schema?: StandardSchemaV1 | Record<string, unknown>;
  /** @deprecated Use `schema`. Gemini-only passthrough; removed in 3.0. */
  responseSchema?: unknown;
  /** @deprecated Use `messages`; ignored when `messages` is given. Removed in 3.0. */
  history?: ConversationHistory[];
  metadata?: Record<string, any>;
  /** Aborts an in-flight request/stream. */
  signal?: AbortSignal;
  /** Functions the model may call. Calls come back on `toolCalls`; with `maxSteps > 1` and `execute` set, the factory runs them and continues. */
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  /** Rounds of model call + tool execution the factory runs before returning (default 1: calls are returned, not executed). */
  maxSteps?: number;
  /** Whole-request timeout in ms for non-streaming calls (default 30000; 0 disables). */
  timeout?: number;
  /** Streaming: ms of upstream silence before the stream fails with `STREAM_IDLE` (default 60000; 0 disables). */
  streamIdleTimeout?: number;
  /**
   * Ask a reasoning model to think before answering (Ollama `think`,
   * Anthropic extended thinking, Gemini `includeThoughts`). The thinking text
   * comes back as `reasoning` on the response and as `reasoning` deltas on
   * stream chunks, never mixed into `text`. Off by default for Ollama, where a
   * model that thinks into its output budget otherwise returns an empty answer;
   * whatever an OpenAI-format server sends (`reasoning_content`, inline
   * `<think>` tags) is surfaced regardless of this flag.
   */
  reasoning?: boolean;
  /**
   * Provider-specific fields merged last into the wire body, one level deep
   * (`{ options: { num_ctx: 8192 } }` for Ollama, `{ top_p: 0.9 }` for an
   * OpenAI-format host). Whatever you put here wins over what the client sets.
   */
  providerOptions?: Record<string, unknown>;
  /** @deprecated Unused; removed in 2.0. */
  usageContext?: {
    taskType: 'content-generation' | 'analysis' | 'conversation' | 'code-generation' | 'custom';
    priority: 'low' | 'medium' | 'high';
    costSensitive?: boolean;
    qualityPreference?: 'speed' | 'balanced' | 'quality';
  };
}

// AI Response Interface
export interface AIResponse {
  success: boolean;
  data?: string;
  /** The model's thinking, when it exposed any. Never part of `data`. */
  reasoning?: string;
  /** The provider's own message when `success` is false. `errorInfo` has the classification. */
  error?: string;
  /** Structured error when `success` is false. */
  errorInfo?: AIError;
  modelUsed?: string;
  providerId?: string;
  finishReason?: FinishReason;
  /** The parsed (and validated) answer when `schema` was given. */
  object?: unknown;
  /** Calls the model wants made; `finishReason` is `'tool_calls'`. Absent when there are none. */
  toolCalls?: ToolCall[];
  /** The rounds the factory ran before this answer, when `maxSteps > 1` and at least one tool ran. */
  steps?: Step[];
  usage?: TokenUsage;
  /** Total tokens billed, when the provider reports them. Same as `usage.totalTokens`. */
  tokensUsed?: number;
  /** Input tokens, when the provider reports them separately. Same as `usage.promptTokens`. */
  promptTokens?: number;
  /** Output tokens, when the provider reports them separately. Same as `usage.completionTokens`. */
  completionTokens?: number;
  /** Provider request id header, when sent. */
  requestId?: string;
  /** Wall time of the whole call, including retries and fallback. */
  durationMs?: number;
  /** @deprecated Same value as `durationMs`; removed in 2.0. */
  processingTime?: number;
  /** Retries spent before this answer. */
  retryCount?: number;
  /** True when a fallback provider answered. */
  fallbackUsed?: boolean;
  /** @deprecated Never computed; removed in 2.0. */
  cost?: number;
  /** @deprecated Never computed; removed in 2.0. */
  modelCapabilities?: string[];
  /** @deprecated Never computed; removed in 2.0. */
  suggestedImprovements?: string[];
  /** @deprecated Never computed; removed in 2.0. */
  confidence?: number;
  /** @deprecated Removed in 2.0. */
  timestamp?: Date;
}

/** Token counts as reported by a provider. Fields are absent when unreported. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from the provider's cache, when reported. */
  cachedTokens?: number;
}

// Conversation History
export interface ConversationHistory {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}

/** @deprecated Unused; removed in 2.0. */
export interface AIProviderConfig {
  defaultModel?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  supportedModels?: string[];
}

// Optional logger for factory and providers (all methods optional)
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/**
 * `eager` (default): probe every provider in parallel on first use and keep
 * those that answer. `lazy`: register all, probe a provider the first time a
 * request lands on it. `none`: never probe; rely on `modelId` and seeded models.
 */
export type DiscoveryMode = 'eager' | 'lazy' | 'none';

// AI Factory Configuration (constructor options)
export interface AIFactoryConfig {
  /** Preferred provider when no modelId is specified */
  defaultProvider?: string;
  /** Fallback provider if default fails */
  fallbackProvider?: string;
  /** Fallback providers, tried in order after `fallbackProvider`. */
  fallbackProviders?: string[];
  /** Order of providers to try when no default/model match (first available wins) */
  providerOrder?: string[];
  /** Optional logger; if not set, no logging */
  logger?: Logger;
  /** Custom provider instances; if set, only these are used (no built-in list) */
  providers?: AIProvider[];
  /** Max retries per request on a retryable failure (default 2). Shorthand for `retry.retries`. */
  retries?: number;
  /** Backoff settings; see `RetryOptions`. */
  retry?: RetryOptions;
  discover?: DiscoveryMode;
  /** Default whole-request timeout (ms) for non-streaming calls; per-request `timeout` wins. */
  timeout?: number;
  /** Default idle timeout (ms) for streams; per-request `streamIdleTimeout` wins. */
  streamIdleTimeout?: number;
  /** Observe every attempt: called before each provider call, after each answer, and on each failure. Awaited; a throw propagates to the caller. */
  hooks?: Hooks;
}

/** Lifecycle hooks on the factory. `provider` is the provider id; `model` is the id the request asked for, if any. */
export interface Hooks {
  onRequest?(ctx: { provider: string; model?: string; request: AIRequest }): void | Promise<void>;
  /** `response` is the `AIResponse`, or the `done` chunk for a stream. */
  onResponse?(ctx: { provider: string; model?: string; response: AIResponse | AIStreamChunk; durationMs: number }): void | Promise<void>;
  /** `willRetry` is true when the factory is about to retry the same provider; false before a fallback or the final failure. */
  onError?(ctx: { provider: string; model?: string; error: AIError; willRetry: boolean }): void | Promise<void>;
}

/** Options every built-in provider accepts. */
export interface BaseProviderConfig {
  /** Origin of the API, without a trailing slash. */
  baseURL?: string;
  /** Sent on every request, after the provider's own headers. */
  headers?: Record<string, string>;
  /** Default whole-request timeout (ms) for this provider's JSON calls. */
  timeout?: number;
  /** Default idle timeout (ms) for this provider's streams. */
  streamIdleTimeout?: number;
  /** Seed the supported-model list so no discovery call is needed. */
  models?: string[];
  /** How long (ms) a successful model listing is reused before `discoverModels()` fetches again. Default 300000; 0 disables. */
  modelCacheTtlMs?: number;
  /** Custom `fetch` (proxy agent, tracing, tests). */
  fetch?: FetchLike;
}

// Provider Types
export type ProviderType = 'openai' | 'anthropic' | 'ollama' | 'lmstudio' | 'gemini' | 'custom';

/** @deprecated Unused; removed in 2.0. */
export interface ProviderConfig {
  type: ProviderType;
  config: {
    name: string;
    apiKey?: string;
    host?: string;
    port?: number;
    baseURL?: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
    customHeaders?: Record<string, string>;
  };
}

/** @deprecated Unused; removed in 2.0. */
export interface ContentGenerationRequest extends AIRequest {
  taskType: 'content-generation';
  contentType: 'article' | 'blog' | 'email' | 'social-media' | 'documentation';
  tone?: 'professional' | 'casual' | 'formal' | 'creative';
  targetAudience?: string;
}

/** @deprecated Unused; removed in 2.0. */
export interface AnalysisRequest extends AIRequest {
  taskType: 'analysis';
  analysisType: 'sentiment' | 'summary' | 'classification' | 'extraction';
  outputFormat?: 'text' | 'json' | 'structured';
}

/** @deprecated Unused; removed in 2.0. */
export interface CodeGenerationRequest extends AIRequest {
  taskType: 'code-generation';
  language: string;
  framework?: string;
  includeTests?: boolean;
  includeComments?: boolean;
}

/** @deprecated Unused; removed in 2.0. */
export interface ConversationRequest extends AIRequest {
  taskType: 'conversation';
  conversationType: 'chat' | 'support' | 'tutoring' | 'interview';
  personality?: string;
}

/** @deprecated Unused; removed in 2.0. */
export interface PostProcessingOptions {
  extractJson?: boolean;
  formatOutput?: 'markdown' | 'html' | 'plain' | 'json';
  validateStructure?: boolean;
  sanitize?: boolean;
  translate?: string;
  summarize?: boolean;
  keywordExtraction?: boolean;
}

/** @deprecated Unused; removed in 2.0. */
export interface ModelCapabilities {
  reasoning: 'basic' | 'advanced' | 'expert';
  creativity: 'low' | 'medium' | 'high';
  speed: 'slow' | 'medium' | 'fast';
  cost: 'free' | 'low' | 'medium' | 'high';
  contextLength: number;
  supportedTasks: string[];
}

/** @deprecated Unused; removed in 2.0. */
export interface ProcessingMetrics {
  startTime: number;
  endTime: number;
  processingTime: number;
  tokensUsed: number;
  cost: number;
  providerLatency: number;
  modelLatency: number;
}
