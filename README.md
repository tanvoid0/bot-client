# Bot Client

A powerful, flexible TypeScript/JavaScript package for managing multiple AI providers with intelligent model selection, dynamic discovery, and enhanced response processing.

## 🚀 Features

- **Multi-Provider Support**: OpenAI, Anthropic, Google Gemini, Ollama, LM Studio
- **Dynamic Model Discovery**: Automatically discovers available models from local providers
- **Intelligent Provider Selection**: Chooses the best provider based on model availability, cost, and quality preferences
- **Zero Configuration**: Works out of the box with minimal setup
- **TypeScript Support**: Full type safety and IntelliSense
- **Enhanced Responses**: Includes processing time, confidence scores, and improvement suggestions
- **Custom Providers**: Easy to extend with your own AI providers
- **Conversation History**: Built-in support for multi-turn conversations

## Installation

```bash
npm install bot-client
```

## Quick Start

> **📋 Testing Status**: This package has been fully tested with **Ollama** and **LM Studio** (local providers). Cloud providers (OpenAI, Anthropic, Gemini) have complete API integration but are **NOT TESTED** and require API keys for validation.

### Minimal Setup

```typescript
import { aiFactory } from 'bot-client';

// Simple text generation
const response = await aiFactory.generate(
  "Write a short story about a robot learning to paint",
  {
    modelId: 'gpt-3.5-turbo',
    maxTokens: 500,
    temperature: 0.8
  }
);

console.log(response);
```

### Environment Setup

Set up your API keys for cloud providers:

```bash
# Recommended: Use BOT_CLIENT_XXX_KEY convention to avoid conflicts
export BOT_CLIENT_OPENAI_KEY="your-openai-api-key"
export BOT_CLIENT_ANTHROPIC_KEY="your-anthropic-api-key"
export BOT_CLIENT_GEMINI_KEY="your-gemini-api-key"

# Set default provider (optional)
export BOT_CLIENT_PROVIDER="ollama"  # Options: openai, anthropic, gemini, ollama, lmstudio

# Alternative: Legacy environment variable names (still supported)
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export GEMINI_API_KEY="your-gemini-api-key"
```

For local providers (Ollama, LM Studio), just ensure they're running on their default ports.

### Advanced Usage

```typescript
import { AIFactory, AIRequest } from 'bot-client';

// Create a custom factory with specific configuration
const customFactory = new AIFactory({
  defaultProvider: 'openai',
  fallbackProvider: 'ollama'
});

// Complex request with conversation history
const request: AIRequest = {
  prompt: "What should I do next?",
  modelId: 'gpt-4',
  systemPrompt: "You are a helpful coding assistant.",
  history: [
    { role: 'user', content: 'I want to build a web app' },
    { role: 'assistant', content: 'Great! What kind of web app are you thinking of building?' }
  ],
  maxTokens: 1000,
  temperature: 0.7
};

const response = await customFactory.process(request);

if (response.success) {
  console.log('Response:', response.data);
  console.log('Model used:', response.modelUsed);
  console.log('Provider:', response.providerId);
  console.log('Processing time:', response.processingTime, 'ms');
  console.log('Confidence:', response.confidence);
  console.log('Capabilities:', response.modelCapabilities);
  console.log('Suggestions:', response.suggestedImprovements);
}
```

## Configuration

### Provider Configuration

Each provider can be configured with optional parameters:

```typescript
// OpenAI Configuration
const openaiConfig = {
  apiKey: 'your-api-key',
  baseURL: 'https://api.openai.com', // Optional
  supportedModels: ['gpt-4', 'gpt-3.5-turbo'], // Optional
  timeout: 30000, // Optional
  retries: 3 // Optional
};

// Ollama Configuration
const ollamaConfig = {
  host: 'localhost', // Optional, defaults to localhost
  port: 11434, // Optional, defaults to 11434
  supportedModels: ['llama2', 'mistral'], // Optional, will auto-discover
  timeout: 30000, // Optional
  retries: 3 // Optional
};

// LM Studio Configuration
const lmstudioConfig = {
  host: 'localhost', // Optional, defaults to localhost
  port: 1234, // Optional, defaults to 1234
  supportedModels: ['local-model'], // Optional, will auto-discover
  timeout: 30000, // Optional
  retries: 3 // Optional
};
```

### Factory Configuration

```typescript
const factoryConfig = {
  defaultProvider: 'openai',
  fallbackProvider: 'ollama',
  providers: {
    // Custom providers can be added here
  }
};

const factory = new AIFactory(factoryConfig);
```

## API Reference

### AIFactory

The main class for managing AI providers and processing requests.

#### Methods

- `generate(prompt: string, options?: Partial<AIRequest>): Promise<string>` - Simple text generation
- `process(request: EnhancedAIRequest): Promise<EnhancedAIResponse>` - Process requests with enhanced metadata
- `getAvailableProviders(): string[]` - Get list of available providers
- `testProviders(): Promise<Record<string, boolean>>` - Test all provider connections
- `getAllSupportedModels(): string[]` - Get all supported models across providers
- `getProviderForModel(modelId: string): AIProvider | null` - Find provider for specific model

### Types

#### AIRequest
```typescript
interface AIRequest {
  prompt: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  history?: ConversationHistory[];
  metadata?: Record<string, any>;
}
```

#### EnhancedAIResponse
```typescript
interface EnhancedAIResponse extends AIResponse {
  processingTime?: number;
  modelCapabilities?: string[];
  suggestedImprovements?: string[];
  confidence?: number;
}
```

#### AIError
```typescript
class AIError extends Error {
  constructor(
    message: string,
    provider: string,
    statusCode?: number,
    details?: any
  );
}
```

## Error Handling

The package provides comprehensive error handling with the `AIError` class:

```typescript
import { AIError } from 'bot-client';

try {
  const response = await aiFactory.generate("Hello world");
} catch (error) {
  if (error instanceof AIError) {
    console.error(`Error from ${error.provider}:`, error.message);
    console.error('Status code:', error.statusCode);
    console.error('Details:', error.details);
  }
}
```

## Examples

See the `examples/` directory for complete usage examples:

- `basic-usage.ts` - Simple text generation and conversation
- `multiple-providers.ts` - Working with multiple providers and custom configuration

## Supported Models & Testing Status

### ✅ Tested Providers

#### Ollama (Local)
- **Status**: ✅ Fully tested and working
- **Models**: Auto-discovered (llama2, llama2:7b, llama2:13b, llama2:70b, codellama, mistral, gemma, qwen2, etc.)
- **Features**: Dynamic model discovery, conversation history, cost calculation
- **Tested Models**: llama3.1:8b, llama2:7b, codellama:7b

#### LM Studio (Local)
- **Status**: ✅ Fully tested and working
- **Models**: Auto-discovered (depends on loaded models)
- **Features**: Dynamic model discovery, conversation history
- **Tested Models**: Various local models

### ⚠️ Untested Providers (API Integration Complete)

#### OpenAI
- **Status**: ⚠️ API integration complete, **NOT TESTED** - needs API key for testing
- **Models**: gpt-4, gpt-4-turbo, gpt-4o, gpt-4o-mini, gpt-3.5-turbo
- **Features**: Full API support, cost calculation, conversation history
- **Testing**: **NOT TESTED** - requires valid API key for validation

#### Anthropic
- **Status**: ⚠️ API integration complete, **NOT TESTED** - needs API key for testing
- **Models**: claude-3-opus-20240229, claude-3-sonnet-20240229, claude-3-haiku-20240307
- **Features**: Full API support, cost calculation, conversation history
- **Testing**: **NOT TESTED** - requires valid API key for validation

#### Google Gemini
- **Status**: ⚠️ API integration complete, **NOT TESTED** - needs API key for testing
- **Models**: gemini-1.5-pro, gemini-1.5-flash, gemini-pro
- **Features**: Full API support, dynamic model discovery, conversation history
- **Testing**: **NOT TESTED** - requires valid API key for validation

### 📋 Testing Notes

- **Local Providers (Ollama, LM Studio)**: ✅ Fully tested with actual running instances
- **Cloud Providers (OpenAI, Anthropic, Gemini)**: ⚠️ API integration complete but **NOT TESTED** - requires API keys for validation
- **Dynamic Model Discovery**: ✅ Tested and working for Ollama, LM Studio, and Gemini
- **Error Handling**: ✅ Tested for missing API keys, invalid URLs, and connection issues
- **Environment Variables**: ✅ Tested with BOT_CLIENT_PROVIDER and BOT_CLIENT_XXX_KEY conventions
- **Provider Selection**: ✅ Tested with custom factories and environment variable overrides

### 🧪 How to Test Providers

```bash
# Test local providers (no API key needed)
npm run test

# Test cloud providers (requires API keys)
export BOT_CLIENT_OPENAI_KEY="your-key"
export BOT_CLIENT_ANTHROPIC_KEY="your-key" 
export BOT_CLIENT_GEMINI_KEY="your-key"
npm run test

# Test specific provider
export BOT_CLIENT_PROVIDER="ollama"
node examples/basic-usage.js
```

### ⚠️ Warning Messages

The package will display warning messages during initialization to inform you about the testing status of each provider:

- **✅ Fully Tested**: `✅ [AIFactory] Ollama provider initialized (FULLY TESTED)`
- **⚠️ Untested**: `⚠️ [AIFactory] OpenAI provider initialized (NOT TESTED - API integration complete)`

These warnings help you understand which providers have been validated and which ones may need additional testing with your specific setup.

## Development

```bash
# Install dependencies
npm install

# Build the package
npm run build

# Run tests
npm test

# Run linting
npm run lint

# Generate documentation
npm run docs

# Test package functionality (before publishing)
npm run test:package
```

## License

MIT License - see LICENSE file for details.
