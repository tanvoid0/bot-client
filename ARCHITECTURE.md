# bot-client 2.0 — architecture and roadmap

Planning document. Goal: make `@tanvoid0/bot-client` a credible alternative to
Vercel AI SDK, token.js, multi-llm-ts and llm.js for people who want one small,
zero-dependency client for many LLM providers.

Status: Phases 1–3 done (1.7.0, 1.8.0, and 2.0.0 unreleased on main, all 2026-09-13). Phase 4 done except the unscoped-name decision (owner's call); then release 2.0.0.
Last updated 2026-09-13 against v1.8.0.

## 0. Next session starts here

Decisions during Phase 2 that change the plan:
- Presets are a `preset:` field plus a `PRESETS` table on `OpenAICompatibleProvider`, not six files. `agent-platform` (`http://127.0.0.1:18410/v1`, `AGENT_PLATFORM_KEY`) is in the table.
- `runOllamaCLI` / `isOllamaCLIAvailable` moved to `./ollama-cli`; `OllamaProvider` takes `cli: runOllamaCLI` by injection. The one 1.8 change that is not additive; called out in CHANGELOG.
- Factory-level `fetch` / `headers` not added (per-provider covers it). Hooks carry the `AIRequest`, not the wire body.
- Size: `.` is 17.0 kB gz after images and tools and will not meet 12 kB, because its `AIFactory` constructs all five providers when given none (zero config); re-exports were never the cost. `./core` (factory without defaults, 9.6 kB) plus one provider subpath is 11.5 kB, and that is the number the README should quote. The `.` entry's `AIFactory` is a subclass that overrides `defaults()`.
- Catalog routes `grok-`, `deepseek-chat|reasoner`, Mistral's `-latest`/`-YYMM` ids and Groq's `-versatile|-instant` ids; `vendor/model` ids stay unrouted (OpenRouter, Together, Groq all use them).

Phase 3 → 2.0.0 (breaking): §11 Phase 3 and §4. `messages[]` with images, tool calling with `maxSteps` and leaked `<function=>` recovery (§13.2), `schema` via Standard Schema, typed chunks with `legacyChunks`, `usage` replaces flat fields, `discover: 'lazy'` default, delete `@deprecated` types, drop provider re-exports from `.` if the size gate still matters, `MIGRATION.md`, Bun in CI.

Known gaps: Gemini `reasoning: false` sends nothing (2.5 Pro cannot disable thinking); OpenAI-format servers have no request-side reasoning toggle; CI publish needs a new `NPM_TOKEN` with 2FA bypass; `doctor` is not unit-tested (it is a network ping by design).

---

## 1. Where we stand

### 1.1 Competitor snapshot (Sept 2026)

| | Vercel AI SDK 6 | token.js | multi-llm-ts 5 | llm.js | **bot-client 1.6** |
|---|---|---|---|---|---|
| Providers | ~30 via packages | 200+ (OpenAI format) | ~20 | ~10 | 5 |
| Runtime deps | many (zod, ai-core, per-provider pkgs) | some | some | some | **0** |
| Streaming everywhere | yes | yes | yes | yes | Gemini + Ollama only |
| Tool calling | yes, agent loop | yes | yes | yes | no |
| Structured output | Zod `generateObject` | JSON mode | Zod | JSON mode | pass-through only |
| Images in | yes | yes | yes | yes | no |
| Typed error taxonomy | yes (`APICallError`, retryable) | partial | partial | partial | **no** (`code` never set) |
| Retry with backoff | yes | no | no | no | naive loop |
| Edge / browser / Workers | yes | yes | yes | yes | **no** (`child_process`, `string_decoder`) |
| Agent loop / multi-agent | `Agent` class, agents as tools | no | no | no | no |
| MCP client | via `@modelcontextprotocol/sdk` (deps) | no | no | no | no |
| Scheduled routines | no (host feature) | no | no | no | no |
| Embeddings | yes | no | yes | yes | no |
| Local-first (Ollama, LM Studio) zero config | no | no | partial | yes | **yes** |
| Ollama management (pull/list/rm/ps) | no | no | no | no | **yes** |
| npx CLI | no | no | no | no | **yes** |

What we can own: **smallest correct multi-provider client**. Zero deps, one file
per provider, local-first, honest errors, real numbers on overhead. Nobody else
leads with "local Ollama works with no config, cloud works with one env var, and
the error you get back is the provider's own message plus what to do about it".

Sources: [AI SDK 6 deep dive](https://www.digitalapplied.com/blog/vercel-ai-sdk-6-deep-dive-features-tool-calls-2026),
[AI SDK 5 blog](https://vercel.com/blog/ai-sdk-5),
[token.js](https://github.com/token-js/token.js),
[multi-llm-ts](https://github.com/nbonamy/multi-llm-ts/),
[LLM.js](https://llmjs.themaximalist.com/),
[@unified-llm/core](https://www.npmjs.com/package/@unified-llm/core).

### 1.2 Defects found in 1.6.0 (all reproducible from source)

| # | Defect | Where | Effect |
|---|---|---|---|
| D1 | Provider discovery runs **sequentially** and probes all five providers on first call | `ai-factory.ts` `initializeProviders` | First request waits for every probe; worst case 5 × 30 s timeout |
| D2 | `BaseProvider.testConnection` sends a real `Hello` generation. Anthropic inherits it | `base-provider.ts` | Every process start costs a paid Claude call, slow init |
| D3 | Anthropic `discoverModels` returns `[]`, so `modelId: 'claude-…'` never routes to Anthropic; falls to first provider, which 404s | `anthropic-provider.ts`, `resolveProvider` | Silent misrouting |
| D4 | Provider `process()` **throws** `AIError` on HTTP failure; factory `process()` never catches, so `retries` and `fallbackProvider` only fire on the `success:false` path (missing key) | `ai-factory.ts` `process` | Retry/fallback do not work for real failures |
| D5 | `retries` loop retries non-retryable failures (missing key, 400, 401) with no delay | `ai-factory.ts` | Wasted calls, rate-limit amplification |
| D6 | `AIError.code` and `statusCode` are never populated; `Retry-After`, request id, provider error `type` dropped | `handleError` | Callers cannot branch on error kind |
| D7 | OpenAI, Anthropic, LM Studio "stream" as one chunk | providers | Not competitive; README admits it |
| D8 | Streams have **no idle timeout**; a stalled upstream hangs forever unless caller aborts | `httpStream`, `timeout: 0` | Hung workers in production |
| D9 | `node:string_decoder` in core, `child_process` reachable from `.` entry | `base-provider.ts`, `ollama-cli.ts` | Cannot run in browser, Workers, Deno without shims |
| D10 | `processingTime: 0`, `confidence: 0.8` hard-coded | `createResponse` | Fake metrics in every response |
| D11 | ~120 lines of exported dead types (`PostProcessingOptions`, `ModelCapabilities`, `ProcessingMetrics`, `ContentGenerationRequest`, `usageContext`, `ProviderConfig`) | `types/index.ts` | Confusing API surface, larger `.d.ts` |
| D12 | OpenAI and LM Studio duplicate the same OpenAI-format code; no generic OpenAI-compatible provider | providers | Cannot point at Groq, OpenRouter, DeepSeek, Mistral, xAI, Together, vLLM without a new class |
| D13 | Gemini streaming skips unparsable frames silently; Gemini `finishReason: SAFETY` / `MAX_TOKENS` in a 200 body is reported as success | `gemini-provider.ts` | Truncated or blocked answers look fine |
| D14 | Ollama `process` with no models sends `model: undefined` | `ollama-provider.ts` | Opaque upstream error instead of "no model" |

---

## 2. Design principles (do not violate)

1. **Zero runtime dependencies.** Schema validation via the
   [Standard Schema](https://standardschema.dev) interface (`~standard`), which
   Zod 3.24+, Valibot and ArkType all implement. We never import them.
2. **Core entry runs anywhere `fetch` does.** Node 18+, Bun, Deno, Cloudflare
   Workers, browsers. Node-only code (`child_process`, `fs`) lives behind
   subpath exports.
3. **Provider errors are surfaced, never rewritten.** `message` is the
   provider's own text. We add classification and a hint, we do not replace.
4. **One code path for stream and non-stream** per provider. The non-stream
   call is the stream drained, not a second implementation.
5. **Measured, not claimed.** Overhead and time-to-first-token numbers come
   from `bench/` and go in the README with the command that produced them.
6. **Fewest files.** One file per provider. Shared logic in `core/`.

---

## 3. Target layout

```
src/
  index.ts                 public API (no node built-ins)
  core/
    client.ts              AIFactory: routing, retry, fallback, hooks
    errors.ts              AIError taxonomy + per-provider classifiers
    http.ts                fetch wrapper: timeout, idle timeout, custom fetch, SSE/NDJSON parsers (TextDecoder)
    retry.ts               backoff with jitter, honours Retry-After
    messages.ts            request → normalized message list (text + images + tool results)
    schema.ts              Standard Schema / JSON Schema detection, parse, validate
    tools.ts               tool definitions, tool-call loop (maxSteps)
    catalog.ts             static model → provider prefix table (no network needed to route)
  providers/
    base.ts                Provider interface + shared helpers
    openai-compatible.ts   generic {id, baseURL, apiKey} provider; streams SSE; tools; images
    openai.ts              subclass: default base, env key, model filter
    lmstudio.ts            subclass: localhost:1234, no key
    groq.ts, openrouter.ts, deepseek.ts, mistral.ts, xai.ts, together.ts   (each ≤ 20 lines)
    anthropic.ts           Messages API: SSE, tools, images, baseURL
    gemini.ts              generateContent: SSE, tools, images, finishReason
    ollama.ts              /api/chat: NDJSON, tools, images; management API (pull/list/rm/show/ps)
  agent/                   (§7b; each a subpath export, none imported by core)
    agent.ts               Agent: system prompt + tools + model + maxSteps; asTool(); handoff
    session.ts             Session: message store, token-budget truncation, pluggable Store
    mcp.ts                 MCP client: Streamable HTTP transport (fetch); tools/resources/prompts → Tool[]
    mcp-stdio.ts           MCP stdio transport (node-only)
    routine.ts             Routine: named agent run on an interval or 5-field cron, overlap guard, Store
    embed.ts               embed(): OpenAI-compatible, Gemini, Ollama; cosine helper
    cost.ts                estimateCost(usage, model): static price table with date
  node/
    ollama-cli.ts          child_process helpers (subpath export only)
    cli.ts                 bin: ollama, keys, doctor
```

`package.json` `exports`:

```
"."                    core + all providers (tree-shakeable, sideEffects:false)
"./openai" "./anthropic" "./gemini" "./ollama" "./lmstudio" "./openai-compatible"
"./agent" "./session" "./mcp" "./routine" "./embed" "./cost"
"./mcp-stdio" "./ollama-cli"    node-only
```

---

## 4. Public API (2.0)

Names stay (`AIFactory`, `aiFactory`, `process`, `processStream`, `generate`)
so 1.x users migrate by reading a short list, not rewriting.

### 4.1 Request

```ts
interface AIRequest {
  prompt?: string;                       // shorthand for last user message
  messages?: Message[];                  // full control; replaces history+prompt
  systemPrompt?: string;
  modelId?: string;                      // 'gpt-4o' | 'openai/gpt-4o' | 'anthropic:claude-…'
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  jsonMode?: boolean;
  schema?: StandardSchema | JsonSchema;  // structured output; parsed + validated result on `response.object`
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxSteps?: number;                     // tool loop; default 1 (no auto-execute)
  signal?: AbortSignal;
  timeout?: number;                      // whole request, ms
  streamIdleTimeout?: number;            // ms since last byte, default 60_000
  providerOptions?: Record<string, unknown>; // escape hatch, merged into provider body
  metadata?: Record<string, unknown>;
}

type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<TextPart | ImagePart> }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

interface ImagePart { type: 'image'; url?: string; data?: Uint8Array | string; mimeType: string }
interface Tool { name: string; description?: string; parameters: JsonSchema | StandardSchema; execute?: (args, ctx: { signal?: AbortSignal }) => Promise<unknown> }
```

`history` kept as a deprecated alias for `messages` in 2.0, removed in 3.0.

### 4.2 Response

```ts
interface AIResponse {
  success: boolean;
  data?: string;                  // text
  object?: unknown;               // parsed when `schema` given
  toolCalls?: ToolCall[];
  steps?: Step[];                 // when maxSteps > 1
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';
  usage?: TokenUsage;
  modelUsed?: string;
  providerId?: string;
  requestId?: string;             // from provider headers
  durationMs: number;
  timeToFirstTokenMs?: number;    // streams only
  error?: AIError;                // structured, when success === false
  retryCount: number;
  fallbackUsed: boolean;
  raw?: unknown;                  // provider body, opt-in via factory { includeRaw: true }
}
```

Removed: `tokensUsed/promptTokens/completionTokens` flat fields (use `usage`),
`confidence`, `cost`, `modelCapabilities`, `suggestedImprovements`,
`processingTime` (→ `durationMs`), `timestamp`.

### 4.3 Stream chunk

```ts
type AIStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'done'; finishReason; usage?; modelUsed; requestId?; durationMs; timeToFirstTokenMs };
```

1.x shape (`{ text, done, usage }`) kept via a `legacyChunks: true` factory flag
for one major. Errors mid-stream throw `AIError`.

### 4.4 Factory config

```ts
interface AIFactoryConfig {
  providers?: AIProvider[];
  defaultProvider?: string;
  fallbackProviders?: string[];        // was fallbackProvider (string); array now, tried in order
  providerOrder?: string[];
  retry?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; on?: AIErrorCode[] };
  timeout?: number;                    // default per request
  streamIdleTimeout?: number;
  discover?: 'lazy' | 'eager' | 'none'; // 1.x default 'eager' (parallel, cheap); 2.0 flips to 'lazy'
  fetch?: typeof fetch;                // custom fetch (proxies, tests, undici Agent)
  headers?: Record<string, string>;    // added to every provider request
  logger?: Logger;
  hooks?: {
    onRequest?(ctx: { provider; model; body }): void | Promise<void>;
    onResponse?(ctx: { provider; model; response; durationMs }): void | Promise<void>;
    onError?(ctx: { provider; model; error: AIError; willRetry: boolean }): void | Promise<void>;
  };
  includeRaw?: boolean;
  legacyChunks?: boolean;
}
```

Every provider constructor accepts `{ apiKey?, baseURL?, headers?, fetch?, timeout?, models? }`.
`models` seeds the supported list so no discovery call is needed.

### 4.5 Routing

`modelId` resolution order, no network:

1. Explicit prefix: `openai/gpt-4o`, `anthropic:claude-…`, `ollama/llama3`.
2. Static catalog prefix table in `core/catalog.ts` (`gpt-`, `o1`, `o3` → openai;
   `claude-` → anthropic; `gemini-` → gemini; `llama`, `mistral:`, `*:*b` → ollama, …).
3. Discovered model lists (only providers already probed).
4. `defaultProvider`, then `providerOrder`, then first registered.

Fixes D3 without a network call.

---

## 5. Error handling (the headline feature)

### 5.1 `AIError`

```ts
class AIError extends Error {
  code: AIErrorCode;
  provider: string;
  model?: string;
  status?: number;          // HTTP
  providerCode?: string;    // provider's own type/code string, verbatim
  message: string;          // provider's own message, verbatim, prefixed with nothing
  hint?: string;            // one sentence: what to do next
  retryable: boolean;
  retryAfterMs?: number;    // from Retry-After / provider body
  requestId?: string;
  raw?: unknown;            // parsed body or text
  cause?: unknown;          // underlying fetch/abort error
}

type AIErrorCode =
  | 'NO_API_KEY' | 'AUTH' | 'PERMISSION' | 'QUOTA'         // not retryable
  | 'RATE_LIMIT' | 'OVERLOADED' | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'STREAM_IDLE'   // retryable
  | 'ABORTED'                                             // caller cancelled
  | 'MODEL_NOT_FOUND' | 'CONTEXT_LENGTH' | 'INVALID_REQUEST' | 'UNSUPPORTED'   // fix the request
  | 'CONTENT_FILTER' | 'TRUNCATED' | 'INVALID_JSON' | 'SCHEMA_MISMATCH'        // output problems
  | 'PROVIDER_UNREACHABLE' | 'NO_PROVIDERS' | 'NO_MODEL'
  | 'TOOL_ERROR' | 'MCP_ERROR'                            // tool execute threw / JSON-RPC error (§7b)
  | 'INVALID_RESPONSE' | 'UNKNOWN';
```

### 5.2 Classification table

Each provider file owns a `classify(status, headers, body): Partial<AIError>`.
Anything unmatched falls through to the status-code default.

| Signal | OpenAI / compatible | Anthropic | Gemini | Ollama | → code |
|---|---|---|---|---|---|
| 401 | `invalid_api_key` | `authentication_error` | 400 `API_KEY_INVALID` reason | — | `AUTH` |
| 403 | | `permission_error` | `PERMISSION_DENIED` | — | `PERMISSION` |
| 429 | `insufficient_quota` | — | `RESOURCE_EXHAUSTED` + quota text | — | `QUOTA` (not retryable) |
| 429 | `rate_limit_exceeded` | `rate_limit_error` | `RESOURCE_EXHAUSTED` | — | `RATE_LIMIT` |
| 529 / 503 | 503 | `overloaded_error` | `UNAVAILABLE` | — | `OVERLOADED` |
| 5xx | | `api_error` | `INTERNAL` | 500 | `SERVER` |
| 404 / model | `model_not_found` | `not_found_error` | `NOT_FOUND` | `model '…' not found, try pulling it first` | `MODEL_NOT_FOUND` (Ollama hint: `ollama pull <model>`) |
| 400 + context | `context_length_exceeded` | `prompt is too long` | `INVALID_ARGUMENT` + token text | `context length` | `CONTEXT_LENGTH` |
| 400 other | `invalid_request_error` | `invalid_request_error` | `INVALID_ARGUMENT` | 400 | `INVALID_REQUEST` |
| 200 body | `finish_reason: content_filter` | `stop_reason: refusal` | `finishReason: SAFETY` / `promptFeedback.blockReason` | — | `CONTENT_FILTER` |
| 200 body | `finish_reason: length` | `stop_reason: max_tokens` | `finishReason: MAX_TOKENS` | `done_reason: length` | `finishReason: 'length'` (+ `TRUNCATED` only when `schema`/`jsonMode` set) |
| socket | `ECONNREFUSED` / `ENOTFOUND` | same | same | `ECONNREFUSED :11434` | `PROVIDER_UNREACHABLE` (Ollama hint: `ollama serve`) |
| `Retry-After` header | seconds or date | seconds | in body `retryDelay` | — | `retryAfterMs` |
| request id header | `x-request-id` | `request-id` | none | none | `requestId` |

Hints are the one sentence a user needs, e.g.
`NO_API_KEY` → "Set OPENAI_API_KEY or pass { apiKey } to OpenAIProvider."
`CONTEXT_LENGTH` → "Shorten messages or lower maxTokens; model limit is N." (N when the body states it).

### 5.3 Retry policy

- Only on `retryable === true` and only for non-stream calls (stream policy unchanged: no retry once bytes were yielded; retry allowed before first byte).
- Delay = `min(maxDelay, baseDelay × 2^attempt) ± 20% jitter`, overridden by `retryAfterMs` when present.
- Defaults: `retries: 2, baseDelayMs: 500, maxDelayMs: 8000`. `retries: 0` opts out.
- Fallback providers tried after retries exhaust, and immediately (no retry) on `NO_API_KEY`, `MODEL_NOT_FOUND`, `PROVIDER_UNREACHABLE`, `UNSUPPORTED`.
- `AIResponse.retryCount` and `fallbackUsed` always set (fixes D4, D5).

### 5.4 Contract

- `generate()` throws `AIError`.
- `process()` returns `{ success: false, error: AIError }`, never throws for provider failures. Throws only for programmer errors (bad arguments).
- `processStream()` throws `AIError` from the iterator.
- `error.message` is the provider text; `String(error)` renders `[provider/code] message — hint`.

---

## 6. Performance

### 6.1 Changes

| Item | Now | Target | Fixes |
|---|---|---|---|
| Discovery | sequential, all providers, paid probe | `'eager'` (1.x default) probes all providers in parallel and never sends a generation to probe (`GET /models`); `'lazy'` (2.0 default) touches no network until a provider is chosen; `'none'` never probes | D1, D2 |
| Model routing | needs discovered lists | static catalog first (§4.5); discovery optional | D3 |
| Streaming | 2 of 5 real | all providers real SSE/NDJSON via one parser in `core/http.ts` | D7 |
| Decoder | `node:string_decoder` | `TextDecoder('utf-8', { stream: true })` (web standard, same correctness on split multibyte) | D9 |
| Idle timeout | none | `streamIdleTimeout` default 60 s, reset on every byte; `AbortController` per request | D8 |
| Connection reuse | undici default keep-alive | unchanged; document `fetch` option for custom `Agent` (pool size, proxy) | — |
| Metrics | fake | `durationMs`, `timeToFirstTokenMs` measured with `performance.now()` | D10 |
| Model list cache | re-fetched per `discoverModels` | in-memory with `modelCacheTtlMs` (default 5 min) | — |
| Bundle | one entry, `child_process` reachable | `sideEffects: false`, subpath exports, core entry has no node built-ins | D9 |
| Retries | tight loop, no delay | backoff, capped, only retryable | D5 |

### 6.2 Targets and how they are measured

`bench/` (not published) starts a local `node:http` mock that replays recorded
provider bodies, then measures the client against raw `fetch` on the same mock.

| Metric | Target | Command |
|---|---|---|
| Per-call overhead above raw `fetch` (non-stream) | < 1 ms p50, < 3 ms p99 | `npm run bench:overhead` |
| Streaming overhead per chunk | < 0.05 ms | `npm run bench:stream` |
| Memory for a 1 MB streamed answer | flat (delta yielded, not accumulated) | `npm run bench:stream -- --size 1mb` |
| Cold `import` of core entry | < 15 ms, zero network | `npm run bench:import` |
| First request with `discover: 'lazy'` and `modelId` prefix | one upstream call, zero probes | asserted in tests |
| Published size (`.` entry, minified, gz) | < 12 kB | `npm run size` (`esbuild --bundle --minify | gzip -c | wc -c`, no new dep) |

Numbers go into the README perf section with date and Node version.

### 6.3 Cross-runtime

CI matrix adds `bun test` and a Workers smoke (`workerd` via `npx wrangler dev`
is heavy; instead a `tests/runtime-web.test.ts` that imports `.` with
`--conditions=browser`-style checks: no `node:` specifiers, no `process.env`
access outside a `typeof process !== 'undefined'` guard).

---

## 7. Customisation surface

| Need | 1.6 | 2.0 |
|---|---|---|
| Custom base URL | OpenAI, Ollama, LM Studio only | every provider (Anthropic via proxies/Bedrock gateways, Gemini via Vertex-compatible gateways) |
| Custom headers | none | provider-level and factory-level |
| Custom `fetch` | none | provider and factory (`fetch` option): proxies, undici `Agent`, test mocks, tracing |
| Provider-specific params | none | `providerOptions` merged last into the body |
| Any OpenAI-format host | new class needed | `new OpenAICompatibleProvider({ id: 'groq', baseURL, apiKey })` plus 6 shipped thin presets |
| Lifecycle hooks | logger only | `hooks.onRequest / onResponse / onError` |
| Model catalog | discovered only | `models: [...]` seed, static catalog, `discover` mode |
| Timeouts | 30 s fixed, streams none | per factory, per provider, per request; idle timeout |
| Response format | raw string | `jsonMode`, `schema` (Standard Schema or JSON Schema) with parsed `object` |
| Tools | none | `tools[]`, `toolChoice`, `maxSteps`; `execute` optional so caller may run tools themselves |

---

## 7b. Agent layer (MCP, agents, routines, day-to-day)

Everything here builds on §4 `tools` + `maxSteps`. No new provider code. Each
module is a subpath export so `.` stays under the §6.2 size gate. Still zero
runtime dependencies: MCP is JSON-RPC over `fetch` (Streamable HTTP) or stdio;
we do not import `@modelcontextprotocol/sdk`.

### 7b.1 Agent

```ts
import { Agent } from '@tanvoid0/bot-client/agent';

const researcher = new Agent({
  name: 'researcher',
  model: 'anthropic/claude-sonnet-5',
  system: 'You research. Cite sources.',
  tools: [search, fetchPage],
  maxSteps: 8,
  factory?: AIFactory,                 // default: shared aiFactory
  onStep?(step): void,                 // observe tool calls + results
});

const out = await researcher.run('Compare X and Y');     // AIResponse (+ steps[])
for await (const chunk of researcher.stream('…')) { … }
```

`Agent.run` = `factory.process({ messages, tools, maxSteps })` with the agent's
defaults merged. The whole class is a config holder plus two methods. Deliberate:
no planner, no memory magic, no graph runtime.

### 7b.2 Multi-agent

Two primitives, both ~30 lines, cover supervisor, router and pipeline patterns:

- **Agent as tool.** `researcher.asTool({ description })` returns a `Tool` whose
  `execute` runs the agent and returns its text. A supervisor agent lists
  sub-agents in `tools`; the model decides who to call. This is the pattern
  Vercel AI SDK 6 and OpenAI Agents SDK converge on.
- **Handoff.** `handoff(to: Agent)` returns a tool that, when called, ends the
  current loop and continues the same session with `to`. `Agent.run` returns
  `handedOffTo` so callers can follow the chain.

Parallel fan-out is `Promise.all(agents.map(a => a.run(...)))`; no helper needed.

### 7b.3 Session (conversation memory)

```ts
import { Session, MemoryStore } from '@tanvoid0/bot-client/session';

const session = new Session({ id: 'user-42', store: new MemoryStore(), maxTokens: 32_000 });
await session.send(agent, 'hello');          // appends user + assistant + tool messages
```

- `Store` interface: `get(id): Promise<Message[]>`, `set(id, messages)`.
  `MemoryStore` ships; Redis/SQLite/file are user-written in ten lines.
- Truncation: drop oldest non-system messages until under `maxTokens`, using
  the provider's last reported `usage.promptTokens` as the estimate, falling
  back to `chars / 4`. No tokenizer dependency.
- Optional `summarize: true` replaces dropped turns with one model-written
  summary message.

### 7b.4 MCP client

```ts
import { McpClient } from '@tanvoid0/bot-client/mcp';

const mcp = await McpClient.connect({ url: 'https://mcp.example.com/mcp', headers });
const tools = await mcp.tools();             // Tool[] with execute → tools/call
const agent = new Agent({ tools: [...tools, ...local] });
```

- Protocol: JSON-RPC 2.0. Methods: `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`, `resources/list`, `resources/read`,
  `prompts/list`, `prompts/get`, `ping`. Server-initiated messages are read
  from the SSE half of Streamable HTTP with the same `parseSSE` from `core/http.ts`.
- Transports: Streamable HTTP (`fetch`, any runtime); stdio in
  `./mcp-stdio` (node-only, `child_process`, newline-delimited JSON).
- Tool schemas are the server's JSON Schema, passed straight through to the
  provider; results (`content[]` text/image) are flattened to a string, images
  kept as `ImagePart` for providers that accept them.
- Errors map to `AIError` with code `MCP_ERROR`, `providerCode` = JSON-RPC code, message verbatim.
- Sampling and roots: not implemented; reported as `UNSUPPORTED` if a server requests them.

### 7b.5 Routines

```ts
import { Routine } from '@tanvoid0/bot-client/routine';

const digest = new Routine({
  name: 'daily-digest',
  every: '0 8 * * *',                 // 5-field cron, or '15m' / '2h' durations
  run: () => agent.run('Summarise yesterday'),
  store?: Store,                      // persists last run time + last result
  onResult?(r): void,
  onError?(e: AIError): void,
  timeout?: number,
});
digest.start(); digest.stop(); await digest.runNow();
```

- In-process only: `setTimeout` scheduling, overlap guard (a run that overruns
  its interval skips the next tick), `AbortSignal` on stop.
- `store` makes missed runs visible after restart (`lastRunAt`, `lastResult`);
  catch-up is opt-in (`catchUp: true` runs once immediately if the last run is
  older than one interval).
- Cron parser is the 5-field subset (min hour dom mon dow, `*`, `,`, `-`, `/`).
  About 60 lines; no library.
- Not a distributed scheduler. Multi-instance deployments put a lock in their
  own `Store` implementation. Documented as such.

### 7b.6 Day-to-day helpers

| Need | Shape | Where |
|---|---|---|
| Embeddings | `embed(texts, { model })` → `number[][]`; `cosine(a, b)` | `./embed`, providers: OpenAI-compatible `/v1/embeddings`, Gemini `embedContent`, Ollama `/api/embed` |
| Cost estimate | `estimateCost(usage, model)` → USD from a dated static table; returns `undefined` for unknown models | `./cost`; table refreshed each release, date in the export |
| Prompt caching | `providerOptions` passthrough (`cache_control` for Anthropic); `usage.cachedTokens` surfaced when the provider reports it | core |
| Concurrency limit | factory `concurrency?: number` (inline semaphore, ~15 lines) | core |
| Structured extraction | `schema` on any request (§4.1) | core |
| Cancellation | `signal` everywhere, propagates into tool `execute` and MCP calls | core |
| Observability | `hooks` (§4.4) carry enough to emit OpenTelemetry spans; no OTel import | core |
| Token counting | not shipped; `usage` from the provider is the truth. Documented. | — |
| Guardrails / evals | not shipped; out of scope for a client. Documented. | — |

---

## 8. Readability

- Delete dead types (D11). `types/index.ts` becomes the request/response/error
  types only; ~90 lines.
- `OpenAICompatibleProvider` absorbs OpenAI and LM Studio (D12); each preset is
  a constructor default block.
- One `parseSSE` and one `parseNDJSON` in `core/http.ts`; providers only map
  frames to chunks.
- Every provider file has the same four sections in the same order:
  `config`, `classify`, `toBody`, `fromFrame`. Reviewer can diff providers side by side.
- JSDoc on every exported symbol (typedoc already wired).
- `CONTRIBUTING.md`: "adding a provider" is a 40-line checklist with a template.

---

## 9. Tests

- `fetch` injection makes provider tests pure: `tests/fixtures/<provider>/` holds
  recorded real bodies for success, each error row in §5.2, and stream transcripts
  (with split multibyte characters across frames).
- One table-driven test asserts the whole classification table.
- Retry test uses fake timers and asserts delay sequence and `Retry-After` precedence.
- Idle-timeout test: mock stream that stalls, expects `STREAM_IDLE` after N ms.
- Routing test: every catalog prefix resolves without network.
- Integration (opt-in, env-gated): Ollama and LM Studio as today; cloud providers
  behind `BOT_CLIENT_LIVE=1`.
- CI: Node 18/20/22 + Bun; `npm run size` gate; typedoc build must pass.

---

## 10. SEO and discoverability

### 10.1 package.json

- `description`: "Zero-dependency TypeScript client for OpenAI, Anthropic, Gemini, Ollama, LM Studio, Groq, OpenRouter, DeepSeek, Mistral and any OpenAI-compatible API. Streaming, tool calling, structured output, typed provider errors, retries. Node, Bun, Deno, edge."
- `keywords` (npm search weights these): `llm`, `llm-client`, `ai-sdk`, `unified-llm-api`, `openai`, `anthropic`, `claude`, `gemini`, `ollama`, `lmstudio`, `groq`, `openrouter`, `deepseek`, `mistral`, `xai`, `openai-compatible`, `streaming`, `tool-calling`, `function-calling`, `structured-output`, `json-schema`, `zero-dependency`, `edge`, `cloudflare-workers`, `bun`, `deno`, `typescript`, `chatgpt`, `vercel-ai-sdk-alternative`, `langchain-alternative`.
- `homepage` → docs site (GitHub Pages from typedoc, `docs` script exists).
- `sideEffects: false`, `exports` subpaths, `funding` optional.
- Consider an **unscoped name** (`botclient`, `llm-client`, `anyllm`): scoped
  personal packages rank lower and read as hobby projects. Publish the unscoped
  name as the primary, keep `@tanvoid0/bot-client` as a re-export shim for one
  major. Owner's call; not blocking.

### 10.2 GitHub

- Repo description = package description; topics = keywords above.
- `llms.txt` at repo root and docs site (agents index it; cheap).
- Pin a comparison table in the README (§1.1 style, honest, with dates).
- Enable GitHub Pages from `docs/` on release; link from README badge.
- Social preview image (1280×640) with the one-liner.

### 10.3 README structure (inverted pyramid)

1. Name + one-liner with the search terms in the first sentence.
2. Badges: CI, npm version, downloads, bundle size, types, zero deps, license.
3. "Why" in five bullets.
4. 10-line quick start (local Ollama, then one env var for cloud).
5. Provider matrix (stream / tools / schema / images / baseURL / status).
6. Streaming, tools, structured output, errors, retries: one snippet each.
7. Performance table with the `bench/` command.
8. Comparison table.
9. Customisation reference (collapsed).
10. CLI (collapsed).
11. Migration 1.x → 2.0 link, changelog, contributing, license.

---

## 11. Roadmap and order of work

Each phase ships. Phases 1 and 2 are non-breaking and can go out as 1.7 / 1.8
if a 2.0 is not ready.

### Phase 1 — reliability and performance (non-breaking, target 1.7.0)

- [x] `core/errors.ts` with taxonomy, classifiers, hints; `handleError` populates `code`, `status`, `providerCode`, `retryable`, `retryAfterMs`, `requestId` (D6)
- [x] Factory `process()` catches provider throws; retry with backoff on retryable only; fallback per §5.3 (D4, D5)
- [x] Static model catalog + prefix routing (D3)
- [x] Parallel discovery; no generation probe; `discover` option (`eager` stays default in 1.x; `lazy` becomes default in 2.0) (D1, D2)
- [x] `TextDecoder` replaces `string_decoder`; `parseSSE` / `parseNDJSON` in `core/http.ts` (D9 part)
- [x] Real streaming for OpenAI, LM Studio (shared SSE), Anthropic (event stream) (D7)
- [x] `streamIdleTimeout` (D8)
- [x] `durationMs`, `timeToFirstTokenMs`; drop `confidence` (D10, additive: keep old fields in 1.x)
- [x] `finishReason` on responses and done-chunk; Gemini SAFETY / MAX_TOKENS surfaced (D13); Ollama `NO_MODEL` (D14)
- [x] `bench/` scripts and first numbers (2026-09-13: overhead below noise, 7.6 µs/chunk, 9.8 ms cold import, 13.5 kB gz after reasoning support; 1.5 kB over target, Phase 2 subpath exports bring `.` back under, see bench/RESULTS.md)
- [x] Fixture-driven provider tests for every row of §5.2 (2026-09-13: filled the missing cells; found and fixed OpenAI/Anthropic empty-refusal-as-success and Gemini daily-quota-as-RATE_LIMIT)

### Phase 2 — customisation (non-breaking, target 1.8.0)

- [x] `OpenAICompatibleProvider` + presets: groq, openrouter, deepseek, mistral, xai, together, agent-platform (`preset:` config field and a `PRESETS` table, not one file each); OpenAI and LM Studio re-based on it (D12)
- [x] `baseURL`, `headers`, `fetch`, `timeout`, `models`, `modelCacheTtlMs` on every provider; factory `timeout`. Factory-level `fetch` / `headers` skipped: providers are constructed before the factory sees them, and per-provider `fetch` / `headers` cover it.
- [x] `providerOptions` passthrough (`mergeBody`, one level deep)
- [x] `hooks` (`onRequest` / `onResponse` / `onError` with `willRetry`); the factory-level ctx carries the `AIRequest`, not the wire body — wrap `fetch` for bytes
- [x] Subpath exports, `sideEffects: false`, `ollama-cli` moved under `./ollama-cli`; core entry free of node built-ins, enforced by `tests/phase2.test.ts` bundling every entry with esbuild `--platform=browser` (D9). `OllamaProvider` takes `cli: runOllamaCLI` by injection.
- [x] `bot-client doctor` CLI: lists models, then sends a 16-token prompt per provider (a `/models` 200 does not prove chat works; the ping surfaces `NO_MODEL`, `NO_API_KEY`, `PROVIDER_UNREACHABLE` through the existing classifier)

### Phase 3 — capability parity (2.0.0, breaking)

- [x] `messages[]` with image parts; `history` deprecated (2026-09-13: `prompt` optional, `Message` union without tool roles yet — those land with tool calling; `.` is 14.9 kB gz after this)
- [x] Tool calling on OpenAI-compatible, Anthropic, Gemini, Ollama; `maxSteps` loop in `core/tools.ts` (2026-09-13). Deviations: `tool` messages carry `name` (Gemini and Ollama key results by name, not id); leaked `<function=>` recovery is on whenever `tools` are offered, no flag, one-shot only (a stream has already shown the text); no `capabilities()` probe yet, Ollama's own 400 maps to `UNSUPPORTED`. Stream loop yields intermediate calls as `{ text: '', toolCalls }` until typed chunks land. `.` is 17.1 kB gz after this; dropping provider re-exports from `.` is now due.
- [x] `schema` via Standard Schema / JSON Schema; `object` on response; `SCHEMA_MISMATCH` / `INVALID_JSON` (2026-09-13). `object` is `unknown`, not inferred from the schema's output type; a plain JSON Schema is sent but not validated locally (no validator, zero deps); streams ignore `schema`. `./core` + `./openai` is 12,058 B gz after this.
- [x] Typed stream chunks (2026-09-13). Clean union, no `legacyChunks` flag and no 1.x fields: a 1.x-shaped chunk from a custom provider throws `INVALID_RESPONSE` with a hint. `tool-call` chunks per completed call before `done`.
- [x] `discover` default flips to `'lazy'` (2026-09-13)
- [x] Reasoning/thinking chunks: shipped in 1.7.0 as `reasoning` deltas; now `{ type: 'reasoning' }` chunks.
- [x] `usage` object replaces flat token fields; remove dead types (D11) (2026-09-13; `history` / `responseSchema` / `usageContext` removed too, each failing `INVALID_REQUEST` with a hint rather than being ignored)
- [x] `MIGRATION.md` 1.x → 2.0 (2026-09-13; the runtime hints point at it)
- [x] Bun in CI; web-runtime test (2026-09-13: `scripts/smoke.mjs` runs the built package through an injected `fetch` on Node and Bun; the browser-bundle purity test in `tests/phase2.test.ts` is the web-runtime gate)

### Phase 4 — docs and SEO (with 2.0.0 release)

- [x] README rewrite per §10.3 and §12 (2026-09-13: one-sentence hero, five "Why" bullets, dated comparison table, Development → CONTRIBUTING)
- [x] package.json metadata per §10.1; `llms.txt` (2026-09-13; `MIGRATION.md` and `llms.txt` added to `files`). GitHub topics: set in the repo settings by hand, not tracked here
- [x] Docs site from typedoc on GitHub Pages (`.github/workflows/docs.yml`, `typedoc.json`); `homepage` updated (2026-09-13)
- [x] `CONTRIBUTING.md` with provider template (2026-09-13)
- [ ] Decide on unscoped name (2026-09-13 check: `botclient` and `any-llm` taken; `llm-client` and `anyllm` free on npm)

### Phase 5 — agent layer (2.1.0, additive)

- [ ] `./agent`: `Agent`, `asTool`, `handoff`, `onStep`
- [ ] `./session`: `Session`, `Store`, `MemoryStore`, token-budget truncation, optional summarize
- [ ] `./mcp`: Streamable HTTP client, `tools()`, `resources()`, `prompts()`; `MCP_ERROR` code
- [ ] `./mcp-stdio`: stdio transport (node-only)
- [ ] `./embed` for OpenAI-compatible, Gemini, Ollama; `cosine`
- [ ] `./cost` with dated price table
- [ ] `concurrency` on factory; `usage.cachedTokens`
- [ ] Tests: MCP against a 40-line mock server (`node:http`), agent loop with fake provider, handoff chain, session truncation

### Phase 6 — routines (2.2.0, additive)

- [ ] `./routine`: interval + 5-field cron, overlap guard, `Store` persistence, `catchUp`
- [ ] Fake-timer tests for cron next-run, overlap skip, catch-up
- [ ] `bot-client routine run <file>` CLI helper (node-only) for cron/systemd users

Estimated size: Phase 1 ≈ 600 lines changed, Phase 2 ≈ 400, Phase 3 ≈ 900, Phase 4 docs only, Phase 5 ≈ 700, Phase 6 ≈ 250.
Agent cap per user rules: at most 4 concurrent; run gates (`npm run build && npm test && npm run lint`) inline between batches.

---

## 12. README update checklist (run after each phase lands)

Tick when the README reflects reality. Do not tick early; the README is the product page.

**After Phase 1**
- [x] Hero line: add "typed provider errors, retries with backoff, real streaming on every provider"
- [x] Providers table: Streams column all ✅; add `finishReason` mention
- [x] New section "Errors": `AIError` fields, `code` list, one `switch (err.code)` example, one printed `String(err)` example showing provider message + hint
- [x] New section "Retries and fallback": defaults, `retry` config, what is and is not retried, stream rule
- [x] Streaming section: remove "one chunk" paragraph; add `streamIdleTimeout` and `timeToFirstTokenMs`
- [x] New section "Performance": table from §6.2 with `TBD` placeholders (no `doctor`/bench numbers yet), Node version, date, and the bench command
- [x] Types block: `finishReason`, `durationMs`, `requestId`; mark `confidence` deprecated
- [x] Troubleshooting: replace prose with "read `errorInfo.hint`" plus a table of common codes (no `doctor` CLI yet; that lands in Phase 2)
- [x] CHANGELOG entry listing D1–D10, D13, D14 by symptom

**After Phase 2**
- [x] Hero line: provider count and "any OpenAI-compatible API"
- [x] Providers table: add Groq, OpenRouter, DeepSeek, Mistral, xAI, Together rows; add `baseURL` column
- [x] Install section: subpath imports (`import { OpenAIProvider } from '@tanvoid0/bot-client/openai'`) and note core is edge/browser safe
- [x] New "Customisation" collapsed section: `baseURL`, `headers`, `fetch`, `timeout`, `models`, `providerOptions`, `hooks`, `discover`
- [x] CLI section: `doctor` command with sample output
- [x] Ollama CLI helper: import path changed to `/ollama-cli`

**After Phase 3 (2.0)**
- [x] Quick start keeps `prompt`; `messages` shown in its own section
- [x] New sections: "Messages and images", "Tool calling", "Structured output"
- [x] Streaming section: typed chunks (no legacy flag exists)
- [x] Types block updated; removed list points at MIGRATION.md
- [x] Providers table: Tools, Schema, Images columns
- [x] Comparison table (§1.1) with 2.0 column filled and dated
- [x] Link to `MIGRATION.md`; breaking list in CHANGELOG
- [x] Badges: bundle size (12.1 kB, `./core` + one provider), runtimes

**After Phase 4**
- [x] First sentence contains: zero-dependency, TypeScript, LLM client, the provider names, streaming, tool calling
- [x] "Why bot-client" five bullets
- [x] Docs site link in badges and footer
- [x] `llms.txt` present and linked
- [x] package.json `description` and `keywords` match README wording
- [x] Remove Development section's internal notes; point to CONTRIBUTING
- [ ] npm page preview checked (`npm view`, README render on npmjs.com)

**After Phase 5**
- [ ] Hero line: add "agents, MCP client, sessions, embeddings"
- [ ] New sections: "Agents" (define, run, stream, `asTool` supervisor example, `handoff`), "MCP" (connect, list tools, feed into an agent; stdio note), "Sessions" (store, truncation), "Embeddings", "Cost"
- [ ] Install section: list the new subpaths and state core size is unchanged (re-run `npm run size`)
- [ ] Comparison table: fill Agent, MCP, Embeddings rows
- [ ] Keywords: add `mcp`, `model-context-protocol`, `agents`, `multi-agent`, `embeddings`, `rag`
- [ ] Types block: `Tool.execute` receives `{ signal }`; `AIResponse.steps`, `handedOffTo`

**After Phase 6**
- [ ] New section "Routines": interval and cron examples, `store`, `catchUp`, "not a distributed scheduler" note
- [ ] CLI section: `routine run`
- [ ] Keywords: add `scheduler`, `cron`, `routines`

---

## 13. Learnings from agent-platform (2026-09-13)

`D:/projects/production/ai/agentic-ai/agent-platform` is a Rust/axum server with its own
OpenAI-compatible `/v1` proxy (`desktop/crates/server/src/llm.rs`), an iced desktop
client (`desktop/crates/client`), a planner-generated multi-agent DAG
(`executor.rs`, ADR 0001) and a DB-polled interval scheduler (`workflow_engine.rs`).
It has no MCP client, no cron, and no agent-as-tool primitive; its multi-agent shape
is a DAG, not a handoff chain, so §7b stands as designed.

### 13.1 Ported into bot-client (Phase 1, done)

| Mechanism | Source | What changed here |
|---|---|---|
| Rate limit under a plain 4xx: some gateways answer a burst with 400 + "too many concurrent requests" | `upstream_http.rs` `is_rate_limited`, `RATE_LIMIT_PHRASES` | `fromHttpError` scans the message for the same phrases on any 4xx/5xx and classifies `RATE_LIMIT` |
| Loopback refusal gets one retry, not the full budget: a dead port and a live server with a full accept backlog refuse the same way (seen: 12 of 32 DAG tasks dying with Ollama running) | `upstream_http.rs` `is_loopback_refusal`, `LOOPBACK_REFUSAL_ATTEMPTS = 2` | `PROVIDER_UNREACHABLE` is retryable with a budget capped at 1 (`SINGLE_RETRY`) |
| Proxy speaks a closed error vocabulary | our own §5 | a body whose `error.code` is already an `AIErrorCode` name maps 1:1, so an agent-platform `/v1` reply carrying `code: "RATE_LIMIT"` needs no provider-specific classifier |

### 13.2 To port (later phases)

| Mechanism | Source | Lands in |
|---|---|---|
| Leaked tool calls: weak local models print `<function=name>{json}</function>` as text instead of a real `tool_calls` entry; recover the call (first occurrence per tool wins) and strip the markup from the shown text | `coder_loop.rs` `parse_leaked_tool_calls`, `strip_leaked_tool_syntax` | Phase 3 `core/tools.ts`: `recoverLeakedToolCalls` behind `tools.recoverLeaked: true` (default on for Ollama/LM Studio) |
| Context budget by role priority: shrink tool results first, then assistant, then user, then system; per-message truncation with a suffix marker, never wholesale drop | `context_budget.rs` `shrink_messages_to_budget`, `role_priority` | Phase 5 `Session`: replace "drop oldest non-system" with role-priority shrink; keep `chars / 4` (they fall back to it too) |
| Usage normalization + synthesized usage flagged `estimated: true` when the provider sends none | `usage.rs` `normalize_usage`, `synthesize_usage` | Phase 3: `TokenUsage.estimated?: boolean`; `OllamaProvider` already maps `prompt_eval_count`/`eval_count` |
| Model capability probe: Ollama `/api/show` `capabilities[]` (tools, vision, thinking, embedding) mapped to a fixed key set, disk-cached, plus a name-based hint list for tool support | `model_capabilities.rs` `normalize_ollama_capabilities`, `TOOL_HINTS` | Phase 3: `provider.capabilities(modelId)` → `{ tools, vision, reasoning, embeddings, json }`; fail `UNSUPPORTED` before sending `tools` to a model that cannot take them |
| Thinking models: server prefixes `<\|think\|>`, client strips `<think>…</think>` spans from displayed text with a partial-tag carry across chunks | `llm_admin.rs` `thinking`, `client/src/sse.rs` `ThinkFilter`, `partial_tag_len` | Phase 3 reasoning chunks; plus `stripThinking: true` request option for models that inline the tags |
| SSE reconnect with backoff and counter reset on any frame, but never for chat completions (a re-run would duplicate tool calls) | `client/src/sse.rs` `process_stream` vs `chat_stream` | Phase 5 MCP Streamable HTTP: reconnect with `Last-Event-ID` on the notification stream only; confirms §5.3's no-retry-after-first-byte rule |
| Anthropic behind an OpenAI-compatible base needs Bearer and `x-api-key` + `anthropic-version` together | `byok.rs` `AuthStyle::Anthropic`, `outbound_headers` | Phase 2 presets: document via `headers` on `OpenAICompatibleProvider`; no code |
| Ollama runtime knobs (`num_ctx`, keep-alive) | `llm_llama_process.rs` `n_ctx`, `idle_timeout` | Phase 2 `providerOptions` passthrough into Ollama `options` |

### 13.3 What agent-platform can take from bot-client

- **Consume it directly.** The `/v1` proxy requires a bearer (`master.key`, ADR 0019) and
  streams standard SSE with mid-stream failures as `{ "error": … }` frames
  (`upstream_http.rs` `sse_error_chunk`), which `OpenAICompatibleProvider` already
  turns into a thrown `AIError`. Phase 2 ships a preset:
  `new OpenAICompatibleProvider({ id: 'agent-platform', baseURL: 'http://127.0.0.1:18410/v1', apiKey })`.
- **Emit the taxonomy.** Its `ApiError` codes are free-form strings and, by its own
  module doc, "nothing in this repo branches on them". Emitting §5's names in
  `error.code` on `/v1` replies costs a match arm per status and gives every JS
  consumer a typed error for free (bot-client maps them 1:1 as of 13.1).
- **Static catalog routing.** `provider_catalog.rs` resolves models only from live
  discovery plus a YAML alias table; `core/catalog.ts`'s prefix rules would let a
  request name `claude-…` before any provider has been listed.
- **`finishReason` and `TRUNCATED`.** The proxy passes `finish_reason` through
  untouched; normalising it and failing `jsonMode` + `length` as `TRUNCATED` would
  stop half-written JSON reaching the planner DAG.
- **Backlog match.** plan.md's Backlog has no open item a bot-client feature closes
  directly today; the `portal_equalizer` case (another repo consuming this server)
  is the shape the preset above serves.
