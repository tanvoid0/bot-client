/**
 * Structured output: what each provider sends for `schema`, and how the
 * factory parses and validates the answer onto `object`. The Standard Schema
 * here is hand-written so no validation library is needed.
 */
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { AIFactory } from '../src/ai-factory.js';
import { parseJson } from '../src/core/schema.js';
import type { AIProvider, AIRequest, StandardSchemaV1 } from '../src/types/index.js';

const JSON_SCHEMA = { type: 'object', properties: { city: { type: 'string' }, tempC: { type: 'number' } }, required: ['city', 'tempC'] };

/** `{ city: string, tempC: number }`, with a Zod-style transform (tempC rounded) to prove `value` is what lands on `object`. */
const weatherSchema: StandardSchemaV1<unknown, { city: string; tempC: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(v: any) {
      if (typeof v?.city !== 'string') return { issues: [{ message: 'Expected string', path: ['city'] }] };
      if (typeof v?.tempC !== 'number') return { issues: [{ message: 'Expected number', path: [{ key: 'tempC' }] }] };
      return { value: { city: v.city, tempC: Math.round(v.tempC) } };
    },
    jsonSchema: { input: () => JSON_SCHEMA },
  },
};

/** Same, but without the JSON Schema extension, as an older library would be. */
const bareSchema: StandardSchemaV1 = { '~standard': { version: 1, vendor: 'test', validate: weatherSchema['~standard'].validate } };

function capture(reply: unknown) {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
  return () => JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

function answering(data: string, finishReason: 'stop' | 'length' = 'stop'): AIProvider {
  return {
    providerId: 'p',
    providerName: 'p',
    supportedModels: ['m'],
    isModelSupported: () => true,
    discoverModels: async () => ['m'],
    testConnection: async () => true,
    process: async () => ({ success: true, data, providerId: 'p', modelUsed: 'm', finishReason }),
  };
}

const factoryFor = (p: AIProvider) => new AIFactory({ providers: [p], discover: 'none', retry: { retries: 0 } });

afterEach(() => jest.restoreAllMocks());

describe('wire', () => {
  test('OpenAI: json_schema when a JSON form exists, json_object otherwise', async () => {
    let body = capture({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', prompt: 'x', schema: weatherSchema });
    expect(body().response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', schema: JSON_SCHEMA } });
    jest.restoreAllMocks();

    body = capture({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', prompt: 'x', schema: bareSchema });
    expect(body().response_format).toEqual({ type: 'json_object' });
  });

  test('a plain JSON Schema object is sent as is', async () => {
    const body = capture({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', prompt: 'x', schema: JSON_SCHEMA });
    expect(body().response_format.json_schema.schema).toEqual(JSON_SCHEMA);
  });

  test('Anthropic: the nudge names the schema', async () => {
    const body = capture({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' });
    await new AnthropicProvider({ apiKey: 'k' }).process({ modelId: 'claude-3-5', prompt: 'x', schema: weatherSchema });
    expect(body().system).toContain('JSON Schema');
    expect(body().system).toContain('"tempC"');
  });

  test('Gemini: responseMimeType + responseSchema', async () => {
    const body = capture({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] });
    await new GeminiProvider({ apiKey: 'k' }).process({ modelId: 'gemini-2.0-flash', prompt: 'x', schema: weatherSchema });
    expect(body().generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: JSON_SCHEMA });
  });

  test('Ollama: format is the schema object, or "json" for jsonMode', async () => {
    let body = capture({ message: { content: '{}' }, done: true, done_reason: 'stop' });
    await new OllamaProvider().process({ modelId: 'llama3.1', prompt: 'x', schema: weatherSchema });
    expect(body().format).toEqual(JSON_SCHEMA);
    jest.restoreAllMocks();
    body = capture({ message: { content: '{}' }, done: true, done_reason: 'stop' });
    await new OllamaProvider().process({ modelId: 'llama3.1', prompt: 'x', jsonMode: true });
    expect(body().format).toBe('json');
  });
});

describe('factory', () => {
  test('valid answer → object is the validated value', async () => {
    const res = await factoryFor(answering('{"city":"Oslo","tempC":21.4}')).process({ prompt: 'x', schema: weatherSchema });
    expect(res.success).toBe(true);
    expect(res.object).toEqual({ city: 'Oslo', tempC: 21 });
    expect(res.data).toBe('{"city":"Oslo","tempC":21.4}');
  });

  test('a ```json fence is tolerated', async () => {
    const res = await factoryFor(answering('```json\n{"city":"Oslo","tempC":2}\n```')).process({ prompt: 'x', schema: JSON_SCHEMA });
    expect(res.object).toEqual({ city: 'Oslo', tempC: 2 });
  });

  test('not JSON → INVALID_JSON, raw text kept', async () => {
    const res = await factoryFor(answering('Sure! Here is')).process({ prompt: 'x', schema: weatherSchema });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('INVALID_JSON');
    expect(res.errorInfo?.retryable).toBe(false);
    expect(res.data).toBe('Sure! Here is');
    expect(res.errorInfo?.hint?.length).toBeGreaterThan(0);
  });

  test('issues → SCHEMA_MISMATCH naming the path', async () => {
    const res = await factoryFor(answering('{"city":"Oslo","tempC":"warm"}')).process({ prompt: 'x', schema: weatherSchema });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('SCHEMA_MISMATCH');
    expect(res.errorInfo?.message).toContain('tempC: Expected number');
    expect(res.errorInfo?.details).toEqual([{ message: 'Expected number', path: 'tempC' }]);
  });

  test('cut off by maxTokens → TRUNCATED, even with schema alone', async () => {
    const res = await factoryFor(answering('{"city":"Os', 'length')).process({ prompt: 'x', schema: JSON_SCHEMA });
    expect(res.errorInfo?.code).toBe('TRUNCATED');
  });

  test('no schema → no object, text untouched', async () => {
    const res = await factoryFor(answering('plain')).process({ prompt: 'x' } as AIRequest);
    expect(res.object).toBeUndefined();
  });
});

test('parseJson', () => {
  expect(parseJson(' [1] ')).toEqual({ value: [1] });
  expect(parseJson('```\n{"a":1}\n```')).toEqual({ value: { a: 1 } });
  expect('error' in parseJson('{')).toBe(true);
});
