# Migrating from 1.x to 2.0

2.0 removes every 1.x compatibility shim. Where a removed input is still passed, the
library fails loudly with an `AIError` whose `hint` names the replacement, so an
upgrade cannot go unnoticed at runtime; where a removed output is read, TypeScript
reports the missing property.

## Package name

The package is now `llmwire`. `@tanvoid0/bot-client` 2.x is a shim that depends on
`llmwire` and re-exports every entry (`@tanvoid0/bot-client/openai` → `llmwire/openai`)
plus the `bot-client` CLI, so an existing install keeps working; it is kept for one major.
To switch: `npm rm @tanvoid0/bot-client && npm i llmwire`, then replace the import path.
The CLI is `npx llmwire`.

## Requests

| 1.x | 2.0 | What happens if you keep the old one |
|---|---|---|
| `history: [...]` | `messages: [...]` (same shape; `role: 'tool'` and image parts are new) | `INVALID_REQUEST`: "AIRequest.history was removed in 2.0" |
| `responseSchema` (Gemini only) | `schema` (JSON Schema object or any Standard Schema; every provider) | `INVALID_REQUEST` |
| `usageContext` | delete it; it was never read | `INVALID_REQUEST` |
| `prompt` required | `prompt` optional; one of `prompt` / `messages` required | `INVALID_REQUEST` when both are missing |

## Responses

| 1.x | 2.0 |
|---|---|
| `tokensUsed`, `promptTokens`, `completionTokens` | `usage.totalTokens`, `usage.promptTokens`, `usage.completionTokens` |
| `processingTime` | `durationMs` |
| `confidence`, `cost`, `modelCapabilities`, `suggestedImprovements`, `timestamp` | removed; they were never computed |
| — | new: `object` (when `schema` given), `toolCalls`, `steps` |

## Stream chunks

Chunks are a discriminated union. Switch on `type`; only `text` chunks are the answer.

```ts
// 1.x
for await (const chunk of aiFactory.processStream(req)) {
  out += chunk.text;
  if (chunk.done) console.log(chunk.usage);
}

// 2.0
for await (const chunk of aiFactory.processStream(req)) {
  if (chunk.type === 'text') out += chunk.text;
  if (chunk.type === 'reasoning') thinking += chunk.text;
  if (chunk.type === 'tool-call') calls.push(chunk.toolCall);
  if (chunk.type === 'done') console.log(chunk.finishReason, chunk.usage);
}
```

A custom provider that still yields `{ text, done }` makes the factory throw
`INVALID_RESPONSE` on the first chunk. Yield `{ type: 'text', text }`,
`{ type: 'reasoning', text }`, `{ type: 'tool-call', toolCall }` and a final
`{ type: 'done', finishReason }` instead. `chunksOf(response)` turns a one-shot
`AIResponse` into that sequence.

## Custom providers

| 1.x | 2.0 |
|---|---|
| `createResponse(success, data, error, model, usage)` | `this.ok(data, extra)` / `this.fail(this.error(code, message))` |
| `handleError(error)` (throws) | `this.toError(error, model)` (returns an `AIError`) |
| `buildChatMessages()` returned `{ role, content: string }[]` | returns `Message[]`; `content` may be a parts array, `role` may be `'tool'`; use `textOf` / `partsOf` |
| `AIFactory` from `.` constructs the five built-ins when given none | unchanged; `AIFactory` from `./core` has no defaults and needs `providers` |

## Removed types

`ConversationHistory`, `AIProviderConfig`, `ProviderType`, `ProviderConfig`,
`ContentGenerationRequest`, `AnalysisRequest`, `CodeGenerationRequest`,
`ConversationRequest`, `PostProcessingOptions`, `ModelCapabilities`,
`ProcessingMetrics`, `ChatMessage`. None had a reader inside the library.
