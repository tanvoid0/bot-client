// Runtime smoke test: the built package answers a one-shot and a streamed
// request through an injected fetch, so it runs anywhere `fetch` does with no
// network and no keys. `node scripts/smoke.mjs`, `bun scripts/smoke.mjs`.
import assert from 'node:assert/strict';
import { AIFactory } from '../dist/core.js';
import { OpenAIProvider } from '../dist/providers/openai-provider.js';

const oneShot = { choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const sse = ['data: {"choices":[{"delta":{"content":"po"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];

const fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (!body.stream) return new Response(JSON.stringify(oneShot), { status: 200 });
  return new Response(new ReadableStream({ start(c) { for (const p of sse) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { status: 200 });
};

const factory = new AIFactory({ providers: [new OpenAIProvider({ apiKey: 'k', models: ['gpt-4o'], fetch })], discover: 'none' });

const res = await factory.process({ prompt: 'ping' });
assert.equal(res.success, true, res.error);
assert.equal(res.data, 'pong');
assert.equal(res.usage.totalTokens, 2);

let text = '';
let done;
for await (const chunk of factory.processStream({ prompt: 'ping' })) {
  if (chunk.type === 'text') text += chunk.text;
  if (chunk.type === 'done') done = chunk;
}
assert.equal(text, 'pong');
assert.equal(done.finishReason, 'stop');

console.log(`smoke ok on ${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`}`);
