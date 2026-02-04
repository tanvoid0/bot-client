import { aiFactory, ensureFactoryReady } from '../dist/index.js';

/**
 * Zero Configuration Usage Example
 * 
 * This example demonstrates how to use the AI client with zero configuration:
 * - No environment variables required
 * - Automatic provider detection
 * - Comprehensive error handling
 * - Complete data returned
 */

async function zeroConfigExample() {
  console.log('🚀 Zero Configuration AI Client Example\n');

  try {
    // 1. Wait for automatic initialization (no config needed!)
    console.log('1️⃣ Auto-initializing AI providers...');
    const factory = await ensureFactoryReady();
    
    console.log('✅ Available providers:', factory.getAvailableProviders());
    console.log('---\n');

    // 2. Simple text generation (works out of the box)
    console.log('2️⃣ Simple text generation:');
    const response1 = await aiFactory.generate('Hello! How are you?');
    console.log('Response:', response1);
    console.log('---\n');

    // 3. Get complete response data
    console.log('3️⃣ Complete response data:');
    const fullResponse = await aiFactory.process({
      prompt: 'Write a short poem about coding',
      maxTokens: 100,
      temperature: 0.8
    });
    
    console.log('Success:', fullResponse.success);
    console.log('Data:', fullResponse.data);
    console.log('Model used:', fullResponse.modelUsed);
    console.log('Provider:', fullResponse.providerId);
    console.log('Processing time:', fullResponse.processingTime, 'ms');
    console.log('Confidence:', fullResponse.confidence);
    console.log('Model capabilities:', fullResponse.modelCapabilities);
    console.log('Suggestions:', fullResponse.suggestedImprovements);
    console.log('---\n');

    // 4. Error handling demonstration
    console.log('4️⃣ Error handling:');
    try {
      await aiFactory.generate(''); // Empty prompt
    } catch (error) {
      console.log('✅ Caught error for empty prompt:', error instanceof Error ? error.message : String(error));
    }
    console.log('---\n');

    // 5. Provider status check
    console.log('5️⃣ Provider status:');
    const status = await aiFactory.testProviders();
    console.log('Provider status:', status);
    console.log('---\n');

    console.log('✅ Zero configuration example completed successfully!');
    console.log('🎉 The client works with zero setup required!');

  } catch (error) {
    console.error('❌ Error in zero config example:', error);
    console.log('\n💡 Troubleshooting tips:');
    console.log('- Install Ollama for local AI: https://ollama.ai');
    console.log('- Or set an API key: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY');
    console.log('- Or run LM Studio locally');
  }
}

// Run the example
zeroConfigExample();
