// Main exports - only what clients need
export { AIFactory, aiFactory, ensureFactoryReady } from './ai-factory.js';

// Providers (for custom factory or direct use)
export { OpenAIProvider } from './providers/openai-provider.js';
export type { OpenAIProviderConfig } from './providers/openai-provider.js';
export { AnthropicProvider } from './providers/anthropic-provider.js';
export type { AnthropicProviderConfig } from './providers/anthropic-provider.js';
export { GeminiProvider } from './providers/gemini-provider.js';
export type { GeminiProviderConfig } from './providers/gemini-provider.js';
export { LMStudioProvider } from './providers/lmstudio-provider.js';
export type { LMStudioProviderConfig } from './providers/lmstudio-provider.js';
export { OllamaProvider } from './providers/ollama-provider.js';
export type { OllamaProviderConfig } from './providers/ollama-provider.js';
export {
  runOllamaCLI,
  isOllamaCLIAvailable
} from './ollama-cli.js';
export type { OllamaCLIResult, OllamaCLIOptions } from './ollama-cli.js';

// Types for requests, responses, and configuration
export type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIFactoryConfig,
  AIProviderConfig,
  Logger,
  ConversationHistory,
  ContentGenerationRequest,
  AnalysisRequest,
  CodeGenerationRequest,
  ConversationRequest,
  PostProcessingOptions,
  ModelCapabilities,
  ProcessingMetrics,
  ProviderType,
  ProviderConfig
} from './types/index.js';

// Error handling
export { AIError } from './types/index.js';
export type { AIErrorCode } from './types/index.js';
