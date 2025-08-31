import { AIFactory, aiFactory, AIRequest, AIResponse, AIProviderConfig } from '../dist/index.js';

/**
 * Advanced Usage Example
 * 
 * This example demonstrates advanced features:
 * - Custom provider implementation
 * - Error handling and retry logic
 * - Batch processing
 * - Provider selection strategies
 * - Custom configurations
 */

// Custom provider example
class CustomProvider {
  providerId = 'custom';
  providerName = 'Custom Provider';
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  get supportedModels(): string[] {
    return this.config.supportedModels;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Simple echo response for demonstration
    const response = `[Custom Provider] Processed: ${request.prompt}`;
    
    return {
      success: true,
      data: response,
      modelUsed: request.modelId || 'custom-model',
      providerId: this.providerId,
      tokensUsed: request.prompt.length,
      processingTime: 100
    };
  }

  async testConnection(): Promise<boolean> {
    return true; // Always available for demo
  }

  isModelSupported(modelId: string): boolean {
    return this.supportedModels.includes(modelId);
  }

  getDefaultConfig(): AIProviderConfig {
    return this.config;
  }
}

async function advancedUsageExample() {
  console.log('🚀 AI Model Manager - Advanced Usage Example\n');

  // Wait for AIFactory to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // 1. Create custom AIFactory with custom provider
    console.log('1️⃣ Custom AIFactory with Custom Provider:');
    const customProvider = new CustomProvider({
      defaultModel: 'custom-model',
      defaultTemperature: 0.7,
      defaultMaxTokens: 1000,
      supportedModels: ['custom-model', 'demo-model']
    });

    const customFactory = new AIFactory({
      defaultProvider: 'custom',
      providers: {
        custom: customProvider
      }
    });

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 500));

    const customResponse = await customFactory.generate('Hello from custom provider!');
    console.log('Custom Provider Response:', customResponse);
    console.log('---\n');

    // 2. Batch processing with error handling
    console.log('2️⃣ Batch Processing with Error Handling:');
    const prompts = [
      'Explain machine learning',
      'Write a poem about coding',
      'Invalid prompt that might fail',
      'Summarize the benefits of exercise'
    ];

    const batchResults = await Promise.allSettled(
      prompts.map(prompt => aiFactory.generate(prompt, { maxTokens: 100 }))
    );

    console.log('Batch Results:');
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`✅ Prompt ${index + 1}: Success`);
      } else {
        console.log(`❌ Prompt ${index + 1}: ${result.reason.message}`);
      }
    });
    console.log('---\n');

    // 3. Provider selection strategies
    console.log('3️⃣ Provider Selection Strategies:');
    
    // Quality-focused request
    const qualityResponse = await aiFactory.generate('Analyze this complex problem', {
      usageContext: {
        taskType: 'analysis',
        priority: 'high',
        qualityPreference: 'quality'
      }
    });
    console.log('Quality-focused response length:', qualityResponse.length);

    // Speed-focused request
    const speedResponse = await aiFactory.generate('Quick answer needed', {
      usageContext: {
        taskType: 'content-generation',
        priority: 'high',
        qualityPreference: 'speed'
      },
      maxTokens: 50
    });
    console.log('Speed-focused response length:', speedResponse.length);
    console.log('---\n');

    // 4. Advanced request with full metadata
    console.log('4️⃣ Advanced Request with Full Metadata:');
    const advancedRequest: AIRequest = {
      prompt: 'Create a comprehensive guide to TypeScript',
      modelId: 'llama3.1:8b',
      systemPrompt: 'You are an expert TypeScript developer and educator.',
      temperature: 0.3,
      maxTokens: 500,
      history: [
        { role: 'user', content: 'I want to learn TypeScript' },
        { role: 'assistant', content: 'Great choice! TypeScript is a powerful superset of JavaScript.' }
      ],
      metadata: {
        preferredProvider: 'ollama',
        requestId: 'ts-guide-001',
        category: 'education'
      },
      usageContext: {
        taskType: 'content-generation',
        priority: 'high',
        costSensitive: false,
        qualityPreference: 'quality'
      }
    };

    const advancedResponse = await aiFactory.process(advancedRequest);
    
    if (advancedResponse.success) {
      console.log('✅ Advanced request successful!');
      console.log('Model used:', advancedResponse.modelUsed);
      console.log('Provider:', advancedResponse.providerId);
      console.log('Processing time:', advancedResponse.processingTime, 'ms');
      console.log('Confidence:', advancedResponse.confidence);
      console.log('Capabilities:', advancedResponse.modelCapabilities);
      console.log('Suggestions:', advancedResponse.suggestedImprovements);
    } else {
      console.log('❌ Advanced request failed:', advancedResponse.error);
    }
    console.log('---\n');

    // 5. Provider management
    console.log('5️⃣ Provider Management:');
    const providers = aiFactory.getAvailableProviders();
    console.log('Available providers:', providers);
    
    for (const providerId of providers) {
      const provider = aiFactory.getProvider(providerId);
      if (provider) {
        console.log(`${providerId}: ${provider.supportedModels.length} models available`);
      }
    }
    console.log('---\n');

    // 6. Model capabilities and suggestions
    console.log('6️⃣ Model Capabilities and Suggestions:');
    const testResponse = await aiFactory.generate('Write a short story', {
      maxTokens: 50,
      temperature: 0.1
    });
    
    // Get the full response object to see metadata
    const fullResponse = await aiFactory.process({
      prompt: 'Write a short story',
      maxTokens: 50,
      temperature: 0.1
    });
    
    if (fullResponse.success) {
      console.log('Model capabilities:', fullResponse.modelCapabilities);
      console.log('Suggestions for improvement:', fullResponse.suggestedImprovements);
    }
    console.log('---\n');

    console.log('✅ Advanced usage example completed successfully!');

  } catch (error) {
    console.error('❌ Error in advanced usage example:', error);
  }
}

// Run the example
advancedUsageExample();
