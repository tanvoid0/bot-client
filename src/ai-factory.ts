import {
  AIProvider,
  AIRequest,
  AIResponse,
  AIFactoryConfig,
  AIProviderConfig,
  AIError
} from './types/index.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { LMStudioProvider } from './providers/lmstudio-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';

export class AIFactory {
  private config!: AIFactoryConfig;
  private providers: Map<string, AIProvider>;
  private defaultProvider: string;
  private fallbackProvider?: string;

  constructor(config?: Partial<AIFactoryConfig>) {
    this.providers = new Map();
    
    // Get default provider from config, environment variable, or fallback to 'openai'
    const envDefaultProvider = process.env.BOT_CLIENT_PROVIDER;
    this.defaultProvider = config?.defaultProvider || envDefaultProvider || 'openai';
    this.fallbackProvider = config?.fallbackProvider;
    
    // Initialize providers asynchronously
    this.initializeProviders(config?.providers).then(() => {
      this.config = {
        defaultProvider: this.defaultProvider,
        providers: Object.fromEntries(this.providers),
        ...(this.fallbackProvider && { fallbackProvider: this.fallbackProvider })
      };
    }).catch(error => {
      console.error('❌ [AIFactory] Failed to initialize providers:', error);
    });
  }

  /**
   * Initialize all available AI providers
   */
  private async initializeProviders(customProviders?: Record<string, AIProvider>): Promise<void> {
    // Add custom providers if provided
    if (customProviders) {
      Object.entries(customProviders).forEach(([id, provider]) => {
        this.providers.set(id, provider);
      });
    }

    // Add OpenAI provider (if API key is available)
    if (process.env.BOT_CLIENT_OPENAI_KEY || process.env.OPENAI_API_KEY) {
      const openaiConfig: AIProviderConfig = {
        defaultModel: 'gpt-3.5-turbo',
        defaultTemperature: 0.7,
        defaultMaxTokens: 1000,
        supportedModels: ['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo']
      };
      
      const openaiProvider = new OpenAIProvider(openaiConfig, {
        apiKey: process.env.BOT_CLIENT_OPENAI_KEY || process.env.OPENAI_API_KEY
      });
      this.providers.set(openaiProvider.providerId, openaiProvider);
      console.log('⚠️ [AIFactory] OpenAI provider initialized (NOT TESTED - API integration complete)');
      if (!this.fallbackProvider) {
        this.fallbackProvider = 'openai';
      }
    }

    // Add Anthropic provider (if API key is available)
    if (process.env.BOT_CLIENT_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY) {
      const anthropicConfig: AIProviderConfig = {
        defaultModel: 'claude-3-sonnet-20240229',
        defaultTemperature: 0.7,
        defaultMaxTokens: 1000,
        supportedModels: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307']
      };
      
      const anthropicProvider = new AnthropicProvider(anthropicConfig, {
        apiKey: process.env.BOT_CLIENT_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY
      });
      this.providers.set(anthropicProvider.providerId, anthropicProvider);
      console.log('⚠️ [AIFactory] Anthropic provider initialized (NOT TESTED - API integration complete)');
      if (!this.fallbackProvider) {
        this.fallbackProvider = 'anthropic';
      }
    }

    // Add Gemini provider (if API key is available)
    if (process.env.BOT_CLIENT_GEMINI_KEY || process.env.GEMINI_API_KEY) {
      const geminiConfig: AIProviderConfig = {
        defaultModel: 'gemini-1.5-pro',
        defaultTemperature: 0.7,
        defaultMaxTokens: 1000,
        supportedModels: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro']
      };
      
      const geminiProvider = new GeminiProvider(geminiConfig, {
        apiKey: process.env.BOT_CLIENT_GEMINI_KEY || process.env.GEMINI_API_KEY
      });
      this.providers.set(geminiProvider.providerId, geminiProvider);
      console.log('✅ [AIFactory] Google Gemini provider initialized (FULLY TESTED)');
      if (!this.fallbackProvider) {
        this.fallbackProvider = 'gemini';
      }
    }

    // Add Ollama provider (if available)
    try {
      const ollamaConfig: AIProviderConfig = {
        defaultModel: '', // Let Ollama discover models dynamically
        defaultTemperature: 0.7,
        defaultMaxTokens: 1000,
        supportedModels: [] // Will be populated by dynamic discovery
      };
      
      const ollamaProvider = new OllamaProvider(ollamaConfig, {
        host: 'localhost',
        port: 11434
      });
      const isOllamaAvailable = await ollamaProvider.testConnection();
      if (isOllamaAvailable) {
        this.providers.set(ollamaProvider.providerId, ollamaProvider);
        console.log('✅ [AIFactory] Ollama provider initialized (FULLY TESTED)');
        if (!this.fallbackProvider) {
          this.fallbackProvider = 'ollama';
        }
      }
    } catch (error) {
      // Ollama not available
    }

    // Add LM Studio provider (if available)
    try {
      const lmstudioConfig: AIProviderConfig = {
        defaultModel: '', // Let LM Studio discover models dynamically
        defaultTemperature: 0.7,
        defaultMaxTokens: 1000,
        supportedModels: [] // Will be populated by dynamic discovery
      };
      
      const lmstudioProvider = new LMStudioProvider(lmstudioConfig, {
        host: 'localhost',
        port: 1234
      });
      const isLMStudioAvailable = await lmstudioProvider.testConnection();
      if (isLMStudioAvailable) {
        this.providers.set(lmstudioProvider.providerId, lmstudioProvider);
        console.log('✅ [AIFactory] LM Studio provider initialized (FULLY TESTED)');
        if (!this.fallbackProvider) {
          this.fallbackProvider = 'lmstudio';
        }
      }
    } catch (error) {
      // LM Studio not available
    }


  }

  /**
   * Simple method to generate text
   */
  async generate(prompt: string, options?: Partial<AIRequest>): Promise<string> {
    const request: AIRequest = {
      prompt,
      modelId: options?.modelId, // Let providers choose default if not specified
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.maxTokens !== undefined && { maxTokens: options.maxTokens }),
      ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
      ...(options?.history && { history: options.history }),
      ...(options?.metadata && { metadata: options.metadata }),
      ...(options?.usageContext && { usageContext: options.usageContext })
    };

    const response = await this.process(request);
    
    if (!response.success) {
      throw new AIError(response.error || 'Generation failed', 'AIFactory');
    }

    return response.data || '';
  }

  /**
   * Process a request with intelligent provider selection
   */
  async process(request: AIRequest): Promise<AIResponse> {
    const startTime = Date.now();
    
    try {
      // Determine the best provider for this request
      const selectedProvider = this.selectProvider(request);
      
      if (!selectedProvider) {
        return {
          success: false,
          error: 'No suitable AI provider available',
          modelUsed: request.modelId || 'unknown',
          providerId: 'none',
          processingTime: Date.now() - startTime
        };
      }



      // Process the request
      const response = await selectedProvider.process(request);
      
      const processingTime = Date.now() - startTime;

      // Enhance the response with additional metadata
      const enhancedResponse: AIResponse = {
        ...response,
        processingTime,
        modelCapabilities: this.getModelCapabilities(request.modelId || 'unknown'),
        suggestedImprovements: this.generateSuggestions(request, response),
        confidence: this.calculateConfidence(response, processingTime)
      };

      return enhancedResponse;

    } catch (error) {
      console.error('❌ [AIFactory] Processing error:', error);
      
      return {
        success: false,
        error: `AI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        modelUsed: request.modelId || 'unknown',
        providerId: 'none',
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Add a custom provider
   */
  addProvider(provider: AIProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  /**
   * Get available providers
   */
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get provider by ID
   */
  getProvider(providerId: string): AIProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get all supported models across all providers
   */
  getAllSupportedModels(): string[] {
    const allModels = new Set<string>();
    
    for (const provider of this.providers.values()) {
      provider.supportedModels.forEach(model => allModels.add(model));
    }
    
    return Array.from(allModels);
  }

  /**
   * Check if a model is supported by any provider
   */
  isModelSupported(modelId: string): boolean {
    return Array.from(this.providers.values()).some(provider => provider.isModelSupported(modelId));
  }

  /**
   * Get the best provider for a specific model
   */
  getProviderForModel(modelId: string): AIProvider | null {
    for (const provider of this.providers.values()) {
      if (provider.isModelSupported(modelId)) {
        return provider;
      }
    }
    return null;
  }

  /**
   * Test all providers to ensure they're working
   */
  async testProviders(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    
    for (const [name, provider] of this.providers) {
      try {
        const isAvailable = await provider.testConnection();
        results[name] = isAvailable;
      } catch (error) {
        results[name] = false;
      }
    }
    
    return results;
  }

  /**
   * Select the best provider for a given request
   */
  private selectProvider(request: AIRequest): AIProvider | null {
    const { usageContext } = request;

    // If specific provider is requested in metadata, try to use it
    if (request.metadata?.preferredProvider) {
      const preferredProvider = this.providers.get(request.metadata.preferredProvider);
      if (preferredProvider && preferredProvider.isModelSupported(request.modelId || '')) {
        return preferredProvider;
      }
    }

    // Try to find a provider that supports the requested model
    for (const [providerId, provider] of this.providers) {
      if (provider.isModelSupported(request.modelId || '')) {
        // If cost-sensitive, prefer free providers first, then cheaper ones
        if (usageContext?.costSensitive) {
          if (providerId === 'ollama') {
            return provider; // Ollama is free (local)
          }
          if (providerId === 'lmstudio') {
            return provider; // LM Studio is local
          }
        }
        
        // If quality is preferred, prefer more capable providers
        if (usageContext?.qualityPreference === 'quality') {
          if (providerId === 'openai') {
            return provider; // OpenAI models are generally more capable
          }
        }
        
        // If speed is preferred, prefer local providers
        if (usageContext?.qualityPreference === 'speed') {
          if (providerId === 'ollama') {
            return provider; // Ollama is local and fast
          }
        }
        
        return provider;
      }
    }

    // Fallback to default provider with a supported model
    const defaultProvider = this.providers.get(this.defaultProvider);
    if (defaultProvider) {
      return defaultProvider;
    }

    // Last resort: any available provider
    return this.providers.values().next().value || null;
  }

  /**
   * Get model capabilities based on model ID
   */
  private getModelCapabilities(modelId: string): string[] {
    const capabilities: string[] = [];
    
    if (modelId.includes('gpt-4')) {
      capabilities.push('Advanced reasoning', 'High quality', 'Complex tasks');
    } else if (modelId.includes('gpt-3.5')) {
      capabilities.push('Balanced performance', 'Good value', 'Versatile');
    } else if (modelId.includes('llama2:70b')) {
      capabilities.push('Maximum reasoning', 'Premium quality', 'Complex analysis');
    } else if (modelId.includes('llama2:13b')) {
      capabilities.push('High performance', 'Advanced reasoning', 'Professional tasks');
    } else if (modelId.includes('llama2:7b')) {
      capabilities.push('Balanced performance', 'Good value', 'Versatile');
    } else if (modelId.includes('codellama')) {
      capabilities.push('Code generation', 'Programming assistance', 'Technical tasks');
    } else if (modelId.includes('mistral')) {
      capabilities.push('Fast processing', 'Good reasoning', 'General tasks');
    }
    
    return capabilities;
  }

  /**
   * Generate suggestions for improving the request
   */
  private generateSuggestions(request: AIRequest, response: AIResponse): string[] {
    const suggestions: string[] = [];
    
    if (response.success && response.data) {
      const wordCount = response.data.split(' ').length;
      
      if (wordCount < 50) {
        suggestions.push('Consider increasing maxTokens for more detailed responses');
      }
      
      if (request.temperature && request.temperature < 0.3) {
        suggestions.push('Lower temperature may result in more focused but less creative responses');
      }
    }
    
    if (request.usageContext?.costSensitive && response.cost && response.cost > 0.01) {
      suggestions.push('Consider using a smaller model to reduce costs');
    }
    
    return suggestions;
  }

  /**
   * Calculate confidence score based on response quality
   */
  private calculateConfidence(response: AIResponse, processingTime: number): number {
    if (!response.success) return 0;
    
    let confidence = 0.7; // Base confidence
    
    // Higher confidence for faster responses (within reasonable limits)
    if (processingTime < 2000) confidence += 0.1;
    if (processingTime < 1000) confidence += 0.1;
    
    // Higher confidence for responses with more content
    if (response.data && response.data.length > 100) confidence += 0.1;
    
    // Lower confidence for expensive responses (might indicate issues)
    if (response.cost && response.cost > 0.05) confidence -= 0.1;
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Get factory configuration
   */
  getConfig(): AIFactoryConfig {
    return this.config;
  }
}

// Export singleton instance
export const aiFactory = new AIFactory();
