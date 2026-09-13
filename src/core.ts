// Everything except the built-in providers: the factory, errors, types and
// the helpers a custom provider needs. Pair with one provider subpath for the
// smallest bundle; `.` adds the five built-ins and the zero-config `aiFactory`.
export { AIFactory } from './ai-factory.js';

export { BaseProvider, buildChatMessages, inlineImage, mergeBody, partsOf, textOf } from './providers/base-provider.js';
// `runOllamaCLI` / `isOllamaCLIAvailable` moved to '@tanvoid0/bot-client/ollama-cli' (1.8.0): they spawn a process, and this entry must run where `fetch` does.
export type { OllamaCLIResult, OllamaCLIOptions } from './ollama-cli.js';

// Wire-format helpers (for custom providers)
export { HttpError, streamLines, parseSSE, parseNDJSON } from './core/http.js';
export type { HttpOptions, SseEvent, FetchLike } from './core/http.js';
export { guessProvider } from './core/catalog.js';
export { splitThinkTags, ThinkFilter } from './core/reasoning.js';
export { openaiTools, parseArgs, recoverLeakedToolCalls, runTools, nextStepRequest } from './core/tools.js';
export { jsonSchemaOf, parseJson, isStandardSchema } from './core/schema.js';
export type { RetryOptions } from './core/retry.js';

// Types for requests, responses, and configuration
export type {
  AIProvider,
  AIRequest,
  Message,
  MessagePart,
  TextPart,
  ImagePart,
  Tool,
  ToolCall,
  ToolResult,
  Step,
  StandardSchemaV1,
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
