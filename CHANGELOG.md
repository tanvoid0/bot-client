# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
