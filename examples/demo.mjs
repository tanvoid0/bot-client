/**
 * Real scenarios, real output. Run after `npm run build`:
 *
 *   node examples/demo.mjs            # needs Ollama running locally; no API keys
 *   OLLAMA_MODEL=llama3.1 node examples/demo.mjs
 *
 * Every block prints what the library actually returned, so the README's
 * examples are copied from here rather than typed by hand.
 */
import { AIFactory, aiFactory, OllamaProvider, LMStudioProvider, OpenAIProvider, AIError } from '../dist/index.js';

const MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:latest';
const section = (title) => console.log(`\n=== ${title} ===`);
const show = (label, value) => console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));

// 1. Zero config: local Ollama, no API keys anywhere.
section('1. generate() with zero config');
const text = await aiFactory.generate('In one short sentence, what is a mutex?', { modelId: MODEL, maxTokens: 60 });
show('text', text.trim());

// 2. Streaming with the timings the done chunk carries.
section('2. processStream()');
let out = '';
for await (const chunk of aiFactory.processStream({ prompt: 'Count from 1 to 5, comma separated.', modelId: MODEL, maxTokens: 40 })) {
  out += chunk.text;
  if (chunk.done) {
    show('text', out.trim());
    show('done chunk', { finishReason: chunk.finishReason, usage: chunk.usage, timeToFirstTokenMs: chunk.timeToFirstTokenMs, durationMs: chunk.durationMs });
  }
}

// 3. JSON mode: the provider's native JSON switch, then parse it yourself.
section('3. jsonMode');
const res = await aiFactory.process({
  prompt: 'Give three primary colours as {"colours": string[]}.',
  modelId: MODEL,
  jsonMode: true,
  maxTokens: 80,
});
show('response', { success: res.success, data: res.data?.trim(), finishReason: res.finishReason, usage: res.usage, durationMs: res.durationMs });
show('parsed', JSON.parse(res.data));

// 3b. Reasoning models: thinking arrives as `reasoning`, never mixed into `text`.
section('3b. reasoning: true (streamed)');
let answer = '';
let thought = '';
for await (const chunk of aiFactory.processStream({ prompt: 'Is 91 prime? Answer yes or no with one reason.', modelId: MODEL, reasoning: true, maxTokens: 400 })) {
  if (chunk.reasoning) thought += chunk.reasoning;
  answer += chunk.text;
  if (chunk.done) show('done chunk', { finishReason: chunk.finishReason, usage: chunk.usage, timeToFirstTokenMs: chunk.timeToFirstTokenMs });
}
show('reasoning (first 160 chars)', thought.trim().slice(0, 160) + (thought.length > 160 ? '…' : ''));
show('text', answer.trim());

// 4. Model not found: the provider's own message plus a hint.
section('4. MODEL_NOT_FOUND');
const missing = await aiFactory.process({ prompt: 'hi', modelId: 'llama9:70b' });
show('success', missing.success);
show('String(errorInfo)', String(missing.errorInfo));
show('errorInfo', missing.errorInfo);

// 5. Provider not running: LM Studio is off on this machine.
section('5. PROVIDER_UNREACHABLE');
const down = await new LMStudioProvider().process({ prompt: 'hi', modelId: 'any' });
show('String(errorInfo)', String(down.errorInfo));
show('retryable', down.errorInfo.retryable);

// 6. A model that routes to a provider you have not set up.
section('6. NO_PROVIDERS for a cloud model with no key');
const cloud = await aiFactory.process({ prompt: 'hi', modelId: 'gpt-4o' });
show('String(errorInfo)', String(cloud.errorInfo));

// 7. Fallback: a bad OpenAI key fails with AUTH (not retried), the request moves to Ollama.
section('7. fallbackProvider');
const factory = new AIFactory({
  providers: [new OpenAIProvider({ apiKey: 'sk-not-a-real-key', models: ['gpt-4o'] }), new OllamaProvider({ models: [MODEL] })],
  discover: 'lazy',
  fallbackProvider: 'ollama',
  logger: { warn: (m) => console.log('  [warn]', m) },
});
const fb = await factory.process({ prompt: 'Say "fallback works" and nothing else.', modelId: 'gpt-4o', maxTokens: 20 });
show('response', { success: fb.success, providerId: fb.providerId, modelUsed: fb.modelUsed, fallbackUsed: fb.fallbackUsed, retryCount: fb.retryCount, data: fb.data?.trim() });

// 8. generate() throws the same AIError; catch by code.
section('8. generate() throws AIError');
try {
  await aiFactory.generate('hi', { modelId: 'llama9:70b' });
} catch (err) {
  if (err instanceof AIError) {
    show('caught', { code: err.code, provider: err.provider, statusCode: err.statusCode, message: err.message, hint: err.hint });
  } else throw err;
}

// 9. Abort a stream from the caller.
section('9. AbortSignal');
const abort = new AbortController();
let partial = '';
try {
  for await (const chunk of aiFactory.processStream({ prompt: 'Write a long paragraph about rivers.', modelId: MODEL, signal: abort.signal })) {
    partial += chunk.text;
    if (partial.length > 40) abort.abort(); // stop after the first few words
  }
} catch (err) {
  show('caught', { code: err.code, message: err.message, partialChars: partial.length });
}

// 10. Timeout on a non-streaming call.
section('10. TIMEOUT');
const slow = await aiFactory.process({ prompt: 'Write a long essay.', modelId: MODEL, timeout: 50 });
show('String(errorInfo)', String(slow.errorInfo));
show('retryCount', slow.retryCount);
