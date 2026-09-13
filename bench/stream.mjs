// Per-chunk streaming overhead, and a memory check with --size.
import { startMock } from './mock-server.mjs';
import { OpenAIProvider } from '../dist/index.js';

const N = 1000;

async function timedRun() {
  const { url, close } = await startMock();
  try {
    const t0 = performance.now();
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', stream: true, max_tokens: N, messages: [{ role: 'user', content: 'hi' }] }),
    });
    let bytes = 0;
    for await (const chunk of res.body) bytes += chunk.length;
    const rawMs = performance.now() - t0;

    const provider = new OpenAIProvider({ apiKey: 'x', baseURL: url, models: ['gpt-4o'] });
    const t1 = performance.now();
    let chunks = 0;
    for await (const c of provider.processStream({ prompt: 'hi', maxTokens: N })) {
      if (!c.done) chunks++;
    }
    const providerMs = performance.now() - t1;

    const rawUs = (rawMs / N) * 1000;
    const providerUs = (providerMs / chunks) * 1000;
    console.log(`raw fetch:  ${rawMs.toFixed(2)}ms total, ${rawUs.toFixed(2)}us/chunk (${N} chunks, ${bytes} bytes)`);
    console.log(`processStream: ${providerMs.toFixed(2)}ms total, ${providerUs.toFixed(2)}us/chunk (${chunks} chunks)`);
    console.log(`delta: ${(providerUs - rawUs).toFixed(2)}us/chunk`);
  } finally {
    await close();
  }
}

// One gc() pass right after a big fetch body doesn't reliably settle V8's
// buffer pools; a couple of event-loop turns plus repeated gc() does.
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    global.gc?.();
  }
}

async function memoryRun() {
  const bytesTarget = 1024 * 1024;
  const framesNeeded = Math.ceil(bytesTarget / 'word '.length);
  const { url, close } = await startMock();
  try {
    const provider = new OpenAIProvider({ apiKey: 'x', baseURL: url, models: ['gpt-4o'] });
    // Warm up the code paths first: the first stream(s) through a process pay
    // one-time JIT/module compilation cost that dwarfs any real accumulation
    // and swamps the measurement below (ponytail: fixed at 3 passes; bump if
    // this still reads noisy on a given machine).
    for (let i = 0; i < 3; i++) {
      for await (const c of provider.processStream({ prompt: 'hi', maxTokens: 200 })) void c;
    }
    await settle();
    const before = process.memoryUsage().heapUsed;
    let total = 0;
    for await (const c of provider.processStream({ prompt: 'hi', maxTokens: framesNeeded })) {
      if (c.text) total += c.text.length;
    }
    await settle();
    const after = process.memoryUsage().heapUsed;
    console.log(`streamed ${total} chars (~${(total / 1024 / 1024).toFixed(2)} MB); heapUsed delta: ${((after - before) / 1024).toFixed(1)} KB`);
    if (!global.gc) console.log('(run with --expose-gc for a cleaner reading)');
  } finally {
    await close();
  }
}

if (process.argv.includes('--size')) await memoryRun();
else await timedRun();
