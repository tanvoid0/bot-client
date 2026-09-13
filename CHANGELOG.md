# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-09-13

### Changed

- **Zero runtime dependencies**: `axios` is gone; every provider talks to its API over the global `fetch`. `npm install` pulls in nothing but this package.
- Streaming reads the `fetch` body directly (`streamLines` now takes any `AsyncIterable<Uint8Array | string>`); the abort signal and the no-timeout streaming call behave as before.
- Non-2xx replies throw `HttpError` (`status`, `body`, parsed `json`); `handleError` still lifts the API's own `error.message` into the `AIError`.
- Node **18+** required (was 16+), for native `fetch`.

### Removed

- `readStreamToString` from `base-provider` — no longer needed, error bodies are read before a stream is handed out.

---

## [1.5.0] - 2026-09-07

### Added

- **Streaming**: `AIFactory.processStream(request)` and `AIProvider.processStream`, yielding `AIStreamChunk`s (`text` written since the last chunk, then a final chunk carrying `done` and the token usage).
  - `GeminiProvider` reads `streamGenerateContent` as SSE; `OllamaProvider` reads `/api/chat` NDJSON. Same request body as `process`, so a streamed answer is the same answer in pieces.
  - `BaseProvider.processStream` falls back to one chunk from `process()`, so every provider — OpenAI, Anthropic, LM Studio — can be consumed as a stream today and gain real streaming later without callers changing.
  - No retry and no fallback provider on the streaming path: half an answer is usually already on screen when a stream fails, and restarting elsewhere would splice two answers together.
- `streamLines` helper, exported from `base-provider`, which reassembles lines split across network reads.
- `AIRequest.signal` (`AbortSignal`) to abort an in-flight request/stream; wired through `GeminiProvider` and `OllamaProvider`'s `processStream`, which also drop the client's 30s socket-idle timeout on the streaming call so a cold model load or a mid-stream stall isn't cut off.

---

## [1.3.1] - 2026-02-04

### Fixed

- Publish workflow: fail with clear message when `NPM_TOKEN` secret is missing (instead of generic npm auth error).

---

## [1.3.0] - 2026-02-04

### Added

- **AIFactory config**: `defaultProvider`, `fallbackProvider`, `providerOrder`, `logger`, `providers`, `retries` in constructor.
- **Logger interface**: Optional `logger` in factory config; no console logging when not provided.
- **New methods**: `getAllSupportedModels()`, `getProviderForModel(modelId)`, `testProviders()`, `ready()`.
- **Programmatic provider config**: `OpenAIProviderConfig`, `AnthropicProviderConfig`, `GeminiProviderConfig`, `LMStudioProviderConfig`; pass API keys/baseURL in code.
- **Custom providers**: `AIFactory({ providers: [AIProvider[]] })` to use only specified providers.
- **Conversation history**: All providers use `systemPrompt` and `history` from `AIRequest` (via `buildChatMessages`).
- **AIError code**: Optional `code` (e.g. `NO_API_KEY`, `RATE_LIMIT`) for programmatic handling; `AIErrorCode` type exported.
- **Unit tests**: buildChatMessages, Logger spy tests, AIFactory with mock provider (defaultProvider, providerOrder, fallback, retries), ensureFactoryReady.
- **Integration tests**: `tests/integration-local.ts` for Ollama and LM Studio (no API keys); tests skip when provider unreachable.
- **Exports**: `AIProvider`, provider config types, `buildChatMessages` (via base-provider), `AIErrorCode`.

### Changed

- **Cloud auth**: OpenAI and Anthropic send API keys (Bearer / x-api-key) on every request; single reused HTTP client per provider.
- **Ollama**: `process()` and `discoverModels()` use `getApiClient()` (respects `baseURL` from config).
- **Connection tests**: OpenAI, Gemini, Ollama, LM Studio use lightweight checks (e.g. GET models/tags) instead of full completion.
- **HTTP clients**: All providers reuse one client per provider for discover and process.
- **TypeScript**: `strict: true` in tsconfig.
- **Scripts**: `clean` is cross-platform (Node one-liner); test script uses `--forceExit`.
- **.env.example**: UTF-8, no BOM.
- **README and examples**: Updated for current API; examples use real config and `ready()`.

### Fixed

- Cloud providers no longer return 401 due to missing API key headers.
- Ollama custom `baseURL` was ignored in `process()`; now used.
- Factory constructor accepted no config; now accepts `AIFactoryConfig`.
- Provider selection was arbitrary (first in map); now respects `modelId`, `defaultProvider`, `providerOrder`, then fallback.

### Removed

- **Dead test**: `tests/ai-model-manager.test.ts` (referenced non-existent `AIModelManager`).

---

## [1.2.2] and earlier

See git history for changes before this changelog was added.

[1.3.1]: https://github.com/tanvoid0/bot-client/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/tanvoid0/bot-client/compare/v1.1.1...v1.3.0
