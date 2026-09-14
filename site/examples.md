---
title: Examples
---

Small projects, each one file. Every snippet runs as-is with `npm install llmwire` and either Ollama running locally or one API key in the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Swap `modelId` to move between providers; nothing else changes.

## 1. PR summarizer

Pipe a diff in, get a review out, streamed as it is written.

```bash
git diff main | node summarize.mjs
```

```ts
// summarize.mjs
import { aiFactory } from 'llmwire';

let diff = '';
for await (const chunk of process.stdin) diff += chunk;

for await (const c of aiFactory.processStream({
  modelId: 'claude-sonnet-4-5',
  systemPrompt: 'You review pull requests. Bullet points. Name risks first.',
  prompt: `Summarize this diff:\n\n${diff}`,
})) {
  if (c.type === 'text') process.stdout.write(c.text);
  if (c.type === 'done') console.error(`\n${c.usage?.totalTokens} tokens, ${c.durationMs} ms`);
}
```

## 2. Weather bot with a tool

The model decides when to call `get_weather`; the factory runs it and asks again, up to `maxSteps` rounds.

```ts
import { aiFactory } from 'llmwire';

const weather = {
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((r) => r.json());
    return { tempC: r.current_condition[0].temp_C, desc: r.current_condition[0].weatherDesc[0].value };
  },
};

const res = await aiFactory.process({ prompt: 'Do I need a jacket in Oslo tonight?', tools: [weather], maxSteps: 3 });
console.log(res.data);                          // "Yes, it is 9°C and overcast."
console.log(res.steps?.[0].toolCalls);          // what the model asked for
```

## 3. Receipt to JSON

Send a photo, get a validated object back. Any Standard Schema works (Zod, Valibot, ArkType); plain JSON Schema too.

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { aiFactory } from 'llmwire';

const Receipt = z.object({
  merchant: z.string(),
  date: z.string(),
  total: z.number(),
  items: z.array(z.object({ name: z.string(), price: z.number() })),
});

const res = await aiFactory.process({
  modelId: 'gpt-4o',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Extract this receipt.' }, { type: 'image', data: await readFile('receipt.jpg') }] }],
  schema: Receipt,
});

if (res.success) console.log(res.object.total, res.object.items.length);
else console.error(res.errorInfo?.code, res.errorInfo?.details); // SCHEMA_MISMATCH lists every issue
```

## 4. Streaming chat endpoint

A zero-dependency server on `node:http` that streams plain text chunks. Closing the browser tab aborts the upstream call.

```ts
import { createServer } from 'node:http';
import { aiFactory } from 'llmwire';

createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  try {
    for await (const c of aiFactory.processStream({ messages, signal: abort.signal })) {
      if (c.type === 'text') res.write(c.text);
    }
  } catch (err) {
    if (!abort.signal.aborted) res.write(`\n[${err.code}] ${err.hint}`);
  }
  res.end();
}).listen(3000);
```

```ts
// browser
const r = await fetch('/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }) });
for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) out.textContent += chunk;
```

## 5. Offline assistant

No keys, no network: Ollama on the same machine. `reasoning: true` shows the model thinking on stderr and keeps it out of the answer.

```ts
import { aiFactory } from 'llmwire';

for await (const c of aiFactory.processStream({ modelId: 'gemma4', prompt: 'Is 91 prime? Explain.', reasoning: true })) {
  if (c.type === 'reasoning') process.stderr.write(c.text);
  if (c.type === 'text') process.stdout.write(c.text);
}
```

Not installed yet? `npx llmwire pull gemma4`, then `npx llmwire doctor` to see every provider that answers.

## 6. Support desk: triage hands off to billing

Two agents. `triage` reads the message and either answers or hands the whole conversation to `billing`, which has the `refund` tool.

```ts
import { Agent, handoff } from 'llmwire/agent';

const refund = {
  name: 'refund',
  description: 'Refund an order',
  parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  execute: async ({ orderId }) => ({ ok: true, orderId }),
};

const billing = new Agent({ name: 'billing', system: 'You handle refunds. Ask for the order id if missing.', tools: [refund] });
const triage = new Agent({ name: 'triage', system: 'Route billing questions to billing. Answer everything else.', tools: [handoff(billing)] });

const res = await triage.run('Order 1234 arrived broken, I want my money back');
console.log(res.handedOffTo, res.data);   // 'billing', "Done, order 1234 is refunded."
```

## 7. Chat with memory

A terminal chat that remembers the conversation and stays under a token budget; old turns get summarized, not dropped.

```ts
import { createInterface } from 'node:readline/promises';
import { Agent } from 'llmwire/agent';
import { Session, MemoryStore } from 'llmwire/session';

const agent = new Agent({ name: 'chat', model: 'gpt-4o-mini', system: 'Be brief.' });
const session = new Session({ id: 'me', store: new MemoryStore(), maxTokens: 8_000, summarize: true });
const rl = createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  const line = await rl.question('> ');
  const res = await session.send(agent, line);
  console.log(res.data);
}
```

Swap `MemoryStore` for three methods over Redis or SQLite to survive restarts.

## 8. Ask your files

An agent with the tools of an MCP server. Here the reference filesystem server over stdio; a remote server is `McpClient.connect({ url })`.

```ts
import { Agent } from 'llmwire/agent';
import { McpClient } from 'llmwire/mcp';
import { McpStdioTransport } from 'llmwire/mcp-stdio';

const fs = await McpClient.connect({
  transport: new McpStdioTransport({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()] }),
});

const agent = new Agent({ name: 'files', model: 'claude-sonnet-4-5', tools: await fs.tools(), maxSteps: 10 });
const res = await agent.run('Which file in this folder was changed most recently, and what does it do?');
console.log(res.data);
```

## 9. Semantic search over notes

Embed once, rank by cosine. Works with OpenAI, Gemini or a local Ollama embedding model.

```ts
import { embed, cosine } from 'llmwire/embed';

const notes = ['Renew passport before June', 'Dentist on the 14th', 'Ask Sam about the Q3 budget'];
const { embeddings } = await embed(notes, { model: 'text-embedding-3-small' });

async function search(q: string) {
  const [qv] = (await embed([q], { model: 'text-embedding-3-small' })).embeddings;
  return notes.map((n, i) => [cosine(qv, embeddings[i]), n] as const).sort((a, b) => b[0] - a[0])[0][1];
}

console.log(await search('money meeting'));   // "Ask Sam about the Q3 budget"
```

## 10. Daily digest with a cost cap

A routine on a cron, in-process, that logs what each run cost.

```ts
import { Agent } from 'llmwire/agent';
import { Routine } from 'llmwire/routine';
import { MemoryStore } from 'llmwire/session';
import { estimateCost } from 'llmwire/cost';

const agent = new Agent({ name: 'digest', model: 'gpt-4o-mini', system: 'Summarize in five bullets.' });

new Routine({
  name: 'daily-digest',
  every: '0 8 * * *',
  store: new MemoryStore(),
  run: async ({ signal }) => agent.run(`Summarize: ${await fetchYesterdaysIssues()}`, { signal }),
  onResult: (r) => console.log(r.data, `$${estimateCost(r.usage, r.modelUsed!)?.toFixed(4)}`),
  onError: (e) => console.error(e.code, e.hint),
}).start();
```

For system cron instead: export the routine from `routines.js` and run `npx llmwire routine run ./routines.js`.

---

Same request shape everywhere: `prompt` or `messages`, optional `tools`, `schema`, `signal`, `modelId`. Full detail per feature in the [Guide](../README.md); every type in the [API reference](https://tanvoid0.github.io/llmwire/modules.html).
