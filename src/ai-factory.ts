import { AIProvider, AIRequest, AIResponse, AIError, AIFactoryConfig } from './types/index.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { LMStudioProvider } from './providers/lmstudio-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';

export class AIFactory {
  private providers: Map<string, AIProvider> = new Map();
  private initializationPromise: Promise<void>;
  private readonly config: AIFactoryConfig;

  constructor(config?: AIFactoryConfig) {
    this.config = config ?? {};
    this.initializationPromise = this.initializeProviders();
  }

  private log(level: keyof NonNullable<AIFactoryConfig['logger']>, message: string, ...args: unknown[]): void {
    this.config.logger?.[level]?.(message, ...args);
  }

  private async initializeProviders(): Promise<void> {
    const list = this.config.providers !== undefined
      ? this.config.providers
      : [
          new OpenAIProvider(),
          new AnthropicProvider(),
          new GeminiProvider(),
          new OllamaProvider(),
          new LMStudioProvider()
        ];

    this.log('info', 'Initializing AI providers...');

    for (const provider of list) {
      try {
        this.log('info', `Testing ${provider.providerName}...`);
        await provider.discoverModels();

        if (await provider.testConnection()) {
          this.providers.set(provider.providerId, provider);
          this.log('info', `${provider.providerName} initialized successfully with ${provider.supportedModels.length} models`);
        } else {
          this.log('warn', `${provider.providerName} connection test failed`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log('warn', `${provider.providerName} initialization failed: ${msg}`);
      }
    }

    this.log('info', `Total providers available: ${this.providers.size}`);
  }

  /** Resolve which provider to use for this request (modelId, defaultProvider, providerOrder, or first). */
  private resolveProvider(request: AIRequest): AIProvider | null {
    if (request.modelId) {
      const byModel = this.getProviderForModel(request.modelId);
      if (byModel) return byModel;
    }
    if (this.config.defaultProvider && this.providers.has(this.config.defaultProvider)) {
      return this.providers.get(this.config.defaultProvider)!;
    }
    if (this.config.providerOrder?.length) {
      for (const id of this.config.providerOrder) {
        if (this.providers.has(id)) return this.providers.get(id)!;
      }
    }
    return this.providers.values().next().value ?? null;
  }

  async generate(prompt: string, options?: Partial<AIRequest>): Promise<string> {
    await this.initializationPromise;

    const response = await this.process({ prompt, ...options });

    if (!response.success) {
      throw new AIError(response.error ?? 'Generation failed', 'AIFactory');
    }

    return response.data ?? '';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    await this.initializationPromise;

    let provider = this.resolveProvider(request);
    if (!provider) {
      return {
        success: false,
        error: 'No AI providers available',
        providerId: 'none'
      };
    }

    const maxRetries = this.config.retries ?? 0;
    let result = await provider.process(request);
    let attempts = 0;
    while (!result.success && attempts < maxRetries) {
      attempts++;
      result = await provider.process(request);
    }
    if (!result.success && this.config.fallbackProvider && this.config.fallbackProvider !== provider.providerId) {
      const fallback = this.providers.get(this.config.fallbackProvider);
      if (fallback) {
        result = await fallback.process(request);
      }
    }
    return result;
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getProvider(providerId: string): AIProvider | null {
    return this.providers.get(providerId) ?? null;
  }

  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /** First provider that supports the given model, or null. */
  getProviderForModel(modelId: string): AIProvider | null {
    for (const p of this.providers.values()) {
      if (p.isModelSupported(modelId)) return p;
    }
    return null;
  }

  /** All model IDs supported by any registered provider. */
  getAllSupportedModels(): string[] {
    const set = new Set<string>();
    for (const p of this.providers.values()) {
      for (const m of p.supportedModels) set.add(m);
    }
    return Array.from(set);
  }

  /** Test each registered provider; returns map of providerId -> ok. */
  async testProviders(): Promise<Record<string, boolean>> {
    await this.initializationPromise;
    const out: Record<string, boolean> = {};
    for (const [id, p] of this.providers) {
      out[id] = await p.testConnection();
    }
    return out;
  }

  /** Promise that resolves when initialization is complete. */
  ready(): Promise<void> {
    return this.initializationPromise;
  }
}

// Export singleton instance with proper initialization
export const aiFactory = new AIFactory();

// Helper function to ensure factory is ready
export async function ensureFactoryReady(): Promise<AIFactory> {
  await aiFactory.ready();
  return aiFactory;
}
