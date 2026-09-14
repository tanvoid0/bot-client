<p><img src="./logo.svg" alt="llmwire" width="340" height="80"></p>

One wire to every LLM. Zero dependencies, real streaming, tool calling, structured output and typed errors across OpenAI, Anthropic, Gemini, Ollama, LM Studio and any OpenAI-compatible API. Node 18+, Bun, Deno, Workers, browsers.

## Install

```bash
npm install llmwire
```

## Use

```ts
import { aiFactory } from 'llmwire';

const res = await aiFactory.process({ prompt: 'Hello', modelId: 'gpt-4o' });
if (!res.success) console.error(res.errorInfo?.code, res.errorInfo?.hint);

for await (const c of aiFactory.processStream({ prompt: 'Hi' }))
  if (c.type === 'text') process.stdout.write(c.text);
```

Local models need no key: `modelId: 'llama3.2'` reaches Ollama. Cloud is one env var: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

## Go deeper

- [Examples](./examples.md) — ten small projects: PR summarizer, weather bot, receipt → JSON, streaming endpoint, agents, memory, MCP, search, cron digest
- [Guide](../README.md) — streaming, messages and images, tools, structured output, errors, retries, agents, MCP, CLI
- [API reference](https://tanvoid0.github.io/llmwire/modules.html) — every entry: `llmwire`, `llmwire/core`, `llmwire/agent`, `llmwire/mcp`, providers
- [Migrating 1.x → 2.0](../MIGRATION.md)
- [Architecture](../ARCHITECTURE.md) · [Changelog](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md)
- [llms.txt](https://tanvoid0.github.io/llmwire/llms.txt) — the short version, for models
