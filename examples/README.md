# Examples

Minimal guide to the example files. Build first: `npm run build` (from repo root).

---

## Quick run

| Goal | Command |
|------|--------|
| Chat UI in browser | `npm run demo:web` then open http://localhost:3000 |
| Static HTML (no server) | Open `react-demo.html` in browser |
| Node script | `node dist/index.js` or run example TS after build |

---

## Example files

<details>
<summary><strong>basic-usage.ts</strong></summary>

Simple generation and provider usage: `aiFactory.generate()`, `process()`, optional `modelId` (e.g. Ollama model). Run after build (e.g. via your own script that imports from `dist` or the package).
</details>

<details>
<summary><strong>advanced-usage.ts</strong></summary>

Custom provider (implements `AIProvider`), `AIFactory({ providers: [customProvider] })`, batch processing, and full request/response metadata. Shows `getProvider()`, `process()`, and handling responses.
</details>

<details>
<summary><strong>multiple-providers.ts</strong></summary>

Custom factory with `defaultProvider`, `fallbackProvider`, `getAllSupportedModels()`, `getProviderForModel()`, and `testProviders()`. Run after build: `node -e "import('./examples/multiple-providers.ts')"` or via your runner.
</details>

<details>
<summary><strong>zero-config-usage.ts</strong></summary>

No env or config: relies on auto-detection (e.g. Ollama/LM Studio when running). Good for local-only setups.
</details>

<details>
<summary><strong>react-example.tsx</strong></summary>

React component: chat UI, loading state, calling `aiFactory.generate()`. Use with a React app that compiles this file.
</details>

<details>
<summary><strong>react-demo.html</strong></summary>

Standalone HTML + embedded script. Open in a browser; can use mock or real AI if the page is served and configured. No build step.
</details>

<details>
<summary><strong>web-server-example.js</strong></summary>

Express server: static files + REST chat. Run with `npm run demo:web`.

- `GET /` — Serves the demo page  
- `POST /api/chat` — Chat (body: `message`, `options`)  
- `GET /api/status` — Server/AI status  
- `GET /api/providers` — Available providers  
</details>

---

## Requirements

- **Node.js** 16+ for the server and Node examples.
- **AI backend**: Ollama or LM Studio (local), or API keys for OpenAI/Anthropic/Gemini (cloud).
- **Browser**: Modern browser for HTML/React demos.

---

## CLI (npx)

From the project root (or after `npm i @tanvoid0/bot-client`):

```bash
npx @tanvoid0/bot-client ollama list
npx @tanvoid0/bot-client keys list
```

See the main [README](../README.md#npx-cli) for all commands.
