// Main exports - only what clients need
export { AIFactory, aiFactory, ensureFactoryReady } from './ai-factory.js';

// Providers (for custom factory or direct use)
export { OpenAICompatibleProvider, PRESETS } from './providers/openai-compatible.js';
export type { OpenAICompatibleConfig, PresetId } from './providers/openai-compatible.js';
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
export { BaseProvider, buildChatMessages, inlineImage, mergeBody, partsOf, textOf } from './providers/base-provider.js';
// `runOllamaCLI` / `isOllamaCLIAvailable` moved to '@tanvoid0/bot-client/ollama-cli' (1.8.0): they spawn a process, and this entry must run where `fetch` does.
export type { OllamaCLIResult, OllamaCLIOptions } from './ollama-cli.js';

// Wire-format helpers (for custom providers)
export { HttpError, streamLines, parseSSE, parseNDJSON } from './core/http.js';
export type { HttpOptions, SseEvent, FetchLike } from './core/http.js';
export { guessProvider } from './core/catalog.js';
export { splitThinkTags, ThinkFilter } from './core/reasoning.js';
export type { RetryOptions } from './core/retry.js';

// Types for requests, responses, and configuration
export type {
  AIProvider,
  AIRequest,
  Message,
  MessagePart,
  TextPart,
  ImagePart,
  AIResponse,
  AIStreamChunk,
  AIFactoryConfig,
  AIProviderConfig,
  BaseProviderConfig,
  DiscoveryMode,
  FinishReason,
  Hooks,
  TokenUsage,
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
export { AIError, toAIError, isRetryableCode } from './core/errors.js';
export type { AIErrorCode, AIErrorInit, Refinement, ClassifyContext } from './core/errors.js';
