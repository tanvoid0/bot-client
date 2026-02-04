import { AIFactory, AIRequest } from '../dist/index.js';

async function multipleProvidersExample() {
  try {
    const customFactory = new AIFactory({
      defaultProvider: 'openai',
      fallbackProvider: 'ollama'
    });
    await customFactory.ready();

    const availableProviders = customFactory.getAvailableProviders();
    console.log('Available providers:', availableProviders);

    // Test provider connections
    const providerStatus = await customFactory.testProviders();
    console.log('Provider status:', providerStatus);

    // Generate content using different providers
    const prompts = [
      "Explain quantum computing in simple terms",
      "Write a haiku about programming",
      "What are the benefits of TypeScript?"
    ];

    for (const prompt of prompts) {
      console.log(`\n--- Processing: "${prompt}" ---`);
      
      const request: AIRequest = {
        prompt,
        modelId: 'gpt-3.5-turbo',
        maxTokens: 300,
        temperature: 0.7
      };

      const response = await customFactory.process(request);
      
      if (response.success) {
        console.log(`✅ Success using ${response.providerId} (${response.modelUsed})`);
        console.log(`⏱️  Processing time: ${response.processingTime}ms`);
        console.log(`🎯 Confidence: ${response.confidence}`);
        console.log(`📝 Response: ${response.data?.substring(0, 200)}...`);
        
        if (response.modelCapabilities?.length) {
          console.log(`🔧 Capabilities: ${response.modelCapabilities.join(', ')}`);
        }
        
        if (response.suggestedImprovements?.length) {
          console.log(`💡 Suggestions: ${response.suggestedImprovements.join(', ')}`);
        }
      } else {
        console.log(`❌ Failed: ${response.error}`);
      }
    }

    // Get all supported models across providers
    const allModels = customFactory.getAllSupportedModels();
    console.log('\n📋 All supported models:', allModels);

    // Find provider for a specific model
    const modelToFind = 'gpt-4';
    const providerForModel = customFactory.getProviderForModel(modelToFind);
    if (providerForModel) {
      console.log(`\n🔍 Provider for ${modelToFind}: ${providerForModel.providerName}`);
    } else {
      console.log(`\n❌ No provider found for ${modelToFind}`);
    }

  } catch (error) {
    console.error('Multiple providers example failed:', error);
  }
}

// Run the example
multipleProvidersExample();
