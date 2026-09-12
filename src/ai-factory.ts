import { AIProvider, AIRequest, AIResponse, AIError, AIFactoryConfig, AIStreamChunk } from './types/index.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { LMStudioProvider } from './providers/lmstudio-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';

export class AIFactory {
  private providers: Map<string, AIProvider> = new Map();
  private initializationPromise: Promise<void> | null = null;
  private readonly config: AIFactoryConfig;

  constructor(config?: AIFactoryConfig) {
    this.config = config ?? {};
  }

  /**
   * Provider discovery probes every provider over the network, and for cloud
   * providers `testConnection` costs a real request. It runs on first use, not
   * on construction, so importing or wiring this into a DI container is free.
   */
  private ensureInitialized(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;

    // A discovery run that registered nothing is usually a transient outage.
    // Forgetting it lets the next request retry instead of leaving the factory
    // permanently empty until the process restarts.
    this.initializationPromise = this.initializeProviders().then(() => {
      if (this.providers.size === 0) this.initializationPromise = null;
    });
    return this.initializationPromise;
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
    await this.ensureInitialized();

    const response = await this.process({ prompt, ...options });

    if (!response.success) {
      throw new AIError(response.error ?? 'Generation failed', 'AIFactory');
    }

    return response.data ?? '';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    await this.ensureInitialized();

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

  /**
   * The same call as [process], streamed.
   *
   * No retry and no fallback provider here, on purpose: by the time a stream
   * fails the caller has usually shown half an answer already, and silently
   * restarting on another provider would splice two different answers
   * together. A failure is thrown for the caller to handle.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    await this.ensureInitialized();

    const provider = this.resolveProvider(request);
    if (!provider) {
      throw new Error('No AI providers available');
    }
    if (!provider.processStream) {
      const result = await provider.process(request);
      if (!result.success) {
        throw new Error(result.error ?? 'AI request failed');
      }
      yield {
        text: result.data ?? '',
        done: true,
        modelUsed: result.modelUsed,
        usage: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.tokensUsed,
        },
      };
      return;
    }
    yield* provider.processStream(request);
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
    await this.ensureInitialized();
    const out: Record<string, boolean> = {};
    for (const [id, p] of this.providers) {
      out[id] = await p.testConnection();
    }
    return out;
  }

  /** Runs provider discovery if it has not run yet. */
  ready(): Promise<void> {
    return this.ensureInitialized();
  }
}

/**
 * Shared factory. Constructing it is free — provider discovery is deferred to
 * the first request — so importing this module touches no network.
 */
export const aiFactory = new AIFactory();

/** Shared factory, with provider discovery already run. */
export async function ensureFactoryReady(): Promise<AIFactory> {
  await aiFactory.ready();
  return aiFactory;
}
