// Per-call overhead of OpenAIProvider / AIFactory above raw fetch, non-streaming.
import { startMock } from './mock-server.mjs';
import { OpenAIProvider, AIFactory } from '../dist/index.js';

const WARMUP = 50;
const ITERS = 500;

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: at(50), p95: at(95), p99: at(99) };
}

async function run(name, fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return { name, ...percentiles(samples) };
}

const { url, close } = await startMock();
try {
  const rawFetch = async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.json();
  };

  const provider = new OpenAIProvider({ apiKey: 'x', baseURL: url, models: ['gpt-4o'] });
  const providerCall = () => provider.process({ prompt: 'hi' });

  const factory = new AIFactory({ providers: [provider], discover: 'none', retries: 0 });
  const factoryCall = () => factory.process({ prompt: 'hi' });

  const a = await run('raw fetch', rawFetch);
  const b = await run('OpenAIProvider', providerCall);
  const c = await run('AIFactory', factoryCall);

  const fmt = (n) => n.toFixed(3);
  console.log(`${a.name.padEnd(16)} p50=${fmt(a.p50)}ms  p95=${fmt(a.p95)}ms  p99=${fmt(a.p99)}ms`);
  console.log(`${b.name.padEnd(16)} p50=${fmt(b.p50)}ms  p95=${fmt(b.p95)}ms  p99=${fmt(b.p99)}ms  (delta p50=${fmt(b.p50 - a.p50)}ms, p99=${fmt(b.p99 - a.p99)}ms)`);
  console.log(`${c.name.padEnd(16)} p50=${fmt(c.p50)}ms  p95=${fmt(c.p95)}ms  p99=${fmt(c.p99)}ms  (delta p50=${fmt(c.p50 - a.p50)}ms, p99=${fmt(c.p99 - a.p99)}ms)`);
} finally {
  await close();
}
