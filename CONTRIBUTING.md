# Contributing

## Setup and gates

```bash
npm install
npm run build && npm test && npm run lint
```

All three must pass before a PR. `npm test` runs against stubbed `fetch`; nothing needs a key or a running server. `npm run bench:size` prints the gzipped size of every entry; `./core` plus one provider stays under 12.5 kB, and a PR that moves it says so.

Optional, against real services: `npm run test:integration` (local Ollama / LM Studio) and `npx llmwire doctor` (every provider you have a key for).

## Rules

- **Zero runtime dependencies.** `dependencies` stays empty. A Standard Schema validator, a Zod, an SSE parser: no. If a few lines cover it, write the lines; if they do not, argue for it in the PR.
- **No Node built-ins** in the main entry or any provider. `tests/phase2.test.ts` bundles every entry with `--platform=browser` and fails on `child_process`, `fs`, `string_decoder`, etc. Node-only code goes under its own subpath (`./ollama-cli` is the precedent).
- **Errors are classified, never rewritten.** A failure becomes an `AIError` with a `code` from `AIErrorCode`, the provider's own message as `message`, and a `hint` saying what to do. New codes need a row in ARCHITECTURE.md §5.2 and a test in `tests/errors.test.ts`.
- **Additive by default.** A change to `AIRequest`, `AIResponse` or the chunk union is breaking unless it only adds optional fields; breaking changes wait for a major and get a `MIGRATION.md` entry.
- CHANGELOG entry under `[Unreleased]`, written as the symptom a user sees, not the internal change.

## Adding a provider

### Speaks the OpenAI chat-completions dialect

Most hosts do. Add a row to `PRESETS` in [src/providers/openai-compatible.ts](src/providers/openai-compatible.ts):

```ts
myhost: { name: 'MyHost', baseURL: 'https://api.myhost.ai/v1', apiKeyEnv: ['MYHOST_API_KEY'] },
```

Fields worth knowing: `streamUsage: false` when the host rejects `stream_options`, `modelFilter` when `/models` lists things that cannot chat. If the host's model ids have a unique prefix (`grok-`), add a route in [src/core/catalog.ts](src/core/catalog.ts) so `modelId` reaches it with no discovery call; `vendor/model` ids stay unrouted because several hosts share them. Then: a README row in the Providers table, a preset test in `tests/phase2.test.ts`, and run `npx llmwire doctor myhost` once with a real key.

### Speaks its own dialect

Extend `BaseProvider` ([src/providers/base-provider.ts](src/providers/base-provider.ts)), one file under `src/providers/`, and a subpath export in `package.json` (`exports`, `typesVersions`) mirroring the existing ones.

```ts
import { BaseProvider, buildChatMessages, firstEnv, mergeBody } from './base-provider.js';
import type { AIRequest, AIResponse, AIStreamChunk, BaseProviderConfig } from '../types/index.js';
import type { Refinement } from '../core/errors.js';

export interface MyProviderConfig extends BaseProviderConfig {
  apiKey?: string;
}

export class MyProvider extends BaseProvider {
  private readonly apiKey?: string;

  constructor(config: MyProviderConfig = {}) {
    super({ baseURL: 'https://api.example.com', ...config });
    this.apiKey = config.apiKey ?? firstEnv(['MY_API_KEY']);
  }

  get providerId() { return 'my'; }
  get providerName() { return 'My Provider'; }

  async discoverModels(): Promise<string[]> {
    const cached = this.cached();
    if (cached) return cached;
    const res = await this.http<{ models: { id: string }[] }>(`${this.baseURL}/models`, { headers: this.auth() });
    return this.setDiscovered(res.models.map((m) => m.id));
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) return this.fail(this.error('NO_API_KEY', 'No API key', { hint: 'Pass { apiKey } or set MY_API_KEY.' }));
    const model = request.modelId ?? this.supportedModels[0];
    try {
      const body = mergeBody({ model, messages: buildChatMessages(request) /* translate parts/tools here */ }, request.providerOptions);
      const { data, headers } = await this.httpFull<any>(`${this.baseURL}/chat`, {
        method: 'POST', headers: this.auth(), body, ...this.requestOptions(request),
      });
      return this.ok(data.text, {
        modelUsed: model,
        finishReason: data.stop === 'length' ? 'length' : 'stop',
        usage: { promptTokens: data.usage?.in, completionTokens: data.usage?.out },
        requestId: headers.get('x-request-id') ?? undefined,
      });
    } catch (err) {
      return this.fail(this.toError(err, model), model);
    }
  }

  // Optional. Without it the factory still streams: BaseProvider yields the answer as text then done.
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    // const bytes = await this.httpStream(url, {...}); for await (const ev of parseSSE(bytes)) yield { type: 'text', text: ... };
    yield* super.processStream(request);
  }

  // Read the host's error body; return only what you can tell from it, the status code default fills the rest.
  protected classify(status: number, json: any): Refinement {
    if (json?.error?.type === 'model_missing') return { code: 'MODEL_NOT_FOUND', providerCode: json.error.type };
    return {};
  }

  private auth() { return { Authorization: `Bearer ${this.apiKey}` }; }
}
```

What `BaseProvider` gives you: `http` / `httpFull` / `httpStream` (apply `headers`, `timeout`, `streamIdleTimeout`, injected `fetch`), `ok` / `fail` (build the response, turn an empty `content_filter` answer into `CONTENT_FILTER`), `error` / `toError` (classification through your `classify`), `cached` / `setDiscovered` (the `modelCacheTtlMs` contract). Helpers: `buildChatMessages` (system + messages + prompt as `Message[]`), `partsOf` / `textOf` / `inlineImage` for image parts, `openaiTools` / `parseArgs` in `src/core/tools.ts` for tool definitions and argument deltas, `parseSSE` / `parseNDJSON` in `src/core/http.ts`.

Tests, all with `jest.spyOn(globalThis, 'fetch')` (see `tests/providers-stream.test.ts` for the stream helper): one happy path with `usage` and `finishReason`; the §5.2 error cells your host can produce (401, 404 model, 429 with `Retry-After`, 5xx, a 200 that is really a refusal); one stream if you override `processStream`. Then a README row and a CHANGELOG line.

## Releasing

Maintainer only: `npm run publish:minor` (or `patch` / `major`) bumps, builds, runs unit tests and publishes `llmwire`; `publish:dry` rehearses. Then `npm run build:shim && npm publish ./shim` publishes the `@tanvoid0/bot-client` re-export shim at the same version.
