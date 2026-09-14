/**
 * Phase 5: Agent (run, stream, asTool, handoff, onStep), Session (transcript,
 * budget, summary), MCP client against a small node:http server, embed,
 * cost, factory concurrency.
 */
import { createServer, type Server } from 'node:http';
import { AIFactory } from '../src/ai-factory.js';
import { Agent, handoff } from '../src/agent/agent.js';
import { Session, MemoryStore, transcript } from '../src/agent/session.js';
import { McpClient } from '../src/agent/mcp.js';
import { embed, cosine } from '../src/agent/embed.js';
import { estimateCost, priceOf } from '../src/agent/cost.js';
import type { AIProvider, AIRequest, AIResponse, AIStreamChunk, Tool, ToolCall } from '../src/types/index.js';

afterEach(() => jest.restoreAllMocks());

const ok = (data: string, extra: Partial<AIResponse> = {}): AIResponse => ({ success: true, data, providerId: 'p', modelUsed: 'm', finishReason: 'stop', ...extra });
const call = (name: string, args: unknown = {}, id = 'c1'): ToolCall => ({ id, name, arguments: args });

/** Answers from a script, one response per model call; records every request it saw. */
function scripted(script: Array<(req: AIRequest) => AIResponse>, seen: AIRequest[] = []): AIProvider {
  let i = 0;
  return {
    providerId: 'p',
    providerName: 'p',
    supportedModels: ['m'],
    isModelSupported: () => true,
    discoverModels: async () => ['m'],
    testConnection: async () => true,
    process: async (req) => {
      seen.push(req);
      return script[Math.min(i++, script.length - 1)](req);
    },
    processStream: async function* (req) {
      seen.push(req);
      const res = script[Math.min(i++, script.length - 1)](req);
      if (res.data) yield { type: 'text', text: res.data, modelUsed: 'm' } as AIStreamChunk;
      for (const tc of res.toolCalls ?? []) yield { type: 'tool-call', toolCall: tc, modelUsed: 'm' } as AIStreamChunk;
      yield { type: 'done', finishReason: res.finishReason ?? 'stop', modelUsed: 'm', toolCalls: res.toolCalls, usage: res.usage } as AIStreamChunk;
    },
  };
}
const factoryOf = (...script: Array<(req: AIRequest) => AIResponse>) => {
  const seen: AIRequest[] = [];
  return { factory: new AIFactory({ providers: [scripted(script, seen)], discover: 'none' }), seen };
};

const weather: Tool = {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  execute: async ({ city }: { city: string }) => `${city}: 21C`,
};

describe('Agent', () => {
  test('run merges defaults, loops tools through the factory, reports steps and onStep', async () => {
    const { factory, seen } = factoryOf(
      () => ok('', { finishReason: 'tool_calls', toolCalls: [call('get_weather', { city: 'Oslo' })] }),
      () => ok('Sunny in Oslo.')
    );
    const steps: string[] = [];
    const agent = new Agent({ name: 'meteo', model: 'm', system: 'Be brief.', tools: [weather], factory, onStep: (s, a) => void steps.push(`${a.name}:${s.toolResults[0].result}`) });
    const res = await agent.run('Weather in Oslo?');
    expect(res.data).toBe('Sunny in Oslo.');
    expect(res.steps).toHaveLength(1);
    expect(steps).toEqual(['meteo:Oslo: 21C']);
    expect(seen[0]).toMatchObject({ modelId: 'm', systemPrompt: 'Be brief.', prompt: 'Weather in Oslo?', maxSteps: 8 });
    expect(seen[1].messages?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  test('asTool: a supervisor calls a sub-agent and gets its text back', async () => {
    const { factory } = factoryOf(
      // supervisor asks the researcher
      () => ok('', { finishReason: 'tool_calls', toolCalls: [call('researcher', { input: 'What is X?' })] }),
      // researcher answers
      () => ok('X is a thing.'),
      // supervisor concludes
      (req) => ok(`Researcher said: ${req.messages?.find((m) => m.role === 'tool')?.content}`)
    );
    const researcher = new Agent({ name: 'researcher', factory, system: 'You research.' });
    const supervisor = new Agent({ name: 'boss', factory, tools: [researcher.asTool()] });
    const res = await supervisor.run('Find out about X');
    expect(res.data).toBe('Researcher said: X is a thing.');
    expect(researcher.asTool().description).toBe('You research.');
  });

  test('handoff: the conversation continues as the target agent; steps merge and handedOffTo is set', async () => {
    const { factory, seen } = factoryOf(
      () => ok('Let me pass you on.', { finishReason: 'tool_calls', toolCalls: [call('handoff_to_billing', { reason: 'invoice' })] }),
      () => ok('Billing here: refund issued.')
    );
    const billing = new Agent({ name: 'billing', factory, system: 'You are billing.' });
    const triage = new Agent({ name: 'triage', factory, tools: [handoff(billing)] });
    const res = await triage.run('I want a refund');
    expect(res.data).toBe('Billing here: refund issued.');
    expect(res.handedOffTo).toBe('billing');
    expect(res.steps).toHaveLength(1);
    expect(res.steps![0].toolResults[0]).toMatchObject({ result: 'Handed off to billing', error: undefined });
    // billing got the whole conversation plus its own system prompt, and no triage tools
    expect(seen[1].systemPrompt).toBe('You are billing.');
    expect(seen[1].tools).toBeUndefined();
    expect(seen[1].messages?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  test('stream: text passes through and a handoff continues as the target stream', async () => {
    const { factory } = factoryOf(
      () => ok('Passing on.', { finishReason: 'tool_calls', toolCalls: [call('handoff_to_billing')] }),
      () => ok('Refund issued.')
    );
    const billing = new Agent({ name: 'billing', factory });
    const triage = new Agent({ name: 'triage', factory, tools: [handoff(billing)] });
    const chunks: AIStreamChunk[] = [];
    for await (const c of triage.stream('Refund please')) chunks.push(c);
    const text = chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
    expect(text).toBe('Passing on.Refund issued.');
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
  });
});

describe('Session', () => {
  test('send appends the user turn, every tool round and the answer, then continues from the store', async () => {
    const { factory, seen } = factoryOf(
      () => ok('', { finishReason: 'tool_calls', toolCalls: [call('get_weather', { city: 'Oslo' })] }),
      () => ok('Sunny.'),
      () => ok('Still sunny.')
    );
    const agent = new Agent({ name: 'a', factory, tools: [weather] });
    const store = new MemoryStore();
    const session = new Session({ id: 's1', store });
    await session.send(agent, 'Weather?');
    expect((await session.messages()).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    await session.send(agent, 'And now?');
    expect(seen[2].messages?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(await store.get('s1')).toHaveLength(6);
  });

  test('budget: tool results are shortened first, then whole oldest turns go; the last turn always stays', async () => {
    const { factory } = factoryOf(() => ok('ok'));
    const agent = new Agent({ name: 'a', factory });
    const store = new MemoryStore();
    await store.set('s', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question ' + 'x'.repeat(400) },
      { role: 'assistant', content: '', toolCalls: [call('t')] },
      { role: 'tool', toolCallId: 'c1', name: 't', content: 'y'.repeat(2000) },
      { role: 'assistant', content: 'first answer' },
    ]);
    // budget ≈ 150 tokens ≈ 600 chars: shortening the tool result (2000 → 400) is not enough, the first turn goes.
    const session = new Session({ id: 's', store, maxTokens: 150 });
    await session.send(agent, 'second question');
    const kept = await session.messages();
    expect(kept.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(kept[1].content).toBe('second question');
  });

  test('budget: a tool result over the cap is shortened when that is enough', async () => {
    const { factory } = factoryOf(() => ok('ok'));
    const agent = new Agent({ name: 'a', factory });
    const store = new MemoryStore();
    await store.set('s', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [call('t')] },
      { role: 'tool', toolCallId: 'c1', name: 't', content: 'y'.repeat(3000) },
      { role: 'assistant', content: 'a' },
    ]);
    const session = new Session({ id: 's', store, maxTokens: 500, toolResultChars: 100 });
    await session.send(agent, 'q2');
    const kept = await session.messages();
    expect(kept).toHaveLength(6);
    expect((kept[2].content as string).length).toBeLessThan(120);
    expect(kept[2].content).toMatch(/truncated/);
  });

  test('summarize: dropped turns become one system summary written by the model', async () => {
    const { factory, seen } = factoryOf((req) => ok(req.prompt?.startsWith('Summarize') ? 'User asked about A; answer was B.' : 'ok'));
    const agent = new Agent({ name: 'a', factory, tools: [weather] });
    const store = new MemoryStore();
    await store.set('s', [
      { role: 'user', content: 'A? ' + 'x'.repeat(800) },
      { role: 'assistant', content: 'B.' },
    ]);
    const session = new Session({ id: 's', store, maxTokens: 100, summarize: true });
    await session.send(agent, 'next');
    const kept = await session.messages();
    expect(kept[0]).toEqual({ role: 'system', content: expect.stringContaining('User asked about A; answer was B.') });
    expect(kept.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    // the summary call had no tools and one step
    expect(seen[1]).toMatchObject({ maxSteps: 1, tools: undefined });
  });

  test('transcript of a plain answer is one assistant message; unrun calls are not stored', () => {
    expect(transcript(ok('hi'))).toEqual([{ role: 'assistant', content: 'hi' }]);
    expect(transcript(ok('', { finishReason: 'tool_calls', toolCalls: [call('t')] }))).toEqual([{ role: 'assistant', content: '' }]);
  });
});

describe('McpClient (Streamable HTTP)', () => {
  let server: Server;
  let url: string;
  const seen: any[] = [];
  const TOOLS = [{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'DELETE') return void res.writeHead(204).end();
        const msg = JSON.parse(body);
        seen.push({ headers: req.headers, msg });
        if (msg.id === undefined) return void res.writeHead(202).end();
        const reply = (result?: unknown, error?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) });
        // Every second response goes out as SSE, so both reply shapes are exercised.
        const sse = msg.id % 2 === 0;
        const send = (json: string) => {
          if (sse) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
            res.end(`event: message\ndata: ${json}\n\n`);
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
            res.end(json);
          }
        };
        switch (msg.method) {
          case 'initialize':
            return send(reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } }));
          case 'tools/list':
            return send(msg.params?.cursor ? reply({ tools: [{ name: 'noop', inputSchema: { type: 'object' } }] }) : reply({ tools: TOOLS, nextCursor: 'p2' }));
          case 'tools/call':
            if (msg.params.name === 'add') return send(reply({ content: [{ type: 'text', text: String(msg.params.arguments.a + msg.params.arguments.b) }] }));
            if (msg.params.name === 'noop') return send(reply({ content: [{ type: 'text', text: 'nope' }], isError: true }));
            return send(reply(undefined, { code: -32602, message: 'Unknown tool: ' + msg.params.name }));
          case 'ping':
            return send(reply({}));
          case 'resources/list':
            return send(reply({ resources: [{ uri: 'file:///a.txt', name: 'a' }] }));
          case 'resources/read':
            return send(reply({ contents: [{ uri: msg.params.uri, text: 'hello', mimeType: 'text/plain' }] }));
          default:
            return send(reply(undefined, { code: -32601, message: 'Method not found' }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test('initialize handshake, session id, paginated tools as Tool[] with a working execute', async () => {
    const mcp = await McpClient.connect({ url, headers: { authorization: 'Bearer t' } });
    expect(mcp.serverInfo).toEqual({ name: 'mock', version: '1' });
    expect(seen[0].msg.method).toBe('initialize');
    expect(seen[0].headers.authorization).toBe('Bearer t');
    expect(seen[1].msg.method).toBe('notifications/initialized');
    expect(seen[1].headers['mcp-session-id']).toBe('sess-1');

    const tools = await mcp.tools();
    expect(tools.map((t) => t.name)).toEqual(['add', 'noop']);
    expect(tools[0].parameters).toEqual(TOOLS[0].inputSchema);
    expect(await tools[0].execute!({ a: 2, b: 3 }, {})).toBe('5');
    // isError results throw so the model sees { error }
    await expect(tools[1].execute!({}, {})).rejects.toMatchObject({ code: 'MCP_ERROR', message: 'nope' });

    await mcp.ping();
    expect(await mcp.resources()).toEqual([{ uri: 'file:///a.txt', name: 'a' }]);
    expect(await mcp.readResource('file:///a.txt')).toEqual([{ uri: 'file:///a.txt', text: 'hello', mimeType: 'text/plain' }]);
    await mcp.close();
  });

  test('a JSON-RPC error is an AIError MCP_ERROR carrying the RPC code and the server message verbatim', async () => {
    const mcp = await McpClient.connect({ url });
    await expect(mcp.callTool('missing')).rejects.toMatchObject({ name: 'AIError', code: 'MCP_ERROR', providerCode: '-32602', message: 'Unknown tool: missing', provider: 'mcp' });
  });

  test('MCP tools run inside an agent loop', async () => {
    const mcp = await McpClient.connect({ url });
    const { factory } = factoryOf(
      () => ok('', { finishReason: 'tool_calls', toolCalls: [call('add', { a: 40, b: 2 })] }),
      (req) => ok(`The answer is ${req.messages?.find((m) => m.role === 'tool')?.content}`)
    );
    const agent = new Agent({ name: 'calc', factory, tools: await mcp.tools() });
    expect((await agent.run('40 + 2?')).data).toBe('The answer is 42');
  });
});

describe('embed', () => {
  function stub(reply: unknown) {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
    return () => ({ url: String(spy.mock.calls[0][0]), init: spy.mock.calls[0][1] as RequestInit, body: JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) });
  }

  test('OpenAI format: /embeddings, bearer, ordered by index, usage', async () => {
    const sent = stub({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
    const res = await embed(['a', 'b'], { model: 'text-embedding-3-small', apiKey: 'k', dimensions: 2 });
    expect(res.embeddings).toEqual([[1, 0], [0, 1]]);
    expect(res.usage).toEqual({ promptTokens: 4, totalTokens: 4 });
    const { url, init, body } = sent();
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 2 });
  });

  test('Gemini: batchEmbedContents with the key header', async () => {
    const sent = stub({ embeddings: [{ values: [1, 2] }] });
    const res = await embed(['a'], { model: 'gemini-embedding-2', apiKey: 'g' });
    expect(res.embeddings).toEqual([[1, 2]]);
    const { url, init, body } = sent();
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g');
    expect(body.requests[0]).toEqual({ model: 'models/gemini-embedding-2', content: { parts: [{ text: 'a' }] } });
  });

  test('Ollama: /api/embed, no key needed, picked from the model name', async () => {
    const sent = stub({ embeddings: [[3, 4]], prompt_eval_count: 2 });
    const res = await embed(['a'], { model: 'nomic-embed-text' });
    expect(res).toEqual({ embeddings: [[3, 4]], usage: { promptTokens: 2 } });
    expect(sent().url).toBe('http://localhost:11434/api/embed');
  });

  test('no key → NO_API_KEY with a hint; HTTP errors classify', async () => {
    await expect(embed(['a'], { model: 'text-embedding-3-small', apiKey: '' })).rejects.toMatchObject({ code: 'NO_API_KEY', hint: expect.stringContaining('OPENAI_API_KEY') });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(embed(['a'], { model: 'text-embedding-3-small', apiKey: 'k' })).rejects.toMatchObject({ code: 'AUTH', message: 'bad key' });
  });

  test('cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow(/length/);
  });
});

describe('cost', () => {
  test('longest prefix wins; vendor prefix ignored; cached tokens at the cache price; unknown → undefined', () => {
    expect(priceOf('gpt-5-mini-2026-01-01')).toEqual(PRICE('gpt-5-mini'));
    expect(priceOf('openai/gpt-5')).toEqual(PRICE('gpt-5'));
    expect(priceOf('claude-opus-4-8')).toEqual(PRICE('claude-opus-4'));
    expect(estimateCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'gpt-4o')).toBeCloseTo(12.5);
    expect(estimateCost({ promptTokens: 1_000_000, cachedTokens: 500_000, completionTokens: 0 }, 'claude-opus-5')).toBeCloseTo(2.5 + 0.25);
    expect(estimateCost({ promptTokens: 10 }, 'llama3.1:8b')).toBeUndefined();
    expect(estimateCost(undefined, 'gpt-4o')).toBeUndefined();
    expect(estimateCost({ promptTokens: 1_000_000 }, 'my-model', { 'my-model': { input: 1, output: 2 } })).toBe(1);
  });
  function PRICE(key: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/agent/cost.js').PRICES[key];
  }
});

describe('factory concurrency', () => {
  test('never more than `concurrency` provider calls in flight; a stream holds its slot until it ends', async () => {
    let active = 0;
    let peak = 0;
    const provider: AIProvider = {
      providerId: 'p',
      providerName: 'p',
      supportedModels: ['m'],
      isModelSupported: () => true,
      discoverModels: async () => ['m'],
      testConnection: async () => true,
      process: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return ok('x');
      },
      processStream: async function* () {
        peak = Math.max(peak, ++active);
        yield { type: 'text', text: 'a', modelUsed: 'm' };
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'done', finishReason: 'stop', modelUsed: 'm' };
        active--;
      },
    };
    const factory = new AIFactory({ providers: [provider], discover: 'none', concurrency: 2 });
    const drain = async () => {
      for await (const _ of factory.processStream({ prompt: 'x' })) void _;
    };
    await Promise.all([...Array(5)].flatMap(() => [factory.process({ prompt: 'x' }), drain()]));
    expect(peak).toBe(2);
    // a newcomer arriving as a slot is released does not cut in front of a waiter
    peak = 0;
    const waiters = [...Array(4)].map(() => factory.process({ prompt: 'x' }));
    await new Promise((r) => setTimeout(r, 12));
    waiters.push(factory.process({ prompt: 'x' }));
    await Promise.all(waiters);
    expect(peak).toBe(2);
  });
});
