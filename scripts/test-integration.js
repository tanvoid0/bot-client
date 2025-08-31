#!/usr/bin/env node

/**
 * Integration Test Script
 * 
 * This script runs integration tests that require actual AI providers.
 * It should only be run locally when you have providers configured.
 */

import { AIFactory, aiFactory } from '../dist/index.js';

async function runIntegrationTests() {
  console.log('🧪 Running Integration Tests (requires configured providers)\n');

  try {
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('1️⃣ Testing Provider Availability:');
    const providers = aiFactory.getAvailableProviders();
    console.log('Available providers:', providers);

    if (providers.length === 0) {
      console.log('⚠️ No providers available - skipping integration tests');
      console.log('💡 To run integration tests, configure at least one provider:');
      console.log('   - Set up Ollama locally');
      console.log('   - Set up LM Studio locally');
      console.log('   - Configure API keys for cloud providers');
      return;
    }

    console.log('\n2️⃣ Testing Provider Connections:');
    const status = await aiFactory.testProviders();
    console.log('Provider status:', status);

    const workingProviders = Object.entries(status).filter(([_, isWorking]) => isWorking);
    
    if (workingProviders.length === 0) {
      console.log('⚠️ No working providers found - skipping integration tests');
      return;
    }

    console.log('\n3️⃣ Testing Text Generation:');
    const response = await aiFactory.generate('Hello, world!');
    console.log('✅ Generated response:', response.substring(0, 50) + '...');

    console.log('\n4️⃣ Testing with Options:');
    const responseWithOptions = await aiFactory.generate('Write a short poem', {
      maxTokens: 100,
      temperature: 0.8
    });
    console.log('✅ Response with options:', responseWithOptions.substring(0, 50) + '...');

    console.log('\n5️⃣ Testing Custom Factory:');
    const customFactory = new AIFactory({
      defaultProvider: workingProviders[0][0]
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const customResponse = await customFactory.generate('Test from custom factory');
    console.log('✅ Custom factory response:', customResponse.substring(0, 50) + '...');

    console.log('\n🎉 All integration tests passed!');

  } catch (error) {
    console.error('❌ Integration test failed:', error);
    process.exit(1);
  }
}

// Only run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runIntegrationTests();
}
