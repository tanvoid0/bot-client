import axios from 'axios';
import { AIFactory, GeminiProvider, OllamaProvider, type AIProvider } from '../src/index.js';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Captures what a provider sends and replays a canned reply. */
function stubAxios(reply: unknown) {
  const post = jest.fn().mockResolvedValue({ data: reply });
  const get = jest.fn().mockResolvedValue({ data: { models: [] } });
  mockedAxios.create.mockReturnValue({ post, get } as never);
  return { post, get };
}

beforeEach(() => {
  jest.clearAllMocks();
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
    const { post } = stubAxios(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
      jsonMode: true,
    });

    const body = post.mock.calls[0][1] as any;
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  test('without jsonMode no response mime type is forced', async () => {
    const { post } = stubAxios(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi' });

    const body = post.mock.calls[0][1] as any;
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  test('a response schema is passed through', async () => {
    const { post } = stubAxios(reply);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
      jsonMode: true,
      responseSchema: schema,
    });

    const body = post.mock.calls[0][1] as any;
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  test('token usage is reported so callers can bill it', async () => {
    stubAxios(reply);
    const response = await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
    });

    expect(response.promptTokens).toBe(11);
    expect(response.completionTokens).toBe(7);
    expect(response.tokensUsed).toBe(18);
  });

  test('the output cap leaves room for structured replies', async () => {
    const { post } = stubAxios(reply);
    await new GeminiProvider({ apiKey: 'k' }).process({ prompt: 'hi' });

    const body = post.mock.calls[0][1] as any;
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });

  test('a request without usage metadata omits the token fields', async () => {
    stubAxios({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    const response = await new GeminiProvider({ apiKey: 'k' }).process({
      prompt: 'hi',
    });

    expect(response.success).toBe(true);
    expect(response.promptTokens).toBeUndefined();
    expect(response.tokensUsed).toBeUndefined();
  });
});

describe('Ollama provider', () => {
  const reply = {
    message: { content: '{"ok":true}' },
    prompt_eval_count: 5,
    eval_count: 9,
  };

  test('jsonMode sets the native json format', async () => {
    const { post } = stubAxios(reply);
    const provider = new OllamaProvider();
    await provider.process({ prompt: 'hi', modelId: 'gemma4', jsonMode: true });

    const body = post.mock.calls[0][1] as any;
    expect(body.format).toBe('json');
  });

  test('token counts are summed into tokensUsed', async () => {
    stubAxios(reply);
    const response = await new OllamaProvider().process({
      prompt: 'hi',
      modelId: 'gemma4',
    });

    expect(response.promptTokens).toBe(5);
    expect(response.completionTokens).toBe(9);
    expect(response.tokensUsed).toBe(14);
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

    const factory = new AIFactory({ providers: [provider] });
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

    const factory = new AIFactory({ providers: [provider] });
    await Promise.all([factory.generate('a'), factory.generate('b')]);

    expect(provider.discoverModels).toHaveBeenCalledTimes(1);
  });
});
