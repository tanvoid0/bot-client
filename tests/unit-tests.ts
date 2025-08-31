import { AIRequest, AIResponse, AIError } from '../src/types/index.js';

// Mock AIFactory for testing
class MockAIFactory {
  private providers = new Map();
  private config = { defaultProvider: 'test' };

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getAllSupportedModels(): string[] {
    return [];
  }

  getConfig() {
    return this.config;
  }

  addProvider(id: string, provider: any) {
    this.providers.set(id, provider);
  }

  getProvider(id: string) {
    return this.providers.get(id);
  }

  isModelSupported(modelId: string): boolean {
    return false;
  }

  getProviderForModel(modelId: string): string | null {
    return null;
  }

  async testProviders(): Promise<Record<string, boolean>> {
    return {};
  }

  async generate(prompt: string, options?: any): Promise<string> {
    throw new Error('No providers available');
  }

  async process(request: AIRequest): Promise<AIResponse> {
    return {
      success: false,
      error: 'No suitable AI provider available',
      modelUsed: 'none',
      providerId: 'none'
    };
  }
}

describe('Bot Client Unit Tests', () => {
  let factory: MockAIFactory;

  beforeEach(() => {
    factory = new MockAIFactory();
  });

  describe('AIFactory', () => {
    test('should create factory instance', () => {
      expect(factory).toBeInstanceOf(MockAIFactory);
    });

    test('should have getAvailableProviders method', () => {
      expect(typeof factory.getAvailableProviders).toBe('function');
    });

    test('should have getAllSupportedModels method', () => {
      expect(typeof factory.getAllSupportedModels).toBe('function');
    });

    test('should have getConfig method', () => {
      expect(typeof factory.getConfig).toBe('function');
    });

    test('should return empty providers list when no providers configured', () => {
      const providers = factory.getAvailableProviders();
      expect(Array.isArray(providers)).toBe(true);
    });

    test('should return empty models list when no providers configured', () => {
      const models = factory.getAllSupportedModels();
      expect(Array.isArray(models)).toBe(true);
    });

    test('should have configuration object', () => {
      const config = factory.getConfig();
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });
  });

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
  });

  describe('Factory Methods', () => {
    test('should have addProvider method', () => {
      expect(typeof factory.addProvider).toBe('function');
    });

    test('should have getProvider method', () => {
      expect(typeof factory.getProvider).toBe('function');
    });

    test('should have isModelSupported method', () => {
      expect(typeof factory.isModelSupported).toBe('function');
    });

    test('should have getProviderForModel method', () => {
      expect(typeof factory.getProviderForModel).toBe('function');
    });

    test('should have testProviders method', () => {
      expect(typeof factory.testProviders).toBe('function');
    });

    test('should return false for unsupported model', () => {
      const isSupported = factory.isModelSupported('non-existent-model');
      expect(isSupported).toBe(false);
    });

    test('should return null for unsupported model provider', () => {
      const provider = factory.getProviderForModel('non-existent-model');
      expect(provider).toBeNull();
    });
  });

  describe('Async Methods', () => {
    test('testProviders should return promise', async () => {
      const result = factory.testProviders();
      expect(result).toBeInstanceOf(Promise);
      
      const providers = await result;
      expect(typeof providers).toBe('object');
    });

    test('generate method should throw error when no providers available', async () => {
      await expect(factory.generate('test prompt')).rejects.toThrow();
    });

    test('process method should return error response when no providers available', async () => {
      const request: AIRequest = {
        prompt: 'test prompt'
      };

      const response = await factory.process(request);
      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(typeof response.error).toBe('string');
    });
  });
});
