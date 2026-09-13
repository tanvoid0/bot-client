/**
 * Cost estimate from `usage` and a dated price table. USD per million
 * tokens, list prices for the vendors' own APIs; a reseller (OpenRouter,
 * Bedrock, Vertex) prices differently. `undefined` for a model not in the
 * table, never a guess. Extend or override with your own table.
 */
import type { TokenUsage } from '../types/index.js';

/** USD per 1M tokens. `cached` is the price of a prompt token served from the provider's cache. */
export interface Price {
  input: number;
  output: number;
  cached?: number;
}

/** When the table was last checked against the vendors' pricing pages. */
export const PRICES_DATE = '2026-09-13';

/** Keys are model id prefixes; the longest matching prefix wins, so `gpt-5-mini` beats `gpt-5`. */
export const PRICES: Record<string, Price> = {
  // Anthropic (cache read ≈ 10% of input)
  'claude-fable-5': { input: 10, output: 50, cached: 1 },
  'claude-opus-5': { input: 5, output: 25, cached: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cached: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cached: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cached: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cached: 0.1 },
  // OpenAI
  'gpt-5.5': { input: 5, output: 30, cached: 0.5 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 2.5, output: 15, cached: 0.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cached: 0.02 },
  'gpt-5.2': { input: 1.75, output: 14, cached: 0.175 },
  'gpt-5.1': { input: 1.25, output: 10, cached: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cached: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },
  'gpt-5-pro': { input: 15, output: 120 },
  'gpt-4.1': { input: 2, output: 8, cached: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cached: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  o1: { input: 15, output: 60, cached: 7.5 },
  o3: { input: 2, output: 8, cached: 0.5 },
  'o3-mini': { input: 1.1, output: 4.4, cached: 0.55 },
  'o4-mini': { input: 1.1, output: 4.4, cached: 0.275 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  // Google (paid tier, prompts ≤ 200k tokens where tiered)
  'gemini-3.5-flash': { input: 1.5, output: 9, cached: 0.15 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cached: 0.03 },
  'gemini-3.1-pro': { input: 2, output: 12, cached: 0.2 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cached: 0.025 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cached: 0.125 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.03 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cached: 0.01 },
  'gemini-embedding-2': { input: 0.2, output: 0 },
};

/** The price row for a model id, by longest matching prefix (an explicit `vendor/` prefix is ignored). */
export function priceOf(model: string, table: Record<string, Price> = PRICES): Price | undefined {
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

/** USD for one call. Cached prompt tokens are billed at the cache price when the table has one. */
export function estimateCost(usage: TokenUsage | undefined, model: string, table: Record<string, Price> = PRICES): number | undefined {
  const price = usage && priceOf(model, table);
  if (!price) return undefined;
  const cached = usage.cachedTokens ?? 0;
  const prompt = Math.max(0, (usage.promptTokens ?? 0) - cached);
  const completion = usage.completionTokens ?? 0;
  return (prompt * price.input + cached * (price.cached ?? price.input) + completion * price.output) / 1_000_000;
}
