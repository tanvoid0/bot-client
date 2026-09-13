/**
 * Error taxonomy shared by every provider.
 *
 * The provider's own message is kept verbatim in `message`; this module only
 * adds a classification (`code`), whether a retry can help, and a one-line
 * `hint` saying what to do next.
 */
import type { HttpError } from './http.js';

export type AIErrorCode =
  // Not retryable: fix credentials or the account.
  | 'NO_API_KEY'
  | 'AUTH'
  | 'PERMISSION'
  | 'QUOTA'
  // Retryable: transient on the provider or network side.
  | 'RATE_LIMIT'
  | 'OVERLOADED'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'STREAM_IDLE'
  // Caller cancelled.
  | 'ABORTED'
  // Fix the request.
  | 'MODEL_NOT_FOUND'
  | 'CONTEXT_LENGTH'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED'
  // Output problems.
  | 'CONTENT_FILTER'
  | 'TRUNCATED'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  // Setup problems.
  | 'PROVIDER_UNREACHABLE'
  | 'NO_PROVIDERS'
  | 'NO_MODEL'
  | 'TOOL_ERROR'
  | 'MCP_ERROR'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'RATE_LIMIT',
  'OVERLOADED',
  'SERVER',
  'NETWORK',
  'TIMEOUT',
  'STREAM_IDLE',
  // Retried once only (see AIFactory): a refused connect is usually a dead
  // port, but a live server with a full accept backlog refuses the same way.
  'PROVIDER_UNREACHABLE',
]);

/** Codes whose retry budget is capped at one attempt regardless of `retries`. */
export const SINGLE_RETRY: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>(['PROVIDER_UNREACHABLE']);

const RATE_LIMIT_PHRASES = /too many concurrent|rate limit|rate_limit_exceeded|too many requests/i;

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'NO_API_KEY', 'AUTH', 'PERMISSION', 'QUOTA', 'RATE_LIMIT', 'OVERLOADED', 'SERVER', 'NETWORK', 'TIMEOUT',
  'STREAM_IDLE', 'ABORTED', 'MODEL_NOT_FOUND', 'CONTEXT_LENGTH', 'INVALID_REQUEST', 'UNSUPPORTED', 'CONTENT_FILTER',
  'TRUNCATED', 'INVALID_JSON', 'SCHEMA_MISMATCH', 'PROVIDER_UNREACHABLE', 'NO_PROVIDERS', 'NO_MODEL', 'TOOL_ERROR',
  'MCP_ERROR', 'INVALID_RESPONSE', 'UNKNOWN',
]);

export function isRetryableCode(code: AIErrorCode): boolean {
  return RETRYABLE.has(code);
}

export interface AIErrorInit {
  message: string;
  provider: string;
  code?: AIErrorCode;
  /** HTTP status when the failure was an HTTP reply. */
  statusCode?: number;
  /** The provider's own error type/code string, verbatim (`rate_limit_error`, `RESOURCE_EXHAUSTED`, ...). */
  providerCode?: string;
  /** One sentence: what to do next. */
  hint?: string;
  /** Overrides the default derived from `code`. */
  retryable?: boolean;
  /** From `Retry-After` or the provider body, when present. */
  retryAfterMs?: number;
  /** Provider request id header, when present. */
  requestId?: string;
  model?: string;
  /** Parsed body (or raw text) of the failed reply. */
  details?: unknown;
  cause?: unknown;
}

export class AIError extends Error {
  code: AIErrorCode;
  provider: string;
  statusCode?: number;
  providerCode?: string;
  hint?: string;
  retryable: boolean;
  retryAfterMs?: number;
  requestId?: string;
  model?: string;
  details?: unknown;
  cause?: unknown;

  /**
   * Positional form kept from 1.x: `new AIError(message, provider, statusCode?, details?, code?)`.
   * Prefer `AIError.from({...})` for anything richer.
   */
  constructor(
    message: string,
    provider: string,
    statusCode?: number,
    details?: unknown,
    code?: AIErrorCode
  ) {
    super(message);
    this.name = 'AIError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.details = details;
    this.code = code ?? 'UNKNOWN';
    this.retryable = isRetryableCode(this.code);
  }

  static from(init: AIErrorInit): AIError {
    const err = new AIError(init.message, init.provider, init.statusCode, init.details, init.code);
    err.providerCode = init.providerCode;
    err.hint = init.hint;
    err.retryAfterMs = init.retryAfterMs;
    err.requestId = init.requestId;
    err.model = init.model;
    err.cause = init.cause;
    if (init.retryable !== undefined) err.retryable = init.retryable;
    return err;
  }

  /** Alias of `statusCode`. */
  get status(): number | undefined {
    return this.statusCode;
  }

  /** `[provider/CODE] message — hint` */
  toString(): string {
    return `[${this.provider}/${this.code}] ${this.message}${this.hint ? ` — ${this.hint}` : ''}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      message: this.message,
      hint: this.hint,
      statusCode: this.statusCode,
      providerCode: this.providerCode,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      model: this.model,
    };
  }
}

/** What a provider learns from its own error body; merged over the status-code default. */
export type Refinement = Partial<Pick<AIErrorInit, 'code' | 'providerCode' | 'hint' | 'retryAfterMs' | 'message' | 'retryable'>>;

export interface ClassifyContext {
  provider: string;
  providerName?: string;
  model?: string;
  baseURL?: string;
  /** Provider-specific reading of the body; wins over the generic mapping. */
  refine?: (status: number, json: any, text: string) => Refinement;
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function codeForStatus(status: number): AIErrorCode {
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST';
  if (status === 401) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 503 || status === 529) return 'OVERLOADED';
  if (status >= 500) return 'SERVER';
  return 'UNKNOWN';
}

/** Generic hints; a provider's `refine` can override with something more specific. */
export function defaultHint(
  code: AIErrorCode,
  ctx: ClassifyContext,
  err: { retryAfterMs?: number; model?: string }
): string | undefined {
  const name = ctx.providerName ?? ctx.provider;
  switch (code) {
    case 'AUTH':
      return `${name} rejected the API key; check the key and that it is for this provider.`;
    case 'PERMISSION':
      return `The key lacks access to this model or endpoint on ${name}.`;
    case 'QUOTA':
      return `Billing or quota is exhausted on the ${name} account.`;
    case 'RATE_LIMIT':
      return err.retryAfterMs !== undefined
        ? `Retry after ${Math.ceil(err.retryAfterMs / 1000)}s, or lower the request rate; retried automatically when retry is enabled.`
        : 'Lower the request rate or add a delay; retried automatically when retry is enabled.';
    case 'OVERLOADED':
    case 'SERVER':
      return `${name} is having trouble; retried automatically when retry is enabled.`;
    case 'MODEL_NOT_FOUND':
      return err.model
        ? `Model "${err.model}" is unknown to ${name}; check the id or call discoverModels() for the list.`
        : `Check the model id (discoverModels() lists what ${name} offers) and the baseURL.`;
    case 'CONTEXT_LENGTH':
      return 'Shorten the messages or history, or lower maxTokens.';
    case 'INVALID_REQUEST':
      return `${name} rejected the request as sent; the message above names the parameter.`;
    case 'UNSUPPORTED':
      return `${name} does not support this feature for the chosen model.`;
    case 'INVALID_RESPONSE':
      return `${name} answered with something this client could not parse; check the baseURL points at the API, not a web page.`;
    case 'ABORTED':
      return 'The caller aborted the request via its AbortSignal.';
    case 'NETWORK':
      return 'Check connectivity, DNS and any proxy.';
    case 'PROVIDER_UNREACHABLE':
      return ctx.baseURL
        ? `Nothing answered at ${ctx.baseURL}; check that it is running and the baseURL.`
        : `${name} could not be reached.`;
    case 'TIMEOUT':
      return 'Raise the timeout, or use processStream for long answers.';
    case 'STREAM_IDLE':
      return 'Raise streamIdleTimeout, or check that the provider is still generating.';
    case 'CONTENT_FILTER':
      return `${name} blocked the prompt or the answer; rephrase or change the safety settings.`;
    case 'TRUNCATED':
      return 'Raise maxTokens; the answer was cut off before the JSON was complete.';
    case 'NO_MODEL':
      return 'Pass modelId, or seed the provider with { models: [...] }.';
    case 'NO_PROVIDERS':
      return 'No provider passed its connection check; set an API key or start a local server (ollama serve).';
    case 'NO_API_KEY':
      return `Pass { apiKey } to the ${name} provider or set its environment variable.`;
    default:
      return undefined;
  }
}

/** Reads the provider's own message out of the common body shapes. */
export function messageFromBody(json: any, text: string, fallback: string): string {
  const m =
    json?.error?.message ??
    (typeof json?.error === 'string' ? json.error : undefined) ??
    json?.message ??
    json?.detail;
  if (typeof m === 'string' && m.trim()) return m.trim();
  const t = text.trim();
  return t ? t.slice(0, 500) : fallback;
}

/** Wraps a non-2xx reply. */
export function fromHttpError(http: HttpError, ctx: ClassifyContext): AIError {
  const status = http.status;
  const json = http.json;
  const text = http.body;
  const base: AIErrorInit = {
    message: messageFromBody(json, text, `HTTP ${status}`),
    provider: ctx.provider,
    code: codeForStatus(status),
    statusCode: status,
    model: ctx.model,
    details: json ?? text,
    retryAfterMs: parseRetryAfter(http.headers?.get('retry-after')),
    requestId: http.headers?.get('x-request-id') ?? http.headers?.get('request-id') ?? undefined,
    providerCode:
      typeof json?.error?.type === 'string'
        ? json.error.type
        : typeof json?.error?.code === 'string'
          ? json.error.code
          : undefined,
  };
  // Some gateways answer a burst with a plain 400 whose body names the limit
  // ("too many concurrent requests"); treat that as the 429 it means.
  if (status >= 400 && RATE_LIMIT_PHRASES.test(base.message)) base.code = 'RATE_LIMIT';
  // A proxy that already speaks this taxonomy (error.code = 'RATE_LIMIT', ...) maps 1:1.
  if (typeof json?.error?.code === 'string' && KNOWN_CODES.has(json.error.code)) base.code = json.error.code as AIErrorCode;
  const refined = ctx.refine?.(status, json, text) ?? {};
  const merged: AIErrorInit = { ...base, ...stripUndefined(refined) };
  merged.hint = refined.hint ?? defaultHint(merged.code!, ctx, merged);
  return AIError.from(merged);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function isHttpError(e: unknown): e is HttpError {
  return (
    !!e &&
    typeof e === 'object' &&
    (e as { name?: string }).name === 'HttpError' &&
    typeof (e as { status?: unknown }).status === 'number'
  );
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

/** undici's `fetch failed` carries the socket error on `cause.code`. */
function socketCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  return cause?.code ?? cause?.errors?.[0]?.code;
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH']);

/**
 * Any thrown value → `AIError`. Already an `AIError`: returned as is, with
 * `model` and `hint` filled in when missing.
 */
export function toAIError(error: unknown, ctx: ClassifyContext): AIError {
  // Duck-typed as well as instanceof: an app that loads both the ESM and the
  // CJS build ends up with two AIError classes.
  if (error instanceof AIError || (!!error && typeof error === 'object' && (error as { name?: string }).name === 'AIError')) {
    if (!(error instanceof AIError)) return AIError.from({ ...(error as AIError), message: (error as Error).message, provider: (error as AIError).provider ?? ctx.provider });
    if (!error.model && ctx.model) error.model = ctx.model;
    if (error.hint === undefined) error.hint = defaultHint(error.code, ctx, error);
    return error;
  }
  if (isHttpError(error)) return fromHttpError(error, ctx);

  const message = error instanceof Error ? error.message : String(error);
  const sc = socketCode(error);
  let code: AIErrorCode = 'UNKNOWN';
  if (isAbort(error)) {
    code = 'ABORTED';
  } else if (sc && UNREACHABLE_CODES.has(sc)) {
    code = 'PROVIDER_UNREACHABLE';
  } else if (error instanceof TypeError && /fetch failed|network/i.test(message)) {
    code = 'NETWORK';
  } else if (error instanceof SyntaxError) {
    code = 'INVALID_RESPONSE';
  }
  return AIError.from({
    message: sc ? `${message} (${sc})` : message,
    provider: ctx.provider,
    code,
    model: ctx.model,
    cause: error,
    hint: defaultHint(code, ctx, { model: ctx.model }),
  });
}
