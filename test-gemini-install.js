#!/usr/bin/env node

/**
 * Test script for the installed bot-client package
 * Tests Gemini integration
 */

import { AIFactory } from '@tanvoid0/bot-client';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function testGemini() {
  console.log('🧪 Testing Gemini Integration with @tanvoid0/bot-client\n');

  try {
    // Get API key from user
    const apiKey = await question('Enter your Gemini API key (or press Enter to skip): ');
    
    if (!apiKey.trim()) {
      console.log('⏭️ Skipping Gemini test - no API key provided');
      rl.close();
      process.exit(0);
    }

    // Set the API key
    process.env.BOT_CLIENT_GEMINI_KEY = apiKey.trim();

    // Create a factory instance
    const factory = new AIFactory({
      defaultProvider: 'gemini'
    });

    console.log('\n1️⃣ Testing Provider Availability:');
    const providers = factory.getAvailableProviders();
    console.log('Available providers:', providers);

    console.log('\n2️⃣ Testing Provider Connections:');
    const status = await factory.testProviders();
    console.log('Provider status:', status);

    if (status.gemini) {
      console.log('\n3️⃣ Testing with gemma-3n-e2b-it model:');
      const response = await factory.generate('Hello, this is a test from Gemma!', {
        modelId: 'gemma-3n-e2b-it',
        maxTokens: 100
      });
      console.log('✅ Gemma response:', response.substring(0, 200) + '...');

      console.log('\n4️⃣ Testing with AIRequest using gemma-3n-e2b-it:');
      const request = {
        prompt: 'Write a short poem about AI',
        provider: 'gemini',
        modelId: 'gemma-3n-e2b-it',
        maxTokens: 150
      };

      const aiResponse = await factory.process(request);
      console.log('✅ AIRequest response success:', aiResponse.success);
      if (aiResponse.success) {
        console.log('✅ Response data:', aiResponse.data?.substring(0, 200) + '...');
        console.log('✅ Model used:', aiResponse.modelUsed);
        console.log('✅ Provider:', aiResponse.providerId);
      }

      console.log('\n5️⃣ Testing default Gemini model (gemini-1.5-pro):');
      const response2 = await factory.generate('Explain quantum computing in simple terms', {
        modelId: 'gemini-1.5-pro',
        maxTokens: 100
      });
      console.log('✅ Gemini 1.5 Pro response:', response2.substring(0, 200) + '...');

    } else {
      console.log('\n❌ Gemini is not working. Status:', status.gemini);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.details) {
      console.error('Error details:', error.details);
    }
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Run the test
testGemini();
