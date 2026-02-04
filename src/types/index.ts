// Core AI Provider Interface
export interface AIProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly supportedModels: string[];
  
  process(request: AIRequest): Promise<AIResponse>;
  isModelSupported(modelId: string): boolean;
  testConnection(): Promise<boolean>;
  discoverModels(): Promise<string[]>;
}

// Base AI Request Interface
export interface AIRequest {
  prompt: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  history?: ConversationHistory[];
  metadata?: Record<string, any>;
  usageContext?: {
    taskType: 'content-generation' | 'analysis' | 'conversation' | 'code-generation' | 'custom';
    priority: 'low' | 'medium' | 'high';
    costSensitive?: boolean;
    qualityPreference?: 'speed' | 'balanced' | 'quality';
  };
}

// AI Response Interface
export interface AIResponse {
  success: boolean;
  data?: string;
  error?: string;
  modelUsed?: string;
  providerId?: string;
  tokensUsed?: number;
  cost?: number;
  processingTime?: number;
  modelCapabilities?: string[];
  suggestedImprovements?: string[];
  confidence?: number;
  // Additional metadata for complete data
  requestId?: string;
  timestamp?: Date;
  retryCount?: number;
  fallbackUsed?: boolean;
}

// Conversation History
export interface ConversationHistory {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}

// AI Provider Configuration
export interface AIProviderConfig {
  defaultModel?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  supportedModels?: string[];
}

// Optional logger for factory and providers (all methods optional)
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

// AI Factory Configuration (constructor options)
export interface AIFactoryConfig {
  /** Preferred provider when no modelId is specified */
  defaultProvider?: string;
  /** Fallback provider if default fails */
  fallbackProvider?: string;
  /** Order of providers to try when no default/model match (first available wins) */
  providerOrder?: string[];
  /** Optional logger; if not set, no logging */
  logger?: Logger;
  /** Custom provider instances; if set, only these are used (no built-in list) */
  providers?: AIProvider[];
  /** Max retries per request on failure (default 0). */
  retries?: number;
}

// Provider Types
export type ProviderType = 'openai' | 'anthropic' | 'ollama' | 'lmstudio' | 'gemini' | 'custom';

// Provider Configuration
export interface ProviderConfig {
  type: ProviderType;
  config: {
    name: string;
    apiKey?: string;
    host?: string;
    port?: number;
    baseURL?: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
    customHeaders?: Record<string, string>;
  };
}

// Predefined Task Types
export interface ContentGenerationRequest extends AIRequest {
  taskType: 'content-generation';
  contentType: 'article' | 'blog' | 'email' | 'social-media' | 'documentation';
  tone?: 'professional' | 'casual' | 'formal' | 'creative';
  targetAudience?: string;
}

export interface AnalysisRequest extends AIRequest {
  taskType: 'analysis';
  analysisType: 'sentiment' | 'summary' | 'classification' | 'extraction';
  outputFormat?: 'text' | 'json' | 'structured';
}

export interface CodeGenerationRequest extends AIRequest {
  taskType: 'code-generation';
  language: string;
  framework?: string;
  includeTests?: boolean;
  includeComments?: boolean;
}

export interface ConversationRequest extends AIRequest {
  taskType: 'conversation';
  conversationType: 'chat' | 'support' | 'tutoring' | 'interview';
  personality?: string;
}

// Post-processing Utilities
export interface PostProcessingOptions {
  extractJson?: boolean;
  formatOutput?: 'markdown' | 'html' | 'plain' | 'json';
  validateStructure?: boolean;
  sanitize?: boolean;
  translate?: string;
  summarize?: boolean;
  keywordExtraction?: boolean;
}

// Error codes for programmatic handling
export type AIErrorCode =
  | 'NO_API_KEY'
  | 'NO_PROVIDERS'
  | 'RATE_LIMIT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

// Error Types
export class AIError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode?: number,
    public details?: unknown,
    public code?: AIErrorCode
  ) {
    super(message);
    this.name = 'AIError';
  }
}

// Utility Types
export interface ModelCapabilities {
  reasoning: 'basic' | 'advanced' | 'expert';
  creativity: 'low' | 'medium' | 'high';
  speed: 'slow' | 'medium' | 'fast';
  cost: 'free' | 'low' | 'medium' | 'high';
  contextLength: number;
  supportedTasks: string[];
}

export interface ProcessingMetrics {
  startTime: number;
  endTime: number;
  processingTime: number;
  tokensUsed: number;
  cost: number;
  providerLatency: number;
  modelLatency: number;
}
