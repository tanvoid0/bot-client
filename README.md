# Bot Client

[![CI/CD Pipeline](https://github.com/tanvoid0/bot-client/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/tanvoid0/bot-client/actions)
[![npm version](https://img.shields.io/npm/v/@tanvoid0/bot-client.svg)](https://www.npmjs.com/package/@tanvoid0/bot-client)
[![npm downloads](https://img.shields.io/npm/dm/@tanvoid0/bot-client.svg)](https://www.npmjs.com/package/@tanvoid0/bot-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![bundle size](https://img.shields.io/badge/core%20%2B%20one%20provider-12.1%20kB%20gz-blue)
![runtimes](https://img.shields.io/badge/runs%20on-Node%20%C2%B7%20Bun%20%C2%B7%20Deno%20%C2%B7%20Workers%20%C2%B7%20browsers-blue)

Zero-dependency TypeScript LLM client: OpenAI, Anthropic, Gemini, **Ollama**, LM Studio, plus Groq, OpenRouter, DeepSeek, Mistral, xAI, Together and any other OpenAI-compatible API through one `OpenAICompatibleProvider`. Zero-config for local; API keys for cloud. **Zero runtime dependencies** (native `fetch`, Node 18+); the main entry has no Node built-ins, so it runs in Bun, Deno, Workers and browsers too. One request shape for every provider, with **real streaming** on all five, **tool calling** with an automatic `maxSteps` loop, **structured output** through any Standard Schema (Zod, Valibot, ArkType) or plain JSON Schema, **images** in messages, **typed provider errors** (a code and a hint, the provider's own message never rewritten), **retries with backoff**, a **stream idle timeout**, and `finishReason` on every response. Model routing is static: `modelId: 'claude-sonnet-4-5'` reaches Anthropic with no discovery call, and an explicit `openai/gpt-4o` prefix always wins. Includes **Ollama API + CLI** (pull, list, rm, show, ps, run) and an **npx CLI** for models, API keys and a `doctor` that pings every provider.

Upgrading from 1.x? Read [MIGRATION.md](MIGRATION.md): every removed input fails with an error naming its replacement.

---

## Install

```bash
npm install @tanvoid0/bot-client
```

The main entry exports everything and is edge/browser safe. `/core` plus one provider subpath bundles to 12.1 kB gzipped (`npm run bench:size`); `ollama-cli` is the only one that needs Node:

```typescript
import { AIFactory } from '@tanvoid0/bot-client/core';               // factory, errors, types; no built-in providers (pass `providers`)
import { OpenAIProvider } from '@tanvoid0/bot-client/openai';        // also /anthropic /gemini /ollama /lmstudio /openai-compatible
import { runOllamaCLI } from '@tanvoid0/bot-client/ollama-cli';      // spawns the `ollama` binary (Node only)
```

## Quick start

```typescript
import { aiFactory } from '@tanvoid0/bot-client';

const text = await aiFactory.generate('Say hello in one sentence.', { maxTokens: 100 });
console.log(text);
```

With **Ollama** running locally, this works without API keys. For cloud providers, set env vars (see [Environment](#environment)).

---

## Streaming

`processStream` yields the answer as it is written, over real SSE (OpenAI, LM Studio, Anthropic, Gemini) or NDJSON (Ollama). Chunks are a union discriminated by `type`: `text` (the delta since the previous chunk; append, do not replace), `reasoning` (a thinking model's thoughts, never mixed into the answer), `tool-call` (one completed call) and a final `done` carrying `finishReason`, `usage` (when the provider reports it), `toolCalls`, `durationMs` (wall time for the whole stream) and `timeToFirstTokenMs`.

```typescript
import { aiFactory } from '@tanvoid0/bot-client';

for await (const chunk of aiFactory.processStream({ prompt: 'Count to twenty.' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'done') console.log('\n', chunk.finishReason, chunk.usage, `${chunk.durationMs}ms`);
}
```

A stalled upstream fails the stream with `STREAM_IDLE` after `streamIdleTimeout` ms of silence, default 60 s. Set it per request (`{ streamIdleTimeout: 20_000 }`), per factory (`new AIFactory({ streamIdleTimeout })`) or per provider (`new OpenAIProvider({ streamIdleTimeout })`); the clock resets on every byte, so a slow-but-alive stream never trips it.

Cancel early with an `AbortSignal`:

```typescript
const abort = new AbortController();
setTimeout(() => abort.abort(), 10_000);

try {
  for await (const chunk of aiFactory.processStream({ prompt, signal: abort.signal })) {
    if (chunk.type === 'text') process.stdout.write(chunk.text);
  }
} catch (err) {
  if (abort.signal.aborted) console.log('cancelled');
  else throw err;
}
```

Breaking out of the `for await` also closes the upstream connection. A provider error mid-stream throws `AIError` from the loop rather than ending the stream as a success; retry and fallback only apply before the first chunk arrives (see [Retries and fallback](#retries-and-fallback)).

---

## JSON mode

`jsonMode: true` asks the provider for JSON output. OpenAI, LM Studio and any `OpenAICompatibleProvider` use the native `response_format: { type: 'json_object' }`; Gemini uses `responseMimeType`; Ollama uses `format: 'json'`. Anthropic has no native JSON mode, so `jsonMode` adds one line to the system prompt asking for a bare JSON value instead; it is a request, not an API-enforced constraint. Parse the result yourself; the client returns the raw string.

```typescript
const res = await aiFactory.process({
  prompt: 'List three fruits as {"fruits": string[]}.',
  jsonMode: true,
});
const { fruits } = JSON.parse(res.data!);
```

`responseSchema` is passed through only where the provider accepts one (Gemini today) and in that provider's own dialect; it is not translated between providers.

---

## Messages and images

`prompt` is shorthand for a final user turn. `messages` is the whole conversation; a user message may carry image parts as a remote URL, a `data:` URL, raw bytes or base64 (the mime type is sniffed when omitted).

```typescript
const res = await aiFactory.process({
  modelId: 'gpt-4o',
  systemPrompt: 'Answer in one line.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image', data: await readFile('cat.png') }] },
    { role: 'assistant', content: 'A cat on a keyboard.' },
  ],
  prompt: 'What colour is it?',
});
```

Images go out as OpenAI `image_url`, Anthropic `source`, Gemini `inlineData` / `fileData` and Ollama `images[]`. Ollama takes bytes only: a remote URL there fails `UNSUPPORTED` with a hint.

---

## Tool calling

Define tools with a JSON Schema for the arguments. Without `maxSteps`, the model's calls come back on `toolCalls` and you run them; with `maxSteps > 1` and an `execute` on each tool, the factory runs the calls (in parallel), feeds the results back and asks again, up to `maxSteps` rounds, recording each in `steps`.

```typescript
const weather = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => fetchWeather(city),
};

const res = await aiFactory.process({ prompt: 'Is it raining in Oslo?', tools: [weather], maxSteps: 3 });
console.log(res.data);            // "No, it is 21C and clear."
console.log(res.steps?.[0].toolResults);
```

`toolChoice` is `'auto'`, `'none'`, `'required'` or `{ name }`; it applies to the first round only, so a forced call cannot loop forever. A tool that throws is reported to the model as `{ error }` rather than failing the request. Streams emit a `{ type: 'tool-call' }` chunk per completed call and one `done` at the end of the last round. Weak local models that print `<function=name>{...}</function>` as text get the call recovered and the markup stripped.

---

## Structured output

`schema` takes a JSON Schema object or any [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, ...). It implies JSON mode, goes out on the wire where the host takes a schema (OpenAI `json_schema`, Gemini `responseSchema`, Ollama `format`; Anthropic gets it in the system prompt), and the answer is parsed and validated onto `object`.

```typescript
import { z } from 'zod';

const Weather = z.object({ city: z.string(), tempC: z.number() });
const res = await aiFactory.process({ prompt: 'Weather in Oslo as JSON.', schema: Weather });
if (res.success) console.log(res.object); // { city: 'Oslo', tempC: 21 }, validated
```

A non-JSON answer fails `INVALID_JSON`, a validation failure `SCHEMA_MISMATCH` (every issue in `errorInfo.details`), and an answer cut off by `maxTokens` `TRUNCATED`; the raw text stays on `data`. A plain JSON Schema is sent but not validated locally (no validator ships). Streams ignore `schema`.

---

## Reasoning models

`reasoning: true` lets a thinking model think. The thinking comes back as `reasoning` on the response and as `{ type: 'reasoning' }` chunks on a stream. It is never mixed into the answer.

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Is 91 prime?', modelId: 'gemma4', reasoning: true })) {
  if (chunk.type === 'reasoning') process.stderr.write(chunk.text); // the model's thinking
  if (chunk.type === 'text') process.stdout.write(chunk.text);       // the answer
}
```

| Provider | `reasoning: true` sends | Thinking read from |
|---|---|---|
| Ollama | `think: true` (`think: false` otherwise) | `message.thinking`, or inline `<think>` tags |
| Anthropic | `thinking: { type: 'enabled', budget_tokens }`, temperature 1 | `thinking` content blocks / `thinking_delta` events |
| Gemini | `thinkingConfig.includeThoughts` | parts marked `thought: true` |
| OpenAI-compatible (DeepSeek, vLLM, llama.cpp, OpenRouter, LM Studio) | nothing extra | `reasoning_content` or `reasoning` on the message or delta, or inline `<think>` tags |

Ollama defaults to `think: false`. Left on, a thinking model can spend its whole `maxTokens` on thinking and hand back an empty answer with `finishReason: 'length'`. An inline `<think>` tag split across two stream chunks is held back until it is known to be a tag, so no tag text leaks into `text`.

---

## Errors

Every provider failure becomes an `AIError`: a classified `code`, the provider's own `message` verbatim, and a one-line `hint` saying what to do next.

```typescript
class AIError extends Error {
  code: AIErrorCode;
  provider: string;
  message: string;        // the provider's own text, never rewritten
  hint?: string;          // one sentence: what to do next
  statusCode?: number;    // HTTP status, when the failure was an HTTP reply
  providerCode?: string;  // the provider's own error type/code, verbatim
  retryable: boolean;
  retryAfterMs?: number;  // from Retry-After or the provider body
  requestId?: string;     // provider request id header, when sent
  model?: string;
}
```

<details>
<summary><strong>AIErrorCode</strong></summary>

```typescript
type AIErrorCode =
  // not retryable: fix credentials or the account
  | 'NO_API_KEY' | 'AUTH' | 'PERMISSION' | 'QUOTA'
  // retryable: transient on the provider or network side
  | 'RATE_LIMIT' | 'OVERLOADED' | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'STREAM_IDLE'
  // caller cancelled
  | 'ABORTED'
  // fix the request
  | 'MODEL_NOT_FOUND' | 'CONTEXT_LENGTH' | 'INVALID_REQUEST' | 'UNSUPPORTED'
  // output problems
  | 'CONTENT_FILTER' | 'TRUNCATED' | 'INVALID_JSON' | 'SCHEMA_MISMATCH'
  // setup problems
  | 'PROVIDER_UNREACHABLE' | 'NO_PROVIDERS' | 'NO_MODEL'
  | 'TOOL_ERROR' | 'MCP_ERROR'
  | 'INVALID_RESPONSE' | 'UNKNOWN';
```
</details>

`process()` never throws for a provider failure; it returns `{ success: false, error, errorInfo }`:

```typescript
const res = await aiFactory.process({ prompt: 'Hello', modelId: 'gpt-4o' });
if (!res.success) {
  switch (res.errorInfo?.code) {
    case 'NO_API_KEY':
    case 'MODEL_NOT_FOUND':
    case 'PROVIDER_UNREACHABLE':
      console.error(res.errorInfo.hint);
      break;
    case 'RATE_LIMIT':
    case 'OVERLOADED':
      // already retried automatically; this is the final failure
      break;
    default:
      console.error(String(res.errorInfo));
  }
}
```

`String(error)` renders the code and message with the hint appended:

```
[openai/RATE_LIMIT] Rate limit reached — Retry after 20s, or lower the request rate; retried automatically when retry is enabled.
```

`generate()` throws the `AIError` instead of returning a failure response. `processStream()` throws it from the iterator once a stream has failed.

---

## Retries and fallback

Retryable codes (`RATE_LIMIT`, `OVERLOADED`, `SERVER`, `NETWORK`, `TIMEOUT`, `STREAM_IDLE`) are retried automatically with exponential backoff and jitter, honouring a provider's `Retry-After` when it sends one. Everything else (`NO_API_KEY`, `AUTH`, `MODEL_NOT_FOUND`, `INVALID_REQUEST`, ...) fails immediately, since retrying a bad request or a missing key only wastes a call.

```typescript
const factory = new AIFactory({
  retry: { retries: 2, baseDelayMs: 500, maxDelayMs: 8000 }, // defaults
  fallbackProviders: ['anthropic', 'ollama'],
});
```

Defaults: 2 retries, 500 ms base delay, doubling each attempt up to 8 s, plus or minus 20% jitter. `retries: 0` opts out. `fallbackProvider` (single id) and `fallbackProviders` (array, tried in order after it) both work; a fallback is tried once retries on the current provider are exhausted, or immediately for `NO_API_KEY`, `MODEL_NOT_FOUND` and `PROVIDER_UNREACHABLE`.

Every response carries `retryCount` (attempts spent before this answer) and `fallbackUsed` (true when a fallback provider answered), so a success that took retries is still visible to the caller.

Streaming rule: retry and fallback only run before the first chunk arrives. Once text has reached the caller, a mid-stream failure throws instead of restarting on another provider, which would splice two different answers together.

---

## Performance

| Metric | Value |
|---|---|
| Per-call overhead above raw `fetch` (p50 / p99) | below noise: within 0.2 ms / 1 ms of a bare `fetch` + `res.json()` |
| Streaming overhead per chunk | 7.6 µs per yielded chunk |
| Memory for a 1 MB streamed answer | flat (about 0.3 MB heap delta; chunks are yielded, never accumulated) |
| Cold import of the core entry | 9.8 ms median, zero network calls |
| First-request network calls with `discover: 'lazy'` and a routable `modelId` | 1 (the completion itself) |
| Published size (minified, gz) | `.` entry 14.0 kB; one provider subpath 6.1–6.7 kB |

Measured with `npm run bench` on Node 24.14, 2026-09-13, against a local mock server; see [bench/RESULTS.md](bench/RESULTS.md) for method and caveats.

---

## npx CLI

Manage Ollama models and API keys from the terminal, and check every provider at once:

```bash
npx @tanvoid0/bot-client help
npx @tanvoid0/bot-client doctor
npx @tanvoid0/bot-client ollama list
npx @tanvoid0/bot-client ollama pull llama3.1:8b
npx @tanvoid0/bot-client keys list
npx @tanvoid0/bot-client keys set BOT_CLIENT_OPENAI_KEY sk-...
```

<details>
<summary><strong>doctor</strong></summary>

Lists each provider's models, sends it a one-line prompt (`maxTokens: 16`), and prints the model that answered or the classified error with its hint. Name a preset to include it (`doctor groq openrouter`). Exit code 0 when at least one provider answered.

```
$ npx @tanvoid0/bot-client doctor
openai       FAIL  NO_API_KEY                   OpenAI API key required — Pass { apiKey } to the OpenAI provider or set its environment variable. (24 ms)
anthropic    FAIL  NO_API_KEY                   Anthropic API key required — Pass { apiKey } to the Anthropic provider or set its environment variable. (24 ms)
gemini       FAIL  NO_API_KEY                   Gemini API key required — Pass { apiKey } to the Google Gemini provider or set its environment variable. (24 ms)
ollama       ok    llama3.1:8b                  6 models (353 ms)
lmstudio     FAIL  NO_MODEL                     No chat models available (only embedding models may be loaded) — Load a chat model in LM Studio, or pass modelId. (6 ms)
```
</details>

<details>
<summary><strong>Ollama commands</strong></summary>

| Command | Description |
|--------|-------------|
| `ollama list` / `ollama ls` | List models |
| `ollama pull <model>` | Pull a model |
| `ollama rm <model>` | Remove a model |
| `ollama show <model>` | Show model info |
| `ollama ps` | List running models |
| `ollama run <model> [prompt]` | Run model (optional prompt) |

Uses the local Ollama API when the server is up; falls back to the `ollama` CLI.
</details>

<details>
<summary><strong>Keys commands</strong></summary>

Read/write `.env` in the current directory.

| Command | Description |
|--------|-------------|
| `keys list` / `keys ls` | List known API keys (masked) |
| `keys get <key> [--show]` | Get value (masked unless `--show`) |
| `keys set <key> <value>` | Set key in `.env` |

Known keys: `BOT_CLIENT_PROVIDER`, `BOT_CLIENT_OPENAI_KEY`, `BOT_CLIENT_ANTHROPIC_KEY`, `BOT_CLIENT_GEMINI_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
</details>

---

## Environment

<details>
<summary><strong>API keys and provider</strong></summary>

```bash
# Provider (optional): ollama | openai | anthropic | gemini | lmstudio
export BOT_CLIENT_PROVIDER=ollama

# Keys (recommended names)
export BOT_CLIENT_OPENAI_KEY="sk-..."
export BOT_CLIENT_ANTHROPIC_KEY="sk-ant-..."
export BOT_CLIENT_GEMINI_KEY="..."

# Legacy names (still supported)
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."
```

Local providers (Ollama, LM Studio) need no keys; ensure the app is running on its default port.
</details>

---

## API (library)

<details>
<summary><strong>aiFactory (singleton)</strong></summary>

- `generate(prompt, options?)` → `Promise<string>`
- `process(request)` → `Promise<AIResponse>`
- `processStream(request)` → `AsyncGenerator<AIStreamChunk>` (see [Streaming](#streaming))
- `getAvailableProviders()` → `string[]`
- `getProvider(id)` → `AIProvider | null`
- `getAllProviders()` → `AIProvider[]`
- `getAllSupportedModels()` → `string[]` (all models across providers)
- `getProviderForModel(modelId)` → `AIProvider | null`
- `testProviders()` → `Promise<Record<string, boolean>>` (connection status per provider)
- `ready()` → `Promise<void>` (resolves when init is complete)
</details>

<details>
<summary><strong>AIFactory (custom config)</strong></summary>

Create a factory with default provider, fallback, order, logger, or custom providers:

```typescript
import { AIFactory } from '@tanvoid0/bot-client';

const factory = new AIFactory({
  defaultProvider: 'ollama',
  fallbackProviders: ['openai'],
  providerOrder: ['ollama', 'lmstudio', 'openai'],
  logger: { info: console.log, warn: console.warn, error: console.error },
  retry: { retries: 1 },
});
await factory.ready();
const text = await factory.generate('Hello');
```

Use only specific providers (e.g. custom or pre-configured):

```typescript
import { AIFactory, OllamaProvider, OpenAIProvider } from '@tanvoid0/bot-client';

const factory = new AIFactory({
  providers: [
    new OllamaProvider({ baseURL: 'http://localhost:11434' }),
    new OpenAIProvider({ apiKey: process.env.MY_KEY })
  ],
  defaultProvider: 'ollama'
});
```
</details>

<details>
<summary><strong>Discovery</strong></summary>

`discover` controls when a provider's model list is fetched, and never sends a paid generation to do it:

- `'lazy'` (default): every candidate provider is registered up front; a provider is probed only the first time a request resolves to it. Nothing is called until the first request.
- `'eager'`: every candidate provider is probed in parallel on first use; only those that answer are kept. Probing lists models (`GET /models` or equivalent), so init costs one cheap call per provider, not a completion.
- `'none'`: never probes; routing relies on `modelId` (explicit prefix or the static catalog) and any `models` seeded in the provider's config.

```typescript
const factory = new AIFactory({ discover: 'lazy' });
```

`testConnection()` (used during eager discovery and by `testProviders()`) lists models instead of sending a real completion.
</details>

<details>
<summary><strong>Any OpenAI-compatible API</strong></summary>

Point `OpenAICompatibleProvider` at any server that speaks the OpenAI chat-completions dialect. Six hosts ship as presets that fill in the origin and the key variable:

```typescript
import { AIFactory, OpenAICompatibleProvider } from '@tanvoid0/bot-client';

const groq = new OpenAICompatibleProvider({ preset: 'groq' });               // reads GROQ_API_KEY
const vllm = new OpenAICompatibleProvider({ id: 'vllm', baseURL: 'http://gpu-box:8000' });

const factory = new AIFactory({ providers: [groq, vllm] });
```

| Preset | Origin | Key variable |
|---|---|---|
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `xai` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |

Any field given alongside `preset` overrides it (`{ preset: 'groq', apiKey, baseURL }`). Model ids the hosts use (`grok-4`, `deepseek-chat`, `mistral-large-latest`, `llama-3.3-70b-versatile`) route to the matching preset with no discovery call; `vendor/model` ids (OpenRouter, Together) go to `defaultProvider`, or prefix them explicitly: `openrouter/meta-llama/llama-4-scout`.
</details>

<details>
<summary><strong>Ollama provider (programmatic)</strong></summary>

Use the Ollama provider for API-first operations. Pass `cli: runOllamaCLI` to fall back to the `ollama` binary when the server is down (and for `serve`, `stop`, `create`, which are CLI-only); it comes from the Node-only `ollama-cli` subpath so the main entry stays free of `child_process`:

```typescript
import { AIFactory, OllamaProvider } from '@tanvoid0/bot-client';
import { runOllamaCLI } from '@tanvoid0/bot-client/ollama-cli';

const factory = new AIFactory({ providers: [new OllamaProvider({ cli: runOllamaCLI })] });
const ollama = factory.getProvider('ollama') as OllamaProvider | null;
if (ollama) {
  const list = await ollama.list();   // list models
  await ollama.pull('llama3.1:8b');   // pull model
  const info = await ollama.show('llama3.1:8b');
  const out = await ollama.run('llama3.1:8b', 'Hello');
}
```

Or instantiate with custom base URL / CLI path:

```typescript
const provider = new OllamaProvider({
  baseURL: 'http://localhost:11434',
  cli: runOllamaCLI,
  ollamaExecutablePath: 'ollama',
  preferCLI: false  // true = always use CLI
});
await provider.pull('gemma3');
```
</details>

<details>
<summary><strong>Standalone Ollama CLI helper</strong></summary>

```typescript
import { runOllamaCLI, isOllamaCLIAvailable } from '@tanvoid0/bot-client/ollama-cli';

const ok = await isOllamaCLIAvailable();
const result = await runOllamaCLI('pull', ['llama3.1:8b'], { onStderr: (c) => process.stderr.write(c) });
// result: { ok, code, stdout, stderr }
```
</details>

<details>
<summary><strong>Customisation</strong></summary>

Every built-in provider takes `BaseProviderConfig`; the factory adds hooks and defaults on top.

```typescript
import { AIFactory, AnthropicProvider, OllamaProvider } from '@tanvoid0/bot-client';

const anthropic = new AnthropicProvider({
  baseURL: 'https://my-gateway.example.com',      // any origin that speaks the Messages API
  headers: { 'x-team': 'search' },                // sent on every request, after the provider's own
  fetch: myTracedFetch,                           // proxies, undici Agent, tests
  timeout: 15_000,                                // JSON calls; streams use streamIdleTimeout
  models: ['claude-sonnet-4-5'],                  // seeds the list: no discovery call, stays first after one
  modelCacheTtlMs: 60_000,                        // reuse a model listing this long (default 5 min; 0 = always fetch)
});

const factory = new AIFactory({
  providers: [anthropic, new OllamaProvider()],
  discover: 'lazy',                                // probe a provider the first time a request lands on it
  hooks: {
    onRequest: ({ provider, model, request }) => log.debug('→', provider, model),
    onResponse: ({ provider, response, durationMs }) => metrics.timing(provider, durationMs),
    onError: ({ provider, error, willRetry }) => log.warn(provider, error.code, willRetry ? 'retrying' : 'giving up'),
  },
});

// Provider-specific fields go in providerOptions; they are merged last into the wire body, one level deep.
await factory.process({ prompt: 'hi', modelId: 'llama3.1', providerOptions: { keep_alive: '10m', options: { num_ctx: 8192 } } });
await factory.process({ prompt: 'hi', modelId: 'gpt-4o', providerOptions: { top_p: 0.9, seed: 7 } });
```

Hooks are awaited; `onResponse` gets the `AIResponse`, or the `done` chunk for a stream. To see the exact bytes on the wire, wrap `fetch`.
</details>

<details>
<summary><strong>Types</strong></summary>

- **AIRequest**: `prompt?` (one of `prompt` / `messages` required), `messages?` (`Message[]`), `modelId?`, `temperature?`, `maxTokens?`, `systemPrompt?`, `jsonMode?`, `schema?` (JSON Schema or Standard Schema), `tools?`, `toolChoice?`, `maxSteps?`, `signal?` (`AbortSignal`), `timeout?` (whole request, ms, default 30000), `streamIdleTimeout?` (ms of upstream silence before a stream fails, default 60000), `metadata?`, `reasoning?` (let a thinking model think; see [Reasoning models](#reasoning-models)), `providerOptions?` (merged last into the wire body)
- **Message**: `{ role: 'system', content }` | `{ role: 'user', content: string | (TextPart | ImagePart)[] }` | `{ role: 'assistant', content, toolCalls? }` | `{ role: 'tool', toolCallId, name, content }`
- **Tool**: `name`, `description?`, `parameters` (JSON Schema), `execute?(args, { signal })`; **ToolCall**: `id`, `name`, `arguments`; **ToolResult**: `toolCallId`, `name`, `result?`, `error?`; **Step**: `text`, `toolCalls`, `toolResults`, `usage?`
- **AIResponse**: `success`, `data?`, `reasoning?`, `object?` (when `schema` given), `toolCalls?`, `steps?`, `error?`, `errorInfo?` (`AIError`, set when `success` is false), `finishReason` (`'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown'`), `usage?` (`TokenUsage`), `modelUsed?`, `providerId?`, `requestId?`, `durationMs`, `retryCount`, `fallbackUsed`
- **AIStreamChunk**: `{ type: 'text', text }` | `{ type: 'reasoning', text }` | `{ type: 'tool-call', toolCall }` | `{ type: 'done', finishReason, usage?, toolCalls?, requestId?, durationMs?, timeToFirstTokenMs? }`; every member has `modelUsed?`
- **TokenUsage**: `promptTokens?`, `completionTokens?`, `totalTokens?`, `cachedTokens?`
- **AIFactoryConfig**: `defaultProvider?`, `fallbackProvider?`, `fallbackProviders?`, `providerOrder?`, `logger?`, `providers?`, `retries?` (shorthand for `retry.retries`), `retry?` (`{ retries?, baseDelayMs?, maxDelayMs? }`), `discover?` (`'lazy' | 'eager' | 'none'`, default `'lazy'`), `timeout?`, `streamIdleTimeout?`, `hooks?` (`{ onRequest?, onResponse?, onError? }`)
- **BaseProviderConfig**: accepted by every built-in provider constructor: `baseURL?`, `headers?`, `timeout?`, `streamIdleTimeout?`, `models?` (seeds the supported list, skips discovery), `modelCacheTtlMs?` (default 300000), `fetch?` (custom `fetch`, for proxies or tests)
- **OpenAICompatibleProvider config**: `BaseProviderConfig` plus `preset?` (`'groq' | 'openrouter' | 'deepseek' | 'mistral' | 'xai' | 'together' | 'agent-platform'`), `id?`, `name?`, `apiKey?`, `modelFilter?`, `defaultModel?`, `defaultMaxTokens?`, `requireApiKey?`, `streamUsage?`, `apiKeyEnv?`
- **OllamaProvider config**: `BaseProviderConfig` plus `cli?` (`runOllamaCLI` from `/ollama-cli`), `ollamaExecutablePath?`, `preferCLI?`
- **Logger**: optional `debug`, `info`, `warn`, `error` (all `(message, ...args) => void`)
- **AIError**: see [Errors](#errors)
- **AIProvider**: interface for custom providers; implement `providerId`, `providerName`, `supportedModels`, `process`, `isModelSupported`, `testConnection`, `discoverModels`; `processStream` is optional (the factory falls back to one chunk from `process`)
- Removed in 2.0 (see [MIGRATION.md](MIGRATION.md)): `history`, `responseSchema`, `usageContext`; `tokensUsed` / `promptTokens` / `completionTokens` (use `usage`), `processingTime`, `confidence`, `cost`, `modelCapabilities`, `suggestedImprovements`, `timestamp`; the 1.x `{ text, done }` chunk shape
</details>

---

## See it run

`node examples/demo.mjs` runs the scenarios below against a local Ollama. The output here is copied from a real run (Ollama, `gemma4:latest`, no API keys set), not typed by hand.

<details>
<summary><strong>1. Zero config</strong></summary>

```typescript
const text = await aiFactory.generate('In one short sentence, what is a mutex?', { modelId: 'gemma4:latest', maxTokens: 60 });
```

```
A mutex is a synchronization primitive used to ensure that only one thread can access a shared resource at any given time.
```
</details>

<details>
<summary><strong>2. Streaming with timings</strong></summary>

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Count from 1 to 5, comma separated.', modelId: 'gemma4:latest' })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'done') console.log(chunk);
}
```

```
1, 2, 3, 4, 5
{ finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 14, totalTokens: 34 }, timeToFirstTokenMs: 39, durationMs: 120 }
```
</details>

<details>
<summary><strong>3. JSON mode</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'Give three primary colours as {"colours": string[]}.', modelId: 'gemma4:latest', jsonMode: true });
console.log(res.data, JSON.parse(res.data));
```

```
{"colours": ["red", "yellow", "blue"]}
{ colours: [ 'red', 'yellow', 'blue' ] }
```
</details>

<details>
<summary><strong>4. Reasoning</strong></summary>

```typescript
for await (const chunk of aiFactory.processStream({ prompt: 'Is 91 prime? Answer yes or no with one reason.', modelId: 'gemma4:latest', reasoning: true })) {
  if (chunk.type === 'reasoning') thought += chunk.text; else if (chunk.type === 'text') answer += chunk.text;
}
```

```
reasoning: Thinking Process:

1.  **Analyze the request:** The user asks "Is 91 prime?" and requires the answer to be "yes or no" with "one reason."
2.  **Define "prime nu…
text:      No, because 91 is divisible by 7 (91 = 7 * 13).
usage:     { promptTokens: 30, completionTokens: 342, totalTokens: 372 }
```
</details>

<details>
<summary><strong>5. Model not found</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'hi', modelId: 'llama9:70b' });
console.log(String(res.errorInfo));
console.log(res.errorInfo);
```

```
[ollama/MODEL_NOT_FOUND] model 'llama9:70b' not found — Run `ollama pull llama9:70b` and try again.
{
  code: 'MODEL_NOT_FOUND',
  provider: 'ollama',
  message: "model 'llama9:70b' not found",
  hint: 'Run `ollama pull llama9:70b` and try again.',
  statusCode: 404,
  retryable: false,
  model: 'llama9:70b'
}
```
</details>

<details>
<summary><strong>6. Provider not running</strong></summary>

```typescript
const res = await new LMStudioProvider().process({ prompt: 'hi', modelId: 'any' });
```

```
[lmstudio/PROVIDER_UNREACHABLE] fetch failed (ECONNREFUSED) — Nothing answered at http://localhost:1234/v1; check that it is running and the baseURL.
```
</details>

<details>
<summary><strong>7. Cloud model, no key</strong></summary>

```typescript
const res = await aiFactory.process({ prompt: 'hi', modelId: 'gpt-4o' });
```

```
[openai/NO_PROVIDERS] Provider "openai" (for model "gpt-4o") is not available: connection test failed (missing or rejected API key, or server not running) — Fix the openai setup, or pick a model from an available provider (ollama).
```
</details>

<details>
<summary><strong>8. Fallback</strong></summary>

A bad OpenAI key fails with `AUTH`, which is not retried; the request moves to Ollama. `gpt-4o` belongs to OpenAI, so the fallback uses its own default model instead of 404ing.

```typescript
const factory = new AIFactory({
  providers: [new OpenAIProvider({ apiKey: 'sk-not-a-real-key' }), new OllamaProvider({ models: ['gemma4:latest'] })],
  discover: 'lazy',
  fallbackProvider: 'ollama',
  logger: { warn: console.warn },
});
const res = await factory.process({ prompt: 'Say "fallback works" and nothing else.', modelId: 'gpt-4o' });
```

```
[warn] OpenAI failed (AUTH: Incorrect API key provided: sk-not-a*****-key. ...); trying the next provider
[warn] Ollama: model "gpt-4o" belongs to openai; using the default model instead
{ success: true, providerId: 'ollama', modelUsed: 'gemma4:latest', fallbackUsed: true, retryCount: 0, data: 'fallback works' }
```
</details>

<details>
<summary><strong>9. Abort and timeout</strong></summary>

```typescript
const abort = new AbortController();
for await (const chunk of aiFactory.processStream({ prompt: 'Write a long paragraph.', modelId: 'gemma4:latest', signal: abort.signal })) {
  if (chunk.type === 'text') partial += chunk.text;
  if (partial.length > 40) abort.abort();
}
// throws: { code: 'ABORTED', message: 'This operation was aborted' }   partial has 42 chars

const slow = await aiFactory.process({ prompt: 'Write a long essay.', modelId: 'gemma4:latest', timeout: 50 });
```

```
[ollama/TIMEOUT] Request timed out after 50ms — Raise the timeout, or use processStream for long answers.
retryCount: 2
```
</details>

---

## Providers

| Provider | Type | Streams | Tools | Schema | Images | `baseURL` | Notes |
|---------|------|:-:|:-:|:-:|:-:|:-:|--------|
| **Ollama** | Local | ✅ | ✅ | ✅ `format` | ✅ bytes only | ✅ | API + CLI; list/pull/rm/show/ps/run; tested |
| **LM Studio** | Local | ✅ | ✅ | ✅ | ✅ | ✅ | localhost:1234; OpenAI-compatible; tested |
| **OpenAI** | Cloud | ✅ | ✅ | ✅ `json_schema` | ✅ | ✅ | API key required |
| **Anthropic** | Cloud | ✅ | ✅ | system-prompt instruction, not native | ✅ | ✅ | API key required |
| **Gemini** | Cloud | ✅ | ✅ | ✅ `responseSchema` | ✅ | ✅ | API key required; tested |
| **Groq**, **OpenRouter**, **DeepSeek**, **Mistral**, **xAI**, **Together** | Cloud | ✅ | ✅ | host-dependent | host-dependent | ✅ | `OpenAICompatibleProvider` presets; API key required |
| Any OpenAI-compatible server (vLLM, llama.cpp, ...) | Either | ✅ | ✅ | host-dependent | host-dependent | ✅ | `new OpenAICompatibleProvider({ id, baseURL })` |

Every provider streams for real: SSE for the OpenAI dialect, Anthropic and Gemini; NDJSON for Ollama.

The factory probes providers per `discover` (default `'lazy'`, see [Discovery](#discovery)) and keeps those that pass the connection check. Use `getProvider('ollama')` (etc.) to use a specific one.

---

## Troubleshooting

Read `errorInfo.hint` first; it is generated for the specific failure and usually says exactly what to do next.

| Code | Hint |
|---|---|
| `NO_API_KEY` | Pass `{ apiKey }` to the provider, or set its environment variable. |
| `PROVIDER_UNREACHABLE` | Nothing answered at the configured `baseURL`; check that it is running. |
| `MODEL_NOT_FOUND` | The model id is unknown to the provider; check it, or call `discoverModels()` for the list. |

<details>
<summary><strong>Use a specific provider</strong></summary>

```typescript
const provider = aiFactory.getProvider('ollama');
if (provider) {
  const res = await provider.process({ prompt: 'Hello', modelId: 'llama3.1:8b' });
}
```
</details>

---

## Development

```bash
npm install && npm run build && npm test
npm run cli -- help
```

See **examples/** for more usage.

---

## License

MIT
