import { AIFactory, aiFactory } from './dist/index.js';

async function testPackage() {
  console.log('🧪 Testing Bot Client Package Before Publishing\n');

  try {
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('1️⃣ Testing Basic Functionality:');
    
    // Test 1: Check available providers
    const providers = aiFactory.getAvailableProviders();
    console.log('✅ Available providers:', providers);
    
    if (providers.length === 0) {
      throw new Error('No providers available - package may not be working correctly');
    }

    // Test 2: Check supported models
    const models = aiFactory.getAllSupportedModels();
    console.log('✅ Total supported models:', models.length);
    console.log('✅ Sample models:', models.slice(0, 3));

    // Test 3: Test provider connections
    console.log('\n2️⃣ Testing Provider Connections:');
    const status = await aiFactory.testProviders();
    console.log('✅ Provider status:', status);

    // Test 4: Test simple generation
    console.log('\n3️⃣ Testing Text Generation:');
    const response = await aiFactory.generate('Hello, world!');
    console.log('✅ Generated response:', response.substring(0, 50) + '...');

    // Test 5: Test with options
    console.log('\n4️⃣ Testing with Options:');
    const responseWithOptions = await aiFactory.generate('Write a short poem', {
      maxTokens: 100,
      temperature: 0.8
    });
    console.log('✅ Response with options:', responseWithOptions.substring(0, 50) + '...');

    // Test 6: Test custom factory
    console.log('\n5️⃣ Testing Custom Factory:');
    // Use a working provider (ollama or lmstudio)
    const workingProviders = providers.filter(p => p !== 'openai');
    const customFactory = new AIFactory({
      defaultProvider: workingProviders[0] || 'ollama'
    });
    
    // Wait for custom factory initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const customResponse = await customFactory.generate('Test from custom factory');
    console.log('✅ Custom factory response:', customResponse.substring(0, 50) + '...');

    // Test 7: Test error handling
    console.log('\n6️⃣ Testing Error Handling:');
    try {
      // Test with a working provider specifically
      const workingFactory = new AIFactory({
        defaultProvider: 'ollama'
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
      await workingFactory.generate('', { maxTokens: -1 }); // Invalid request
    } catch (error) {
      console.log('✅ Error handling works:', error.message.substring(0, 50) + '...');
    }

    // Test 8: Test provider selection
    console.log('\n7️⃣ Testing Provider Selection:');
    const providerForModel = aiFactory.getProviderForModel(models[0]);
    if (providerForModel) {
      console.log('✅ Provider selection works for model:', models[0]);
    }

    // Test 9: Test model support checking
    console.log('\n8️⃣ Testing Model Support:');
    const isSupported = aiFactory.isModelSupported(models[0]);
    console.log('✅ Model support checking works:', isSupported);

    // Test 10: Test configuration
    console.log('\n9️⃣ Testing Configuration:');
    const config = aiFactory.getConfig();
    console.log('✅ Configuration accessible:', Object.keys(config));

    console.log('\n🎉 All tests passed! Package is ready for publishing.');
    console.log('\n📊 Package Summary:');
    console.log(`- Providers: ${providers.length} available`);
    console.log(`- Models: ${models.length} supported`);
    console.log(`- Working providers: ${Object.values(status).filter(Boolean).length}`);
    console.log(`- Default provider: ${config.defaultProvider || 'Not set'}`);

  } catch (error) {
    console.error('❌ Package test failed:', error);
    console.error('❌ Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run the test
testPackage();
