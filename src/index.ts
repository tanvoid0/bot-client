// The zero-config entry: everything in `./core` plus the built-in providers,
// with `AIFactory` defaulting to all five when no `providers` are given.
export * from './core.js';
import { AIFactory as CoreFactory } from './ai-factory.js';
import type { AIProvider } from './types/index.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { LMStudioProvider } from './providers/lmstudio-provider.js';

export class AIFactory extends CoreFactory {
  protected override defaults(): AIProvider[] {
    return [new OpenAIProvider(), new AnthropicProvider(), new GeminiProvider(), new OllamaProvider(), new LMStudioProvider()];
  }
}

/**
 * Shared factory. Constructing it is free — provider discovery is deferred to
 * the first request — so importing this module touches no network.
 */
export const aiFactory = new AIFactory();

/** Shared factory, with provider discovery already run. */
export async function ensureFactoryReady(): Promise<AIFactory> {
  await aiFactory.ready();
  return aiFactory;
}

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
