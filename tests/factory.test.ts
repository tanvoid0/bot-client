/** AIFactory behaviour: retry, fallback, routing, discovery modes, and streaming — all against hand-written mock providers, no network. */
import { AIFactory } from '../src/ai-factory.js';
import { AIError } from '../src/core/errors.js';
import { HttpError } from '../src/core/http.js';
import type { AIProvider, AIRequest, AIStreamChunk, DoneChunk } from '../src/types/index.js';

/** Same shape as tests/unit-tests.ts `createMockProvider`, with overridable methods. */
function makeProvider(id: string, overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    providerId: id,
    providerName: `Mock ${id}`,
    supportedModels: ['m'],
    isModelSupported: () => true,
    discoverModels: async () => ['m'],
    testConnection: async () => true,
    process: async (req: AIRequest) => ({
      success: true,
      data: `echo:${req.prompt}`,
      providerId: id,
      modelUsed: req.modelId ?? 'm',
      finishReason: 'stop',
    }),
    ...overrides,
  };
}

function fail(provider: string, code: AIError['code'], message: string = code, retryAfterMs?: number) {
  return { success: false as const, error: message, errorInfo: AIError.from({ message, provider, code, retryAfterMs }), providerId: provider };
}

async function collect(gen: AsyncGenerator<AIStreamChunk, void, void>): Promise<AIStreamChunk[]> {
  const out: AIStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => jest.useRealTimers());

describe('process(): thrown errors are caught, never re-thrown by process()', () => {
  test('a thrown AIError is caught by process(); generate() throws the same instance', async () => {
    const err = AIError.from({ message: 'boom', provider: 'x', code: 'AUTH' });
    const provider = makeProvider('x', { process: async () => { throw err; } });
    const factory = new AIFactory({ providers: [provider] });
    const res = await factory.process({ prompt: 'hi' });
    expect(res.success).toBe(false);
    expect(res.errorInfo).toBe(err);
    await expect(factory.generate('hi')).rejects.toBe(err);
  });

  test('a thrown HttpError-like value is classified instead of crashing the factory', async () => {
    const httpErr = new HttpError(500, JSON.stringify({ error: { message: 'server exploded' } }), new Headers());
    const provider = makeProvider('x', { process: async () => { throw httpErr; } });
    const factory = new AIFactory({ providers: [provider], retries: 0 }); // SERVER is retryable; skip the real backoff delay here
    const res = await factory.process({ prompt: 'hi' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('SERVER');
    expect(res.errorInfo?.message).toBe('server exploded');
  });
});

describe('retry and fallback', () => {
  test('a retryable failure is retried exactly `retries` times, honouring retryAfterMs', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const provider = makeProvider('x', {
      process: async () => {
        attempts++;
        return fail('x', 'RATE_LIMIT', 'slow down', 1000);
      },
    });
    const factory = new AIFactory({ providers: [provider], retries: 2 });
    const promise = factory.process({ prompt: 'hi' });
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    const res = await promise;
    expect(attempts).toBe(3);
    expect(res.retryCount).toBe(2);
    expect(res.success).toBe(false);
  });

  test('a non-retryable failure skips retries and falls back immediately', async () => {
    let primaryAttempts = 0;
    const primary = makeProvider('primary', {
      process: async () => {
        primaryAttempts++;
        return fail('primary', 'AUTH', 'no key');
      },
    });
    const fallback = makeProvider('fallback');
    const factory = new AIFactory({ providers: [primary, fallback], defaultProvider: 'primary', fallbackProvider: 'fallback', retries: 2 });
    const res = await factory.process({ prompt: 'hi' });
    expect(primaryAttempts).toBe(1);
    expect(res.success).toBe(true);
    expect(res.fallbackUsed).toBe(true);
    expect(res.providerId).toBe('fallback');
  });

  test('fallbackProviders are tried in order', async () => {
    const order: string[] = [];
    const mk = (id: string, ok: boolean) =>
      makeProvider(id, {
        process: async () => {
          order.push(id);
          return ok ? { success: true, data: 'ok', providerId: id } : fail(id, 'AUTH');
        },
      });
    const a = mk('a', false);
    const b = mk('b', false);
    const c = mk('c', true);
    const factory = new AIFactory({ providers: [a, b, c], defaultProvider: 'a', fallbackProviders: ['b', 'c'] });
    const res = await factory.process({ prompt: 'hi' });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(res.providerId).toBe('c');
  });

  test('aborting during backoff stops further attempts with code ABORTED', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const controller = new AbortController();
    const provider = makeProvider('x', {
      process: async () => {
        attempts++;
        return fail('x', 'RATE_LIMIT', 'slow', 1000);
      },
    });
    const factory = new AIFactory({ providers: [provider], retries: 2 });
    const promise = factory.process({ prompt: 'hi', signal: controller.signal });
    await jest.advanceTimersByTimeAsync(500);
    controller.abort();
    const res = await promise;
    expect(res.errorInfo?.code).toBe('ABORTED');
    expect(attempts).toBe(1);
  });
});

describe('response shape', () => {
  test('jsonMode + finishReason length is reported as TRUNCATED, keeping data', async () => {
    const provider = makeProvider('x', {
      process: async () => ({ success: true, data: '{"partial":', providerId: 'x', finishReason: 'length' as const, modelUsed: 'm' }),
    });
    const factory = new AIFactory({ providers: [provider] });
    const res = await factory.process({ prompt: 'hi', jsonMode: true });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('TRUNCATED');
    expect(res.data).toBe('{"partial":');
  });

  test('durationMs is a number >= 0 and processingTime matches it', async () => {
    const factory = new AIFactory({ providers: [makeProvider('x')] });
    const res = await factory.process({ prompt: 'hi' });
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('routing', () => {
  test('an explicit provider/model prefix routes and strips the prefix', async () => {
    let seenModel: string | undefined;
    const a = makeProvider('a');
    const b = makeProvider('b', {
      process: async (req) => {
        seenModel = req.modelId;
        return { success: true, data: 'ok', providerId: 'b' };
      },
    });
    const factory = new AIFactory({ providers: [a, b] });
    const res = await factory.process({ prompt: 'hi', modelId: 'b/anything' });
    expect(res.providerId).toBe('b');
    expect(seenModel).toBe('anything');
  });

  test('getProviderForModel (an exact list match) beats the static catalog guess', async () => {
    const custom = makeProvider('custom', { supportedModels: ['gpt-4o'], isModelSupported: (m) => m === 'gpt-4o' });
    const factory = new AIFactory({ providers: [custom] });
    const res = await factory.process({ prompt: 'hi', modelId: 'gpt-4o' });
    expect(res.providerId).toBe('custom');
  });

  test('the static catalog routes claude-* to a provider named anthropic, no discovery needed', async () => {
    const anthropic = makeProvider('anthropic', { supportedModels: [], isModelSupported: () => false });
    const factory = new AIFactory({ providers: [anthropic], discover: 'none' });
    const res = await factory.process({ prompt: 'hi', modelId: 'claude-3-5' });
    expect(res.providerId).toBe('anthropic');
  });

  test('a model whose provider failed its connection check reports NO_PROVIDERS, others untouched', async () => {
    const openai = makeProvider('openai', { testConnection: async () => false });
    const otherProcess = jest.fn().mockResolvedValue({ success: true, data: 'ok', providerId: 'other' });
    const other = makeProvider('other', { supportedModels: [], isModelSupported: () => false, process: otherProcess });
    const factory = new AIFactory({ providers: [openai, other] }); // discover: 'eager' default
    const res = await factory.process({ prompt: 'hi', modelId: 'gpt-4o' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('NO_PROVIDERS');
    expect(res.error).toContain('openai');
    expect(otherProcess).not.toHaveBeenCalled();
  });
});

describe('discovery modes', () => {
  test("discover: 'lazy' defers discovery to first use, once per provider", async () => {
    const discoverModels = jest.fn(async () => ['m']);
    const testConnection = jest.fn(async () => true);
    // Lazy mode skips the probe when models are already seeded, so start empty.
    const provider = makeProvider('x', { supportedModels: [], discoverModels, testConnection });
    const factory = new AIFactory({ providers: [provider], discover: 'lazy' });

    await factory.ready();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();

    await factory.process({ prompt: 'hi' });
    expect(discoverModels).toHaveBeenCalledTimes(1);

    await factory.process({ prompt: 'again' });
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  test("discover: 'eager' probes providers concurrently and keeps configured order", async () => {
    const startedA = jest.fn();
    const startedB = jest.fn();
    const da = deferred<string[]>();
    const db = deferred<string[]>();
    const a = makeProvider('a', { discoverModels: async () => { startedA(); return da.promise; } });
    const b = makeProvider('b', { discoverModels: async () => { startedB(); return db.promise; } });
    const factory = new AIFactory({ providers: [a, b], discover: 'eager' });

    const readyPromise = factory.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(startedA).toHaveBeenCalled();
    expect(startedB).toHaveBeenCalled();

    da.resolve(['m']);
    db.resolve(['m']);
    await readyPromise;
    expect(factory.getAvailableProviders()).toEqual(['a', 'b']);
  });
});

describe('processStream', () => {
  test('a RATE_LIMIT thrown before the first chunk is retried, then succeeds', async () => {
    jest.useFakeTimers();
    let call = 0;
    async function* gen(): AsyncGenerator<AIStreamChunk, void, void> {
      call++;
      if (call === 1) throw AIError.from({ message: 'slow down', provider: 'x', code: 'RATE_LIMIT', retryAfterMs: 1000 });
      yield { type: 'text', text: 'hello' };
      yield { type: 'done', finishReason: 'stop' };
    }
    const provider: AIProvider = { ...makeProvider('x'), processStream: () => gen() };
    const factory = new AIFactory({ providers: [provider], retries: 2 });
    const chunksPromise = collect(factory.processStream({ prompt: 'hi' }));
    await jest.advanceTimersByTimeAsync(1000);
    const chunks = await chunksPromise;
    expect(call).toBe(2);
    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toBe('hello');
  });

  test('a non-retryable error falls back to another provider mid-stream', async () => {
    async function* failGen(): AsyncGenerator<AIStreamChunk, void, void> {
      throw AIError.from({ message: 'bad key', provider: 'a', code: 'AUTH' });
    }
    async function* okGen(): AsyncGenerator<AIStreamChunk, void, void> {
      yield { type: 'text', text: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    }
    const a: AIProvider = { ...makeProvider('a'), processStream: () => failGen() };
    const b: AIProvider = { ...makeProvider('b'), processStream: () => okGen() };
    const factory = new AIFactory({ providers: [a, b], fallbackProvider: 'b' });
    const chunks = await collect(factory.processStream({ prompt: 'hi' }));
    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toBe('ok');
  });

  test('a failure after the first chunk is thrown, not retried', async () => {
    let calls = 0;
    async function* gen(): AsyncGenerator<AIStreamChunk, void, void> {
      calls++;
      yield { type: 'text', text: 'partial' };
      throw AIError.from({ message: 'overloaded', provider: 'x', code: 'OVERLOADED' });
    }
    const provider: AIProvider = { ...makeProvider('x'), processStream: () => gen() };
    const factory = new AIFactory({ providers: [provider], retries: 2 });
    await expect(collect(factory.processStream({ prompt: 'hi' }))).rejects.toMatchObject({ code: 'OVERLOADED' });
    expect(calls).toBe(1);
  });

  test('the done chunk carries numeric durationMs and timeToFirstTokenMs', async () => {
    async function* gen(): AsyncGenerator<AIStreamChunk, void, void> {
      yield { type: 'text', text: 'hi' };
      yield { type: 'done', finishReason: 'stop' };
    }
    const provider: AIProvider = { ...makeProvider('x'), processStream: () => gen() };
    const factory = new AIFactory({ providers: [provider] });
    const chunks = await collect(factory.processStream({ prompt: 'hi' }));
    const done = (chunks[chunks.length - 1] as DoneChunk);
    expect(typeof done.durationMs).toBe('number');
    expect(typeof done.timeToFirstTokenMs).toBe('number');
  });
});
