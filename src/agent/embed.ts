/**
 * Embeddings over `fetch`: OpenAI-format `/embeddings` (OpenAI and every
 * compatible host), Gemini `batchEmbedContents`, Ollama `/api/embed`.
 * One function; the provider is picked from the model id unless given.
 */
import { guessProvider } from '../core/catalog.js';
import { AIError, toAIError } from '../core/errors.js';
import { httpJson, type FetchLike } from '../core/http.js';
import { firstEnv } from '../providers/base-provider.js';

export type EmbedProvider = 'openai' | 'gemini' | 'ollama';

export interface EmbedOptions {
  model: string;
  /** Default: from the model id (`text-embedding-3-small` → openai, `text-embedding-004` → gemini, `nomic-embed-text` → ollama), else openai. */
  provider?: EmbedProvider;
  /** Origin, e.g. `https://api.groq.com/openai/v1` for an OpenAI-format host. */
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeout?: number;
  /** OpenAI-format only: request this many dimensions (`text-embedding-3-*`). */
  dimensions?: number;
}

export interface EmbedResult {
  embeddings: number[][];
  usage?: { promptTokens?: number; totalTokens?: number };
}

const DEFAULTS: Record<EmbedProvider, { baseURL: string; env: string[] }> = {
  openai: { baseURL: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY', 'BOT_CLIENT_OPENAI_KEY'] },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', env: ['GEMINI_API_KEY', 'BOT_CLIENT_GEMINI_KEY'] },
  ollama: { baseURL: 'http://localhost:11434', env: [] },
};

/** Vectors for `texts`, in order. */
export async function embed(texts: string[], options: EmbedOptions): Promise<EmbedResult> {
  const provider = options.provider ?? pick(options.model);
  const base = (options.baseURL ?? DEFAULTS[provider].baseURL).replace(/\/$/, '');
  const apiKey = options.apiKey ?? firstEnv(DEFAULTS[provider].env);
  const ctx = { provider, model: options.model, baseURL: base };
  const common = { headers: options.headers, fetch: options.fetch, signal: options.signal, timeout: options.timeout, provider };
  if (provider !== 'ollama' && !apiKey) {
    throw AIError.from({ message: `No API key for ${provider}`, provider, code: 'NO_API_KEY', model: options.model, hint: `Pass { apiKey } or set ${DEFAULTS[provider].env[0]}.` });
  }
  try {
    if (provider === 'gemini') {
      const model = options.model.startsWith('models/') ? options.model : `models/${options.model}`;
      const { data } = await httpJson<{ embeddings: Array<{ values: number[] }> }>(`${base}/${model}:batchEmbedContents`, {
        ...common,
        headers: { 'x-goog-api-key': apiKey!, ...options.headers },
        body: { requests: texts.map((text) => ({ model, content: { parts: [{ text }] } })) },
      });
      return { embeddings: data.embeddings.map((e) => e.values) };
    }
    if (provider === 'ollama') {
      const { data } = await httpJson<{ embeddings: number[][]; prompt_eval_count?: number }>(`${base}/api/embed`, {
        ...common,
        body: { model: options.model, input: texts },
      });
      return { embeddings: data.embeddings, ...(data.prompt_eval_count !== undefined && { usage: { promptTokens: data.prompt_eval_count } }) };
    }
    const { data } = await httpJson<{ data: Array<{ index: number; embedding: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } }>(
      `${base}/embeddings`,
      {
        ...common,
        headers: { authorization: `Bearer ${apiKey}`, ...options.headers },
        body: { model: options.model, input: texts, ...(options.dimensions && { dimensions: options.dimensions }) },
      }
    );
    const embeddings = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { embeddings, ...(data.usage && { usage: { promptTokens: data.usage.prompt_tokens, totalTokens: data.usage.total_tokens } }) };
  } catch (err) {
    throw toAIError(err, ctx);
  }
}

/** Cosine similarity in [-1, 1]; 0 when either vector is all zeros. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: vectors differ in length (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function pick(model: string): EmbedProvider {
  const g = guessProvider(model);
  return g === 'gemini' || g === 'ollama' ? g : 'openai';
}
