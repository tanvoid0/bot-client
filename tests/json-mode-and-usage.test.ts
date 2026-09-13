import { AIFactory, GeminiProvider, OllamaProvider, type AIProvider } from '../src/index.js';

/** Replays a canned JSON reply from `fetch`; `body()` is what the provider sent. */
function stubFetch(reply: unknown) {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
  const body = () => JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
  return { fetchMock, body };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Gemini provider', () => {
  const reply = {
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 18,
    },
  };

  test('jsonMode asks for an application/json response', async () => {
    const { body } = stubFetch(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
      jsonMode: true,
    });

    expect(body().generationConfig.responseMimeType).toBe('application/json');
  });

  test('without jsonMode no response mime type is forced', async () => {
    const { body } = stubFetch(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi' });

    expect(body().generationConfig.responseMimeType).toBeUndefined();
  });

  test('a response schema is passed through', async () => {
    const { body } = stubFetch(reply);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
      jsonMode: true,
      schema,
    });

    expect(body().generationConfig.responseSchema).toEqual(schema);
  });

  test('token usage is reported so callers can bill it', async () => {
    stubFetch(reply);
    const response = await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
    });

    expect(response.usage?.promptTokens).toBe(11);
    expect(response.usage?.completionTokens).toBe(7);
    expect(response.usage?.totalTokens).toBe(18);
  });

  test('the output cap leaves room for structured replies', async () => {
    const { body } = stubFetch(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi' });

    expect(body().generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });

  test('a request without usage metadata omits the token fields', async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const response = await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
    });

    expect(response.success).toBe(true);
    expect(response.usage?.promptTokens).toBeUndefined();
    expect(response.usage?.totalTokens).toBeUndefined();
  });
});

describe('Ollama provider', () => {
  const reply = {
    message: { content: '{"ok":true}' },
    prompt_eval_count: 5,
    eval_count: 9,
  };

  test('jsonMode sets the native json format', async () => {
    const { body } = stubFetch(reply);
    const provider = new OllamaProvider();
    await provider.process({ prompt: 'hi', modelId: 'gemma4', jsonMode: true });

    expect(body().format).toBe('json');
  });

  test('token counts are summed into tokensUsed', async () => {
    stubFetch(reply);
    const response = await new OllamaProvider().process({
      prompt: 'hi',
      modelId: 'gemma4',
    });

    expect(response.usage?.promptTokens).toBe(5);
    expect(response.usage?.completionTokens).toBe(9);
    expect(response.usage?.totalTokens).toBe(14);
  });
});

describe('AIFactory', () => {
  test('constructing does not probe providers', async () => {
    const provider: AIProvider = {
      providerId: 'stub',
      providerName: 'Stub',
      supportedModels: ['stub-1'],
      process: jest.fn().mockResolvedValue({ success: true, data: 'ok' }),
      isModelSupported: () => true,
      testConnection: jest.fn().mockResolvedValue(true),
      discoverModels: jest.fn().mockResolvedValue(['stub-1']),
    };

    const factory = new AIFactory({ providers: [provider], discover: 'eager' });
    expect(provider.discoverModels).not.toHaveBeenCalled();
    expect(provider.testConnection).not.toHaveBeenCalled();

    await factory.generate('hi');
    expect(provider.discoverModels).toHaveBeenCalledTimes(1);
  });

  test('discovery runs once across concurrent requests', async () => {
    const provider: AIProvider = {
      providerId: 'stub',
      providerName: 'Stub',
      supportedModels: ['stub-1'],
      process: jest.fn().mockResolvedValue({ success: true, data: 'ok' }),
      isModelSupported: () => true,
      testConnection: jest.fn().mockResolvedValue(true),
      discoverModels: jest.fn().mockResolvedValue(['stub-1']),
    };

    const factory = new AIFactory({ providers: [provider], discover: 'eager' });
    await Promise.all([factory.generate('a'), factory.generate('b')]);

    expect(provider.discoverModels).toHaveBeenCalledTimes(1);
  });
});
