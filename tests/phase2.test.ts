/** 1.8.0: presets, providerOptions, hooks, catalog additions, model-list cache, Ollama CLI injection, entry purity. */
import { AIFactory } from '../src/ai-factory.js';
import { AIError } from '../src/core/errors.js';
import { guessProvider } from '../src/core/catalog.js';
import { OpenAICompatibleProvider, PRESETS } from '../src/providers/openai-compatible.js';
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { mergeBody } from '../src/providers/base-provider.js';
import type { AIProvider, AIRequest, FetchLike } from '../src/index.js';

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
const chat = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] };

/** A `fetch` that records calls and answers each with `reply`. */
function stub(reply: (url: string) => unknown) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: (init?.headers as Record<string, string>) ?? {} });
    return ok(reply(url));
  };
  return { fetch, calls };
}

function makeProvider(id: string, overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    providerId: id,
    providerName: id,
    supportedModels: ['m'],
    isModelSupported: () => true,
    discoverModels: async () => ['m'],
    testConnection: async () => true,
    process: async (req: AIRequest) => ({ success: true, data: 'ok', providerId: id, modelUsed: req.modelId ?? 'm', finishReason: 'stop' }),
    ...overrides,
  };
}

describe('presets', () => {
  test('groq: id, name, base URL, env key, requireApiKey', async () => {
    const { fetch, calls } = stub(() => ({ data: [{ id: 'llama-3.3-70b-versatile' }] }));
    const p = new OpenAICompatibleProvider({ preset: 'groq', apiKey: 'k', fetch });
    expect(p.providerId).toBe('groq');
    expect(p.providerName).toBe('Groq');
    expect(await p.discoverModels()).toEqual(['llama-3.3-70b-versatile']);
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/models');
    expect(calls[0].headers.Authorization).toBe('Bearer k');
    const noKey = new OpenAICompatibleProvider({ preset: 'groq', fetch });
    expect((await noKey.process({ prompt: 'x' })).errorInfo?.code).toBe('NO_API_KEY');
  });

  test('a field given alongside the preset overrides it', () => {
    const p = new OpenAICompatibleProvider({ preset: 'groq', id: 'fast', baseURL: 'http://gw' });
    expect(p.providerId).toBe('fast');
    expect((p as any).v1).toBe('http://gw/v1');
  });

  test('mistral sends no stream_options; together lists models from a bare array', async () => {
    const m = stub(() => chat);
    const mistral = new OpenAICompatibleProvider({ preset: 'mistral', apiKey: 'k', fetch: m.fetch });
    await mistral.processStream({ prompt: 'x', modelId: 'mistral-small-latest' }).next().catch(() => undefined);
    expect(m.calls[0].body.stream_options).toBeUndefined();
    const t = stub(() => [{ id: 'a' }, { id: 'b' }]);
    const together = new OpenAICompatibleProvider({ preset: 'together', apiKey: 'k', fetch: t.fetch });
    expect(await together.discoverModels()).toEqual(['a', 'b']);
  });

  test('every preset has a key variable and a /v1 origin', () => {
    for (const [id, p] of Object.entries(PRESETS)) {
      expect(p.apiKeyEnv.length).toBeGreaterThan(0);
      expect(new OpenAICompatibleProvider({ preset: id as keyof typeof PRESETS }).providerId).toBe(id);
    }
  });
});

describe('providerOptions', () => {
  test('mergeBody: top-level wins, nested objects extend', () => {
    expect(mergeBody({ a: 1, options: { t: 0.7 } }, { a: 2, options: { n: 8 }, b: [1] })).toEqual({ a: 2, options: { t: 0.7, n: 8 }, b: [1] });
    expect(mergeBody({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test('reaches the OpenAI-format body and the Ollama options block', async () => {
    const o = stub(() => chat);
    await new OpenAIProvider({ apiKey: 'k', fetch: o.fetch }).process({ prompt: 'x', modelId: 'gpt-4o', providerOptions: { top_p: 0.5, temperature: 0 } });
    expect(o.calls[0].body).toMatchObject({ top_p: 0.5, temperature: 0 });
    const l = stub(() => ({ message: { content: 'hi' }, done: true, done_reason: 'stop' }));
    await new OllamaProvider({ fetch: l.fetch }).process({ prompt: 'x', modelId: 'llama3', providerOptions: { keep_alive: '10m', options: { num_ctx: 8192 } } });
    expect(l.calls[0].body.keep_alive).toBe('10m');
    expect(l.calls[0].body.options).toEqual({ temperature: 0.7, num_ctx: 8192 });
  });
});

describe('hooks', () => {
  const fail = (code: AIError['code']) => ({ success: false as const, error: code, errorInfo: AIError.from({ message: code, provider: 'a', code }), providerId: 'a' });

  test('onRequest / onError(willRetry) / onResponse across a retry and a fallback', async () => {
    const seen: string[] = [];
    let calls = 0;
    const a = makeProvider('a', { process: async () => (++calls === 1 ? fail('RATE_LIMIT') : fail('AUTH')) });
    const b = makeProvider('b');
    const factory = new AIFactory({
      providers: [a, b],
      fallbackProvider: 'b',
      retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      hooks: {
        onRequest: ({ provider }) => void seen.push(`req:${provider}`),
        onError: ({ provider, error, willRetry }) => void seen.push(`err:${provider}:${error.code}:${willRetry}`),
        onResponse: ({ provider, durationMs }) => void seen.push(`res:${provider}:${typeof durationMs}`),
      },
    });
    const res = await factory.process({ prompt: 'hi' });
    expect(res.success).toBe(true);
    expect(seen).toEqual(['req:a', 'err:a:RATE_LIMIT:true', 'req:a', 'err:a:AUTH:false', 'req:b', 'res:b:number']);
  });

  test('streams: onResponse gets the done chunk; a mid-stream throw reaches onError', async () => {
    const seen: string[] = [];
    const good = makeProvider('a', {
      processStream: async function* () {
        yield { type: 'text', text: 'x' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const hooks = {
      onResponse: ({ response }: any) => void seen.push(`res:${response.type}`),
      onError: ({ error, willRetry }: any) => void seen.push(`err:${error.code}:${willRetry}`),
    };
    for await (const _ of new AIFactory({ providers: [good], hooks }).processStream({ prompt: 'hi' })) void _;
    const bad = makeProvider('a', {
      processStream: async function* () {
        yield { type: 'text', text: 'x' };
        throw new Error('cut');
      },
    });
    await expect(async () => {
      for await (const _ of new AIFactory({ providers: [bad], hooks }).processStream({ prompt: 'hi' })) void _;
    }).rejects.toBeInstanceOf(AIError);
    expect(seen).toEqual(["res:done", "err:UNKNOWN:false"]);
  });
});

test('catalog: hosted ids route to their preset, Ollama spellings still to ollama', () => {
  expect(guessProvider('grok-4')).toBe('xai');
  expect(guessProvider('deepseek-chat')).toBe('deepseek');
  expect(guessProvider('deepseek-r1')).toBe('ollama');
  expect(guessProvider('mistral-large-latest')).toBe('mistral');
  expect(guessProvider('codestral-2501')).toBe('mistral');
  expect(guessProvider('open-mistral-nemo')).toBe('mistral');
  expect(guessProvider('mistral:7b')).toBe('ollama');
  expect(guessProvider('mistral')).toBe('ollama');
  expect(guessProvider('llama-3.3-70b-versatile')).toBe('groq');
  expect(guessProvider('llama3.1')).toBe('ollama');
  expect(guessProvider('meta-llama/llama-4-scout')).toBeNull();
});

describe('model list cache', () => {
  test('a second discoverModels() and a testConnection() inside the TTL send nothing', async () => {
    const { fetch, calls } = stub(() => ({ data: [{ id: 'gpt-4o' }] }));
    const p = new OpenAIProvider({ apiKey: 'k', fetch });
    await p.discoverModels();
    await p.discoverModels();
    expect(await p.testConnection()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('modelCacheTtlMs: 0 disables it; a failed listing is not cached', async () => {
    const { fetch, calls } = stub(() => ({ data: [] }));
    const p = new OpenAIProvider({ apiKey: 'k', fetch, modelCacheTtlMs: 0 });
    await p.discoverModels();
    await p.discoverModels();
    expect(calls).toHaveLength(2);
    let n = 0;
    const flaky: FetchLike = async () => (++n === 1 ? new Response('down', { status: 503 }) : ok({ data: [{ id: 'gpt-4o' }] }));
    const q = new OpenAIProvider({ apiKey: 'k', fetch: flaky });
    expect(await q.discoverModels()).toEqual([]);
    expect(await q.discoverModels()).toEqual(['gpt-4o']);
  });
});

describe('Ollama CLI injection', () => {
  test('no cli: management calls fail softly, isCLIAvailable is false', async () => {
    const p = new OllamaProvider({ fetch: async () => new Response('', { status: 503 }) });
    expect(await p.isCLIAvailable()).toBe(false);
    const r = await p.serve();
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/ollama-cli/);
  });

  test('injected cli is used with the configured executable', async () => {
    const cli = jest.fn(async () => ({ ok: true, code: 0, stdout: 'served', stderr: '' }));
    const p = new OllamaProvider({ cli, ollamaExecutablePath: '/opt/ollama' });
    expect((await p.serve()).stdout).toBe('served');
    expect(cli).toHaveBeenCalledWith('serve', [], { executablePath: '/opt/ollama' });
    expect(await p.isCLIAvailable()).toBe(true);
  });
});

describe('entry purity', () => {
  // The JS API, not `bin/esbuild`: on Linux that file is the native binary, not a script `node` can run.
  const { buildSync } = require('esbuild');
  const bundle = (entry: string) =>
    buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' }).outputFiles[0].text;

  test('the main entry and every provider subpath bundle for the browser with no node built-ins', () => {
    for (const entry of ['src/index.ts', 'src/core.ts', 'src/providers/openai-provider.ts', 'src/providers/anthropic-provider.ts', 'src/providers/gemini-provider.ts', 'src/providers/ollama-provider.ts', 'src/providers/lmstudio-provider.ts', 'src/providers/openai-compatible.ts']) {
      const out = bundle(entry);
      expect(out).not.toMatch(/child_process|["']node:|require\(["']fs["']\)/);
    }
  });

  test('the ollama-cli subpath is the one that spawns', () => {
    expect(() => bundle('src/ollama-cli.ts')).toThrow();
  });
});
