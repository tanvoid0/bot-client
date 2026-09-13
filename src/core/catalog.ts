/**
 * Static model-id → provider routing, so `modelId: 'claude-…'` reaches
 * Anthropic without a network round trip to list models first.
 */

const PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(gpt-|o[1-4](-|$)|chatgpt-|text-embedding-(3|ada)|davinci|babbage|dall-e|whisper|tts-)/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^(gemini-|gemma-\d|imagen-|veo-|text-embedding-00\d|embedding-\d|learnlm)/i, 'gemini'],
  // Hosted ids that differ from the Ollama spelling of the same family.
  [/^grok-/i, 'xai'],
  [/^deepseek-(chat|reasoner)$/i, 'deepseek'],
  [/^(open-(mistral|mixtral)-|(mistral|codestral|ministral|magistral|pixtral|devstral)-(.*-)?(latest|\d{4})$)/i, 'mistral'],
  [/^llama-3\.\d-\d+b-(versatile|instant)$/i, 'groq'],
];

/** Bare family names as Ollama publishes them (`llama3.1`, `qwen2.5-coder`, ...). */
const OLLAMA_FAMILIES =
  /^(llama|codellama|mistral|mixtral|gemma|qwen|phi|deepseek|llava|nomic|mxbai|tinyllama|starcoder|granite|smollm|command-r|vicuna|orca|dolphin|wizard|zephyr|yi|falcon|gpt-oss|magistral|devstral|codestral|aya|neural-chat|openchat|solar|stablelm|bge|all-minilm|snowflake)([\d.:-]|$)/i;

/** Provider id a model id most likely belongs to, or null when unknown. */
export function guessProvider(modelId: string): string | null {
  for (const [re, id] of PREFIXES) if (re.test(modelId)) return id;
  if (modelId.includes(':')) return 'ollama';
  if (OLLAMA_FAMILIES.test(modelId)) return 'ollama';
  return null;
}

/**
 * `openai/gpt-4o` → `{ providerId: 'openai', modelId: 'gpt-4o' }` when the
 * prefix names a registered provider; otherwise null (an OpenRouter-style id
 * such as `meta-llama/llama-3` passes through untouched).
 */
export function splitExplicit(
  modelId: string,
  registered: Iterable<string>
): { providerId: string; modelId: string } | null {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return null;
  const prefix = modelId.slice(0, slash);
  for (const id of registered) {
    if (id === prefix) return { providerId: id, modelId: modelId.slice(slash + 1) };
  }
  return null;
}
