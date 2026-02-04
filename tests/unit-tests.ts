import { AIFactory, aiFactory, ensureFactoryReady, AIRequest, AIResponse, AIError, type AIProvider } from '../src/index.js';
import { buildChatMessages } from '../src/providers/base-provider.js';

describe('Bot Client Unit Tests', () => {
  describe('AIRequest Interface', () => {
    test('should accept valid AIRequest object', () => {
      const request: AIRequest = {
        prompt: 'Hello, world!',
        modelId: 'test-model',
        temperature: 0.7,
        maxTokens: 100
      };

      expect(request.prompt).toBe('Hello, world!');
      expect(request.modelId).toBe('test-model');
      expect(request.temperature).toBe(0.7);
      expect(request.maxTokens).toBe(100);
    });

    test('should accept minimal AIRequest object', () => {
      const request: AIRequest = {
        prompt: 'Test prompt'
      };

      expect(request.prompt).toBe('Test prompt');
      expect(request.modelId).toBeUndefined();
    });

    test('should accept AIRequest with history and systemPrompt', () => {
      const request: AIRequest = {
        prompt: 'Follow-up',
        systemPrompt: 'You are helpful.',
        history: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' }
        ]
      };
      expect(request.history).toHaveLength(2);
      expect(request.systemPrompt).toBe('You are helpful.');
    });
  });

  describe('AIResponse Interface', () => {
    test('should accept valid AIResponse object', () => {
      const response: AIResponse = {
        success: true,
        data: 'Test response',
        modelUsed: 'test-model',
        providerId: 'test-provider',
        tokensUsed: 50,
        cost: 0.001,
        processingTime: 100,
        modelCapabilities: ['text-generation'],
        suggestedImprovements: ['Use more specific prompt'],
        confidence: 0.9
      };

      expect(response.success).toBe(true);
      expect(response.data).toBe('Test response');
      expect(response.modelUsed).toBe('test-model');
    });

    test('should accept error AIResponse object', () => {
      const response: AIResponse = {
        success: false,
        error: 'Test error message',
        modelUsed: 'test-model',
        providerId: 'test-provider'
      };

      expect(response.success).toBe(false);
      expect(response.error).toBe('Test error message');
    });
  });

  describe('AIError Class', () => {
    test('should create AIError instance', () => {
      const error = new AIError('Test error', 'test-provider', 400);

      expect(error).toBeInstanceOf(AIError);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error');
      expect(error.provider).toBe('test-provider');
      expect(error.statusCode).toBe(400);
    });

    test('should create AIError without status code', () => {
      const error = new AIError('Test error', 'test-provider');

      expect(error.message).toBe('Test error');
      expect(error.provider).toBe('test-provider');
      expect(error.statusCode).toBeUndefined();
    });

    test('should create AIError with optional code', () => {
      const error = new AIError('No key', 'openai', 401, undefined, 'NO_API_KEY');
      expect(error.code).toBe('NO_API_KEY');
    });
  });

  describe('buildChatMessages', () => {
    test('builds messages with only prompt', () => {
      const messages = buildChatMessages({ prompt: 'Hi' });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hi' });
    });

    test('builds messages with systemPrompt then prompt', () => {
      const messages = buildChatMessages({ prompt: 'Hi', systemPrompt: 'You are helpful.' });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(messages[1]).toEqual({ role: 'user', content: 'Hi' });
    });

    test('builds messages with history then prompt', () => {
      const messages = buildChatMessages({
        prompt: 'Again?',
        history: [
          { role: 'user', content: 'One' },
          { role: 'assistant', content: 'Two' }
        ]
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: 'One' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Two' });
      expect(messages[2]).toEqual({ role: 'user', content: 'Again?' });
    });

    test('builds messages with systemPrompt, history, and prompt', () => {
      const messages = buildChatMessages({
        prompt: 'Reply',
        systemPrompt: 'System',
        history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]
      });
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
      expect(messages[3]).toEqual({ role: 'user', content: 'Reply' });
    });
  });

  describe('AIFactory (real instance with no providers)', () => {
    test('should have getAvailableProviders method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.getAvailableProviders).toBe('function');
    });

    test('should have getAllSupportedModels method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.getAllSupportedModels).toBe('function');
    });

    test('should have getProvider method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.getProvider).toBe('function');
    });

    test('should have getProviderForModel method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.getProviderForModel).toBe('function');
    });

    test('should have testProviders method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.testProviders).toBe('function');
    });

    test('should have ready method', () => {
      const factory = new AIFactory({ providers: [] });
      expect(typeof factory.ready).toBe('function');
    });

    test('empty factory returns empty providers and models', async () => {
      const factory = new AIFactory({ providers: [] });
      await factory.ready();
      expect(factory.getAvailableProviders()).toEqual([]);
      expect(factory.getAllSupportedModels()).toEqual([]);
      expect(factory.getProviderForModel('gpt-4')).toBeNull();
      const status = await factory.testProviders();
      expect(status).toEqual({});
    });

    test('process with no providers returns error response', async () => {
      const factory = new AIFactory({ providers: [] });
      const response = await factory.process({ prompt: 'Hello' });
      expect(response.success).toBe(false);
      expect(response.error).toBe('No AI providers available');
      expect(response.providerId).toBe('none');
    });

    test('generate with no providers throws AIError', async () => {
      const factory = new AIFactory({ providers: [] });
      await expect(factory.generate('Hello')).rejects.toThrow(AIError);
    });
  });

  describe('AIFactory with mock provider', () => {
    function createMockProvider(id: string, models: string[] = ['mock-model']): AIProvider {
      return {
        providerId: id,
        providerName: `Mock ${id}`,
        supportedModels: models,
        isModelSupported: (modelId: string) => models.includes(modelId),
        discoverModels: async () => models,
        testConnection: async () => true,
        process: async (req: AIRequest) => ({
          success: true,
          data: `echo: ${req.prompt}`,
          modelUsed: req.modelId ?? models[0],
          providerId: id
        })
      };
    }

    test('uses single provider for process and generate', async () => {
      const mock = createMockProvider('mock');
      const factory = new AIFactory({ providers: [mock] });
      await factory.ready();
      expect(factory.getAvailableProviders()).toEqual(['mock']);
      expect(factory.getProviderForModel('mock-model')).toBe(mock);
      expect(factory.getAllSupportedModels()).toEqual(['mock-model']);

      const response = await factory.process({ prompt: 'Hi' });
      expect(response.success).toBe(true);
      expect(response.data).toBe('echo: Hi');
      expect(response.providerId).toBe('mock');

      const text = await factory.generate('Hello');
      expect(text).toBe('echo: Hello');
    });

    test('respects defaultProvider when set', async () => {
      const a = createMockProvider('a', ['model-a']);
      const b = createMockProvider('b', ['model-b']);
      const factory = new AIFactory({
        providers: [a, b],
        defaultProvider: 'b'
      });
      await factory.ready();
      const response = await factory.process({ prompt: 'Hi' });
      expect(response.providerId).toBe('b');
    });

    test('respects providerOrder when no defaultProvider', async () => {
      const a = createMockProvider('a');
      const b = createMockProvider('b');
      const factory = new AIFactory({
        providers: [a, b],
        providerOrder: ['b', 'a']
      });
      await factory.ready();
      const response = await factory.process({ prompt: 'Hi' });
      expect(response.providerId).toBe('b');
    });

    test('uses getProviderForModel when modelId specified', async () => {
      const a = createMockProvider('a', ['gpt-4']);
      const b = createMockProvider('b', ['llama']);
      const factory = new AIFactory({ providers: [a, b] });
      await factory.ready();
      const response = await factory.process({ prompt: 'Hi', modelId: 'gpt-4' });
      expect(response.providerId).toBe('a');
    });

    test('fallback provider is used when primary fails', async () => {
      const primary = createMockProvider('primary');
      const fallback = createMockProvider('fallback');
      const failingProvider: AIProvider = {
        ...primary,
        providerId: 'fail',
        providerName: 'Fail',
        process: async () => ({ success: false, error: 'fail', providerId: 'fail' })
      };
      const factory = new AIFactory({
        providers: [failingProvider, fallback],
        defaultProvider: 'fail',
        fallbackProvider: 'fallback'
      });
      await factory.ready();
      const response = await factory.process({ prompt: 'Hi' });
      expect(response.success).toBe(true);
      expect(response.providerId).toBe('fallback');
      expect(response.data).toBe('echo: Hi');
    });

    test('retries when retries config is set and first attempt fails', async () => {
      let attempts = 0;
      const flaky: AIProvider = {
        providerId: 'flaky',
        providerName: 'Flaky',
        supportedModels: ['x'],
        isModelSupported: () => true,
        discoverModels: async () => ['x'],
        testConnection: async () => true,
        process: async (req: AIRequest) => {
          attempts++;
          if (attempts < 2) {
            return { success: false, error: 'temp', providerId: 'flaky' };
          }
          return { success: true, data: `ok: ${req.prompt}`, providerId: 'flaky' };
        }
      };
      const factory = new AIFactory({ providers: [flaky], retries: 2 });
      await factory.ready();
      const response = await factory.process({ prompt: 'Hi' });
      expect(response.success).toBe(true);
      expect(response.data).toBe('ok: Hi');
      expect(attempts).toBe(2);
    });
  });

  describe('ensureFactoryReady', () => {
    test('returns aiFactory after ready', async () => {
      const factory = await ensureFactoryReady();
      expect(factory).toBe(aiFactory);
      expect(factory.getAvailableProviders()).toEqual(expect.any(Array));
    });
  });

  describe('Logger (factory config)', () => {
    test('calls logger.info during init when logger is provided', async () => {
      const info = jest.fn();
      const warn = jest.fn();
      const logger = { info, warn };
      const factory = new AIFactory({ providers: [], logger });
      await factory.ready();
      expect(info).toHaveBeenCalledWith('Initializing AI providers...');
      expect(info).toHaveBeenCalledWith('Total providers available: 0');
    });

    test('does not call logger when no logger is provided', async () => {
      const factory = new AIFactory({ providers: [] });
      await factory.ready();
      // No way to assert "nothing was logged" without a spy on console; we just ensure no throw
      expect(factory.getAvailableProviders()).toEqual([]);
    });

    test('calls logger.warn when provider fails (optional)', async () => {
      const warn = jest.fn();
      const info = jest.fn();
      const failingProvider: AIProvider = {
        providerId: 'fail',
        providerName: 'Fail',
        supportedModels: [],
        isModelSupported: () => false,
        discoverModels: async () => [],
        testConnection: async () => false,
        process: async () => ({ success: false, error: 'x', providerId: 'fail' })
      };
      const factory = new AIFactory({
        providers: [failingProvider],
        logger: { info, warn }
      });
      await factory.ready();
      expect(warn).toHaveBeenCalledWith('Fail connection test failed');
    });
  });
});
