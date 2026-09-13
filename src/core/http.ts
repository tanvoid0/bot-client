/**
 * The one place that calls `fetch`.
 *
 * Whole-request timeout for JSON calls, idle timeout for streams, the caller's
 * abort signal threaded through both, and the two line-based wire formats the
 * providers speak (SSE and NDJSON) decoded with the web-standard `TextDecoder`
 * so this file runs wherever `fetch` does.
 */
import { AIError } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_STREAM_IDLE_MS = 60_000;

export type FetchLike = (input: URL | string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** JSON-serialised. Presence makes the default method POST. */
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  signal?: AbortSignal;
  /** Whole-request timeout in ms; 0 disables it. Default 30000 for JSON calls. */
  timeout?: number;
  /** Streams only: ms of silence from upstream before the stream is failed. 0 disables. Default 60000. */
  idleTimeout?: number;
  /** Named in errors raised here (timeouts). */
  provider?: string;
  fetch?: FetchLike;
}

/** A non-2xx reply. `json` is the parsed body when it was JSON, so the error classifier can lift the API's own message. */
export class HttpError extends Error {
  readonly json: any;
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Headers = new Headers()
  ) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    try {
      this.json = body ? JSON.parse(body) : undefined;
    } catch {
      this.json = undefined;
    }
  }
}

export interface HttpResult<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** One controller per request: the caller's signal, our timeouts and the idle guard all abort it. */
function makeController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

function timeoutError(ms: number, provider: string | undefined, code: 'TIMEOUT' | 'STREAM_IDLE'): AIError {
  return AIError.from({
    message:
      code === 'TIMEOUT'
        ? `Request timed out after ${ms}ms`
        : `Stream produced no data for ${ms}ms`,
    provider: provider ?? 'http',
    code,
  });
}

async function send(url: string, options: HttpOptions, controller: AbortController): Promise<Response> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(options.params ?? {})) target.searchParams.set(k, v);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers };
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
  } catch (err) {
    // An abort rejects with the signal's reason on modern runtimes and a bare
    // AbortError on older ones; surface our own reason (timeout) either way.
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, body, res.headers);
  }
  return res;
}

/** JSON request. Non-2xx throws [HttpError]. */
export async function httpJson<T = any>(url: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
  const controller = makeController(options.signal);
  const ms = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const timer = ms > 0 ? setTimeout(() => controller.abort(timeoutError(ms, options.provider, 'TIMEOUT')), ms) : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.();
  try {
    const res = await send(url, options, controller);
    const text = await res.text();
    return { data: text ? (JSON.parse(text) as T) : (undefined as T), status: res.status, headers: res.headers };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Streaming request: the body as an async iterable of bytes, failed with
 * `STREAM_IDLE` when upstream goes quiet for `idleTimeout` ms. The idle clock
 * only runs while waiting on upstream, never while the consumer holds a chunk.
 * Returning early from the iterable closes the connection.
 */
export async function httpStream(url: string, options: HttpOptions = {}): Promise<AsyncIterable<Uint8Array>> {
  const controller = makeController(options.signal);
  const idleMs = options.idleTimeout ?? DEFAULT_STREAM_IDLE_MS;
  // First-byte wait is covered by the idle clock too, so no whole-request timer.
  const res = await withIdle(send(url, options, controller), idleMs, controller, options.provider);
  const body = res.body;
  if (!body) return (async function* () {})();
  return guard(body as unknown as AsyncIterable<Uint8Array>, idleMs, controller, options.provider);
}

function withIdle<T>(p: Promise<T>, ms: number, controller: AbortController, provider?: string): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = timeoutError(ms, provider, 'STREAM_IDLE');
      controller.abort(err);
      reject(err);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

async function* guard(
  source: AsyncIterable<Uint8Array>,
  idleMs: number,
  controller: AbortController,
  provider?: string
): AsyncGenerator<Uint8Array, void, void> {
  const it = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      let r: IteratorResult<Uint8Array>;
      try {
        r = await withIdle(it.next(), idleMs, controller, provider);
      } catch (err) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
        throw err;
      }
      if (r.done) {
        finished = true;
        return;
      }
      yield r.value;
    }
  } finally {
    // Consumer stopped early (break/throw): release the socket. Not awaited:
    // a ReadableStream's return() waits for any pending read, and after an
    // idle timeout that read is exactly the thing that never comes.
    if (!finished && !controller.signal.aborted) controller.abort();
    void it.return?.().catch(() => undefined);
  }
}

/**
 * Splits a byte stream (a `fetch` body, or any async iterable of chunks) into
 * lines. A network chunk rarely ends on a newline, so the tail is carried into
 * the next read; a multi-byte character split across reads is reassembled by
 * the streaming decoder.
 */
export async function* streamLines(
  stream: AsyncIterable<Uint8Array | string>
): AsyncGenerator<string, void, void> {
  let buffer = '';
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Server-sent events: `data:` lines accumulate until a blank line dispatches
 * them (joined with `\n`), `event:` names the frame, comments are skipped.
 * A trailing frame with no blank line after it is dispatched at end of stream.
 */
export async function* parseSSE(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent, void, void> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const raw of streamLines(stream)) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length) yield { event, data: data.join('\n') };
}

/** Newline-delimited JSON. Lines that do not parse are skipped (a cut-off tail on abort). */
export async function* parseNDJSON<T = any>(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<T, void, void> {
  for await (const line of streamLines(stream)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      continue;
    }
  }
}
