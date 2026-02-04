import { AIFactory, aiFactory, ensureFactoryReady } from '../dist/index.js';

/**
 * Basic Usage Example
 * 
 * This example demonstrates the core functionality of the AI Model Manager:
 * - Simple text generation
 * - Model selection
 * - Provider management
 * - Environment variable configuration
 * - Error handling
 */

async function basicUsageExample() {
  console.log('🤖 AI Model Manager - Basic Usage Example\n');

  await ensureFactoryReady();

  try {
    // 0. Environment variable configuration
    console.log('0️⃣ Environment Variable Configuration:');
    console.log('BOT_CLIENT_PROVIDER:', process.env.BOT_CLIENT_PROVIDER || 'Not set (will use default)');
    console.log('Available providers:', aiFactory.getAvailableProviders());
    console.log('---\n');

    // 1. Simple text generation (uses best available provider)
    console.log('1️⃣ Simple Text Generation:');
    const response1 = await aiFactory.generate('Explain quantum computing in simple terms');
    console.log('Response:', response1);
    console.log('---\n');

    // 2. Generate with specific model
    console.log('2️⃣ Generate with Specific Model:');
    const response2 = await aiFactory.generate('Write a haiku about programming', {
      modelId: 'llama3.1:8b', // Use specific Ollama model
      temperature: 0.8,
      maxTokens: 100
    });
    console.log('Response:', response2);
    console.log('---\n');

    // 3. Get available providers and models
    console.log('3️⃣ Available Providers and Models:');
    const providers = aiFactory.getAvailableProviders();
    const models = aiFactory.getAllSupportedModels();
    
    console.log('Providers:', providers);
    console.log('Total Models:', models.length);
    console.log('Sample Models:', models.slice(0, 5));
    console.log('---\n');

    // 4. Test provider connections
    console.log('4️⃣ Provider Connection Status:');
    const status = await aiFactory.testProviders();
    console.log('Provider Status:', status);
    console.log('---\n');

    // 5. Advanced request with conversation history
    console.log('5️⃣ Conversation with History:');
    const response3 = await aiFactory.generate('What was my previous question?', {
      history: [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'The capital of France is Paris.' }
      ],
      systemPrompt: 'You are a helpful assistant that remembers conversation context.'
    });
    console.log('Response:', response3);
    console.log('---\n');

    // 6. Cost-sensitive request
    console.log('6️⃣ Cost-Sensitive Request:');
    const response4 = await aiFactory.generate('Summarize the benefits of exercise', {
      usageContext: {
        taskType: 'content-generation',
        priority: 'medium',
        costSensitive: true,
        qualityPreference: 'balanced'
      },
      maxTokens: 200
    });
    console.log('Response:', response4);
    console.log('---\n');

    // 7. Custom factory with specific provider
    console.log('7️⃣ Custom Factory with Specific Provider:');
    const customFactory = new AIFactory({
      defaultProvider: 'ollama'
    });
    await customFactory.ready();
    const customResponse = await customFactory.generate('Hello from custom factory!');
    console.log('Custom Factory Response:', customResponse);
    console.log('---\n');

    console.log('✅ Basic usage example completed successfully!');

  } catch (error) {
    console.error('❌ Error in basic usage example:', error);
  }
}

// Run the example
basicUsageExample();
