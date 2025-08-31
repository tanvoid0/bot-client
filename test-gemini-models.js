#!/usr/bin/env node

/**
 * Test script to check available Gemini models
 */

import { AIFactory } from '@tanvoid0/bot-client';
import readline from 'readline';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function testGeminiModels() {
  console.log('🔍 Testing Gemini Models with @tanvoid0/bot-client\n');

  try {
    // Check if API key is already in environment
    let apiKey = process.env.BOT_CLIENT_GEMINI_KEY;
    
    if (!apiKey) {
      console.log('⚠️ BOT_CLIENT_GEMINI_KEY not found in environment');
      console.log('💡 You can either:');
      console.log('   1. Set BOT_CLIENT_GEMINI_KEY in your .env file');
      console.log('   2. Enter your API key below');
      console.log('   3. Press Enter to skip Gemini testing\n');
      
      // Get API key from user if not in environment
      apiKey = await question('Enter your Gemini API key (or press Enter to skip): ');
      
      if (!apiKey.trim()) {
        console.log('⏭️ Skipping Gemini test - no API key provided');
        console.log('✅ Other providers (Ollama, LM Studio) will still be tested if available');
        rl.close();
        process.exit(0);
      }

      // Set the API key in environment
      process.env.BOT_CLIENT_GEMINI_KEY = apiKey.trim();
      console.log('✅ API key set for this session');
    } else {
      console.log('✅ Found BOT_CLIENT_GEMINI_KEY in environment');
    }

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
      console.log('\n3️⃣ Getting Gemini provider to check models:');
      const geminiProvider = factory.getProvider('gemini');
      console.log('Gemini provider:', geminiProvider ? 'Found' : 'Not found');
      
      if (geminiProvider) {
        console.log('\n4️⃣ Testing model discovery:');
        try {
          const models = await geminiProvider.fetchAvailableModels();
          console.log('✅ Available models:', models);
          
          if (models.length > 0) {
            console.log('\n5️⃣ Testing with first available model:', models[0]);
            const response = await factory.generate('Hello, this is a test!', {
              modelId: models[0],
              maxTokens: 50
            });
            console.log('✅ Response:', response.substring(0, 100) + '...');
          }
        } catch (error) {
          console.log('❌ Model discovery failed:', error.message);
          console.log('💡 Trying with default models...');
          
          // Try with default models
          const defaultModels = ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'];
          for (const model of defaultModels) {
            try {
              console.log(`\n6️⃣ Testing with ${model}:`);
              const response = await factory.generate('Hello!', {
                modelId: model,
                maxTokens: 30
              });
              console.log(`✅ ${model} works! Response:`, response.substring(0, 50) + '...');
              break;
            } catch (error) {
              console.log(`❌ ${model} failed:`, error.message);
            }
          }
        }
      }
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
testGeminiModels();
