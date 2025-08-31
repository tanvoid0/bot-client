// Main exports - only what clients need
export { AIFactory, aiFactory } from './ai-factory.js';

// Types for requests, responses, and configuration
export type {
  AIRequest,
  AIResponse,
  AIFactoryConfig,
  AIProviderConfig,
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
