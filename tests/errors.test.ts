/**
 * Table-driven coverage of the §5.2 classification table: every provider maps
 * its own error body to the right `AIErrorCode`, keeps the provider's message
 * verbatim, and always attaches a hint.
 */
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { LMStudioProvider } from '../src/providers/lmstudio-provider.js';
import { AIError, type AIErrorCode } from '../src/core/errors.js';

function stub(status: number, body: unknown, headers?: Record<string, string>) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
}

afterEach(() => jest.restoreAllMocks());

interface Row {
  name: string;
  status: number;
  body: any;
  headers?: Record<string, string>;
  code: AIErrorCode;
  retryable: boolean;
  providerCode?: string;
  retryAfterMs?: number;
}

/** Checks every field the docs promise on a classified error, `hint` included. */
function assertRow(errorInfo: AIError | undefined, row: Row, message: string) {
  expect(errorInfo).toBeDefined();
  const e = errorInfo!;
  expect(e.code).toBe(row.code);
  expect(e.retryable).toBe(row.retryable);
  expect(e.message).toBe(message);
  expect(e.providerCode).toBe(row.providerCode);
  expect(e.statusCode).toBe(row.status);
  expect(e.hint).toEqual(expect.any(String));
  expect((e.hint as string).length).toBeGreaterThan(0);
  if (row.retryAfterMs !== undefined) expect(e.retryAfterMs).toBe(row.retryAfterMs);
}

describe('OpenAIProvider error classification', () => {
  const rows: Row[] = [
    {
      name: 'invalid api key',
      status: 401,
      body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } },
      code: 'AUTH',
      retryable: false,
      providerCode: 'invalid_api_key',
    },
    {
      name: 'insufficient quota',
      status: 429,
      body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } },
      code: 'QUOTA',
      retryable: false,
      providerCode: 'insufficient_quota',
    },
    {
      name: 'rate limit with Retry-After',
      status: 429,
      headers: { 'retry-after': '20' },
      body: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } },
      code: 'RATE_LIMIT',
      retryable: true,
      providerCode: 'rate_limit_exceeded',
      retryAfterMs: 20000,
    },
    {
      name: 'model not found',
      status: 404,
      body: { error: { message: "The model 'gpt-9' does not exist", type: 'invalid_request_error', code: 'model_not_found' } },
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      providerCode: 'model_not_found',
    },
    {
      name: 'context length',
      status: 400,
      body: {
        error: {
          message: "This model's maximum context length is 128000 tokens",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      },
      code: 'CONTEXT_LENGTH',
      retryable: false,
      providerCode: 'context_length_exceeded',
    },
    {
      name: 'server error',
      status: 500,
      body: { error: { message: 'The server had an error while processing your request' } },
      code: 'SERVER',
      retryable: true,
    },
    {
      name: 'overloaded',
      status: 503,
      body: { error: { message: 'The engine is currently overloaded, please try again later' } },
      code: 'OVERLOADED',
      retryable: true,
    },
  ];

  test.each(rows)('$name → $code', async (row) => {
    stub(row.status, row.body, row.headers);
    const res = await new OpenAIProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gpt-4o' });
    expect(res.success).toBe(false);
    assertRow(res.errorInfo, row, row.body.error.message);
  });

  test('x-request-id header is surfaced as requestId', async () => {
    stub(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, { 'x-request-id': 'req_123' });
    const res = await new OpenAIProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gpt-4o' });
    expect(res.errorInfo?.requestId).toBe('req_123');
  });

  test('String(error) renders "[openai/AUTH] message"', async () => {
    stub(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
    const res = await new OpenAIProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gpt-4o' });
    expect(String(res.errorInfo)).toMatch(/^\[openai\/AUTH\] /);
  });
});

describe('AnthropicProvider error classification', () => {
  const rows: Row[] = [
    {
      name: 'authentication_error',
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      code: 'AUTH',
      retryable: false,
      providerCode: 'authentication_error',
    },
    {
      name: 'rate_limit_error',
      status: 429,
      body: {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' },
      },
      code: 'RATE_LIMIT',
      retryable: true,
      providerCode: 'rate_limit_error',
    },
    {
      name: 'overloaded_error',
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      code: 'OVERLOADED',
      retryable: true,
      providerCode: 'overloaded_error',
    },
    {
      name: 'not_found_error',
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-9' } },
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      providerCode: 'not_found_error',
    },
    {
      name: 'invalid_request_error (context)',
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' },
      },
      code: 'CONTEXT_LENGTH',
      retryable: false,
      providerCode: 'invalid_request_error',
    },
  ];

  test.each(rows)('$name → $code', async (row) => {
    stub(row.status, row.body);
    const res = await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'claude-3-5' });
    expect(res.success).toBe(false);
    assertRow(res.errorInfo, row, row.body.error.message);
  });

  it('invalid_request_error (other) → INVALID_REQUEST, with a hint', async () => {
    const row: Row = {
      name: 'invalid_request_error (other)',
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages: at least one message is required' } },
      code: 'INVALID_REQUEST',
      retryable: false,
      providerCode: 'invalid_request_error',
    };
    stub(row.status, row.body);
    const res = await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'claude-3-5' });
    assertRow(res.errorInfo, row, row.body.error.message);
  });

  test('request-id header is surfaced as requestId', async () => {
    stub(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { 'request-id': 'req_abc' });
    const res = await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'claude-3-5' });
    expect(res.errorInfo?.requestId).toBe('req_abc');
  });
});

describe('GeminiProvider error classification', () => {
  const rows: Row[] = [
    {
      name: 'API_KEY_INVALID',
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
        },
      },
      code: 'AUTH',
      retryable: false,
      providerCode: 'API_KEY_INVALID',
    },
    {
      name: 'RESOURCE_EXHAUSTED',
      status: 429,
      body: {
        error: {
          code: 429,
          message: 'You exceeded your current quota',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
        },
      },
      code: 'RATE_LIMIT',
      retryable: true,
      providerCode: 'RESOURCE_EXHAUSTED',
      retryAfterMs: 30000,
    },
    {
      name: 'NOT_FOUND',
      status: 404,
      body: { error: { code: 404, message: 'models/gemini-9 is not found for API version v1beta', status: 'NOT_FOUND' } },
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      providerCode: 'NOT_FOUND',
    },
    {
      name: 'UNAVAILABLE',
      status: 503,
      body: { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } },
      code: 'OVERLOADED',
      retryable: true,
      providerCode: 'UNAVAILABLE',
    },
  ];

  test.each(rows)('$name → $code', async (row) => {
    stub(row.status, row.body);
    const res = await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gemini-2.0-flash' });
    expect(res.success).toBe(false);
    assertRow(res.errorInfo, row, row.body.error.message);
  });

  test('a 200 body with promptFeedback.blockReason and no candidates is CONTENT_FILTER', async () => {
    stub(200, { promptFeedback: { blockReason: 'SAFETY' } });
    const res = await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gemini-2.0-flash' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('CONTENT_FILTER');
    expect(res.errorInfo?.hint?.length).toBeGreaterThan(0);
  });

  test('a 200 body with finishReason SAFETY and no parts is CONTENT_FILTER', async () => {
    stub(200, { candidates: [{ content: {}, finishReason: 'SAFETY' }] });
    const res = await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gemini-2.0-flash' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('CONTENT_FILTER');
  });

  test('a 200 body with finishReason MAX_TOKENS and text succeeds with finishReason length', async () => {
    stub(200, { candidates: [{ content: { parts: [{ text: 'partial answer' }] }, finishReason: 'MAX_TOKENS' }] });
    const res = await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi', modelId: 'gemini-2.0-flash' });
    expect(res.success).toBe(true);
    expect(res.finishReason).toBe('length');
  });
});

describe('OllamaProvider error classification', () => {
  test("model not found → MODEL_NOT_FOUND, hint says 'ollama pull llama9'", async () => {
    stub(404, { error: "model 'llama9' not found, try pulling it first" });
    const res = await new OllamaProvider().process({ prompt: 'hi', modelId: 'llama9' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('MODEL_NOT_FOUND');
    expect(res.errorInfo?.retryable).toBe(false);
    expect(res.errorInfo?.message).toBe("model 'llama9' not found, try pulling it first");
    expect(res.errorInfo?.statusCode).toBe(404);
    expect(res.errorInfo?.hint).toContain('ollama pull llama9');
  });

  test('runner crash → SERVER, retryable', async () => {
    stub(500, { error: 'llama runner process has terminated' });
    const res = await new OllamaProvider().process({ prompt: 'hi', modelId: 'llama9' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('SERVER');
    expect(res.errorInfo?.retryable).toBe(true);
    expect(res.errorInfo?.message).toBe('llama runner process has terminated');
  });

  test('connection refused → PROVIDER_UNREACHABLE, hint names the base URL', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const res = await new OllamaProvider().process({ prompt: 'hi', modelId: 'llama9' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('PROVIDER_UNREACHABLE');
    expect(res.errorInfo?.hint).toContain('http://localhost:11434');
  });

  test('no models and no modelId → NO_MODEL without calling fetch', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const res = await new OllamaProvider().process({ prompt: 'hi' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('NO_MODEL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LMStudioProvider error classification', () => {
  test('connection refused → PROVIDER_UNREACHABLE, hint names the base URL', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const res = await new LMStudioProvider().process({ prompt: 'hi', modelId: 'local-model' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('PROVIDER_UNREACHABLE');
    expect(res.errorInfo?.hint).toContain('http://localhost:1234');
  });

  test('no models and no modelId → NO_MODEL without calling fetch', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const res = await new LMStudioProvider().process({ prompt: 'hi' });
    expect(res.success).toBe(false);
    expect(res.errorInfo?.code).toBe('NO_MODEL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AIError basics', () => {
  test('AIError.from(...).toJSON() carries code/provider/message', () => {
    const err = AIError.from({ message: 'boom', provider: 'openai', code: 'AUTH' });
    const json = err.toJSON();
    expect(json.code).toBe('AUTH');
    expect(json.provider).toBe('openai');
    expect(json.message).toBe('boom');
  });
});
