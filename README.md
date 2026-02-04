# Bot Client

[![CI/CD Pipeline](https://github.com/tanvoid0/bot-client/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/tanvoid0/bot-client/actions)
[![npm version](https://img.shields.io/npm/v/@tanvoid0/bot-client.svg)](https://www.npmjs.com/package/@tanvoid0/bot-client)
[![npm downloads](https://img.shields.io/npm/dm/@tanvoid0/bot-client.svg)](https://www.npmjs.com/package/@tanvoid0/bot-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Multi-provider AI client: OpenAI, Anthropic, Gemini, **Ollama**, LM Studio. Zero-config for local; API keys for cloud. Includes **Ollama API + CLI** (pull, list, rm, show, ps, run) and an **npx CLI** for models and API keys.

---

## Install

```bash
npm install @tanvoid0/bot-client
```

## Quick start

```typescript
import { aiFactory } from '@tanvoid0/bot-client';

const text = await aiFactory.generate('Say hello in one sentence.', { maxTokens: 100 });
console.log(text);
```

With **Ollama** running locally, this works without API keys. For cloud providers, set env vars (see [Environment](#environment)).

---

## npx CLI

Manage Ollama models and API keys from the terminal:

```bash
npx @tanvoid0/bot-client help
npx @tanvoid0/bot-client ollama list
npx @tanvoid0/bot-client ollama pull llama3.1:8b
npx @tanvoid0/bot-client keys list
npx @tanvoid0/bot-client keys set BOT_CLIENT_OPENAI_KEY sk-...
```

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
  fallbackProvider: 'openai',
  providerOrder: ['ollama', 'lmstudio', 'openai'],
  logger: { info: console.log, warn: console.warn, error: console.error },
  retries: 1
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
<summary><strong>Ollama provider (programmatic)</strong></summary>

Use the Ollama provider for API-first operations (fallback to `ollama` CLI when server is down):

```typescript
import { aiFactory, OllamaProvider } from '@tanvoid0/bot-client';

const ollama = aiFactory.getProvider('ollama') as OllamaProvider | null;
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
  ollamaExecutablePath: 'ollama',
  preferCLI: false  // true = always use CLI
});
await provider.pull('gemma3');
```
</details>

<details>
<summary><strong>Standalone Ollama CLI helper</strong></summary>

```typescript
import { runOllamaCLI, isOllamaCLIAvailable } from '@tanvoid0/bot-client';

const ok = await isOllamaCLIAvailable();
const result = await runOllamaCLI('pull', ['llama3.1:8b'], { onStderr: (c) => process.stderr.write(c) });
// result: { ok, code, stdout, stderr }
```
</details>

<details>
<summary><strong>Types</strong></summary>

- **AIRequest**: `prompt`, `modelId?`, `temperature?`, `maxTokens?`, `systemPrompt?`, `history?`, `metadata?`, `usageContext?`
- **AIResponse**: `success`, `data?`, `error?`, `modelUsed?`, `providerId?`, `processingTime?`, `confidence?`, `tokensUsed?`, `cost?`
- **AIFactoryConfig**: `defaultProvider?`, `fallbackProvider?`, `providerOrder?`, `logger?`, `providers?`, `retries?`
- **Logger**: optional `debug`, `info`, `warn`, `error` (all `(message, ...args) => void`)
- **AIError**: `message`, `provider`, `statusCode?`, `details?`, `code?` (e.g. `NO_API_KEY`, `RATE_LIMIT`)
- **AIProvider**: interface for custom providers; implement `providerId`, `providerName`, `supportedModels`, `process`, `isModelSupported`, `testConnection`, `discoverModels`
</details>

---

## Providers

| Provider | Type | Notes |
|---------|------|--------|
| **Ollama** | Local | API + CLI; list/pull/rm/show/ps/run; tested |
| **LM Studio** | Local | localhost:1234; tested |
| **OpenAI** | Cloud | API key required |
| **Anthropic** | Cloud | API key required |
| **Gemini** | Cloud | API key required; tested |

The factory initializes all providers and keeps those that pass the connection test. Use `getProvider('ollama')` (etc.) to use a specific one.

---

## Troubleshooting

<details>
<summary><strong>No AI providers available</strong></summary>

- **Ollama**: `curl http://localhost:11434/api/tags` or `ollama list`; start with `ollama serve` if needed.
- **LM Studio**: Ensure a model is loaded and the server is on (e.g. localhost:1234).
- **Cloud**: Ensure the right env key is set (`BOT_CLIENT_OPENAI_KEY`, etc.).
</details>

<details>
<summary><strong>Connection test failed for X</strong></summary>

Normal during init: the client keeps only providers that succeed. Missing API key or stopped local server will show as failed for that provider.
</details>

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
