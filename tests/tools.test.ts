/**
 * Tool calling: the wire shape each provider sends and reads (one-shot and
 * streamed), recovery of leaked `<function=>` calls, and the factory's
 * `maxSteps` loop against a hand-written provider.
 */
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { AIFactory } from '../src/ai-factory.js';
import { recoverLeakedToolCalls, nextStepRequest } from '../src/core/tools.js';
import type { AIProvider, AIRequest, AIStreamChunk, Message, Tool } from '../src/types/index.js';

const weather: Tool = {
  name: 'get_weather',
  description: 'Current weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }: { city: string }) => ({ city, tempC: 21 }),
};

/** A conversation that already holds one call and its result, as the loop would build it. */
const CONVERSATION: Message[] = [
  { role: 'user', content: 'Weather in Oslo?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } }] },
  { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: '{"city":"Oslo","tempC":21}' },
];

function capture(reply: unknown) {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
  return () => JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

function stubStream(pieces: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(Buffer.from(p));
      controller.close();
    },
  });
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
}

async function collect(gen: AsyncGenerator<AIStreamChunk, void, void>): Promise<AIStreamChunk[]> {
  const out: AIStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

afterEach(() => jest.restoreAllMocks());

describe('OpenAI-format', () => {
  test('sends tools + tool_choice, maps assistant/tool messages, reads tool_calls', async () => {
    const body = capture({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] }, finish_reason: 'tool_calls' }],
    });
    const res = await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', messages: CONVERSATION, tools: [weather], toolChoice: { name: 'get_weather' } });
    const b = body();
    expect(b.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'Current weather', parameters: weather.parameters } }]);
    expect(b.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(b.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] });
    expect(b.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"city":"Oslo","tempC":21}' });
    expect(res.success).toBe(true);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'call_x', name: 'get_weather', arguments: { city: 'Rome' } }]);
  });

  test('no tools in the request → no tools/tool_choice keys', async () => {
    const body = capture({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
    await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', prompt: 'hi' });
    expect(body()).not.toHaveProperty('tools');
  });

  test('stream: argument deltas by index land on the done chunk', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Oslo\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const chunks = await collect(new OpenAIProvider({ apiKey: 'k' }).processStream({ modelId: 'gpt-4o', prompt: 'hi', tools: [weather] }));
    const done = chunks[chunks.length - 1];
    expect(done.done).toBe(true);
    expect(done.finishReason).toBe('tool_calls');
    expect(done.toolCalls).toEqual([{ id: 'call_a', name: 'get_weather', arguments: { city: 'Oslo' } }]);
  });

  test('leaked <function=> text is recovered when tools were offered', async () => {
    capture({ choices: [{ message: { content: 'Sure. <function=get_weather>{"city":"Oslo"}</function> Done.' }, finish_reason: 'stop' }] });
    const res = await new OpenAIProvider({ apiKey: 'k' }).process({ modelId: 'gpt-4o', prompt: 'hi', tools: [weather] });
    expect(res.data).toBe('Sure.  Done.');
    expect(res.toolCalls).toEqual([{ id: 'leaked_0', name: 'get_weather', arguments: { city: 'Oslo' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });
});

describe('Anthropic', () => {
  test('input_schema tools, tool_use blocks, tool_result grouped into one user turn', async () => {
    const body = capture({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Rome' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
    const res = await new AnthropicProvider({ apiKey: 'k' }).process({
      modelId: 'claude-3-5',
      messages: [...CONVERSATION, { role: 'tool', toolCallId: 'call_2', name: 'get_weather', content: 'x' }],
      tools: [weather],
      toolChoice: 'required',
    });
    const b = body();
    expect(b.tools).toEqual([{ name: 'get_weather', description: 'Current weather', input_schema: weather.parameters }]);
    expect(b.tool_choice).toEqual({ type: 'any' });
    expect(b.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }] });
    expect(b.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"city":"Oslo","tempC":21}' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'x' },
      ],
    });
    expect(res.data).toBe('Checking.');
    expect(res.toolCalls).toEqual([{ id: 'toolu_1', name: 'get_weather', arguments: { city: 'Rome' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('stream: tool_use block + input_json_delta pieces', async () => {
    stubStream([
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-5","usage":{"input_tokens":4}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"get_weather"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Oslo\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
    ]);
    const chunks = await collect(new AnthropicProvider({ apiKey: 'k' }).processStream({ modelId: 'claude-3-5', prompt: 'hi', tools: [weather] }));
    const done = chunks[chunks.length - 1];
    expect(done.toolCalls).toEqual([{ id: 'toolu_9', name: 'get_weather', arguments: { city: 'Oslo' } }]);
    expect(done.finishReason).toBe('tool_calls');
    expect(done.usage?.totalTokens).toBe(10);
  });
});

describe('Gemini', () => {
  test('functionDeclarations, functionCall/functionResponse parts, made-up ids', async () => {
    const body = capture({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }] }, finishReason: 'STOP' }] });
    const res = await new GeminiProvider({ apiKey: 'k' }).process({ modelId: 'gemini-2.0-flash', messages: CONVERSATION, tools: [weather], toolChoice: 'none' });
    const b = body();
    expect(b.tools).toEqual([{ functionDeclarations: [{ name: 'get_weather', description: 'Current weather', parameters: weather.parameters }] }]);
    expect(b.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(b.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }] });
    expect(b.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { city: 'Oslo', tempC: 21 } } }] });
    expect(res.toolCalls).toEqual([{ id: 'call_0', name: 'get_weather', arguments: { city: 'Rome' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('a plain-string tool result is wrapped as { result }', async () => {
    const body = capture({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    await new GeminiProvider({ apiKey: 'k' }).process({
      modelId: 'gemini-2.0-flash',
      messages: [CONVERSATION[0], CONVERSATION[1], { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: 'sunny' }],
      tools: [weather],
    });
    expect(body().contents[2].parts[0].functionResponse.response).toEqual({ result: 'sunny' });
  });

  test('stream: functionCall parts collected onto the done chunk', async () => {
    stubStream([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Oslo"}}}]},"finishReason":"STOP"}]}\n\n',
    ]);
    const chunks = await collect(new GeminiProvider({ apiKey: 'k' }).processStream({ modelId: 'gemini-2.0-flash', prompt: 'hi', tools: [weather] }));
    expect(chunks[chunks.length - 1].toolCalls).toEqual([{ id: 'call_0', name: 'get_weather', arguments: { city: 'Oslo' } }]);
  });
});

describe('Ollama', () => {
  test('OpenAI-format tools, object arguments, tool_name on results', async () => {
    const body = capture({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Rome' } } }] }, done: true, done_reason: 'stop' });
    const res = await new OllamaProvider().process({ modelId: 'llama3.1', messages: CONVERSATION, tools: [weather] });
    const b = body();
    expect(b.tools[0].function.name).toBe('get_weather');
    expect(b.messages[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }] });
    expect(b.messages[2]).toEqual({ role: 'tool', content: '{"city":"Oslo","tempC":21}', tool_name: 'get_weather' });
    expect(res.toolCalls).toEqual([{ id: 'call_0', name: 'get_weather', arguments: { city: 'Rome' } }]);
  });

  test('stream: tool_calls on a line, then done', async () => {
    stubStream([
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Oslo"}}}]},"done":false}\n',
      '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":1}\n',
    ]);
    const chunks = await collect(new OllamaProvider().processStream({ modelId: 'llama3.1', prompt: 'hi', tools: [weather] }));
    const done = chunks[chunks.length - 1];
    expect(done.toolCalls).toEqual([{ id: 'call_0', name: 'get_weather', arguments: { city: 'Oslo' } }]);
    expect(done.finishReason).toBe('tool_calls');
  });

  test('"does not support tools" → UNSUPPORTED with a hint', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'registry.ollama.ai/library/gemma:2b does not support tools' }), { status: 400 }));
    const res = await new OllamaProvider().process({ modelId: 'gemma:2b', prompt: 'hi', tools: [weather] });
    expect(res.errorInfo?.code).toBe('UNSUPPORTED');
    expect(res.errorInfo?.hint).toContain('tools');
  });
});

describe('recoverLeakedToolCalls', () => {
  test('first occurrence per tool wins, unknown names are left alone', () => {
    const out = recoverLeakedToolCalls(
      'a <function=get_weather>{"city":"A"}</function> b <function=get_weather>{"city":"B"}</function> <function=other>{}</function>',
      [weather]
    );
    expect(out.toolCalls).toEqual([{ id: 'leaked_0', name: 'get_weather', arguments: { city: 'A' } }]);
    expect(out.text).toBe('a  b  <function=other>{}</function>');
  });

  test('no tools → text untouched', () => {
    const text = '<function=get_weather>{}</function>';
    expect(recoverLeakedToolCalls(text, undefined)).toEqual({ text, toolCalls: [] });
  });
});

describe('factory maxSteps loop', () => {
  /** Answers with a call on the first turn and a final answer once a tool result is in the conversation. */
  function stepProvider(calls: AIRequest[], id = 'p'): AIProvider {
    return {
      providerId: id,
      providerName: id,
      supportedModels: ['m'],
      isModelSupported: () => true,
      discoverModels: async () => ['m'],
      testConnection: async () => true,
      process: async (req) => {
        calls.push(req);
        const sawResult = req.messages?.some((m) => m.role === 'tool');
        return sawResult
          ? { success: true, data: 'It is 21C in Oslo.', providerId: id, modelUsed: 'm', finishReason: 'stop' }
          : { success: true, data: '', providerId: id, modelUsed: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Oslo' } }] };
      },
      processStream: async function* (req) {
        calls.push(req);
        const sawResult = req.messages?.some((m) => m.role === 'tool');
        if (sawResult) {
          yield { text: 'It is ' };
          yield { text: '21C.' };
          yield { text: '', done: true, finishReason: 'stop', modelUsed: 'm' };
        } else {
          yield { text: '', done: true, finishReason: 'tool_calls', modelUsed: 'm', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Oslo' } }] };
        }
      },
    };
  }

  test('runs the tool, feeds the result back, reports steps', async () => {
    const seen: AIRequest[] = [];
    const factory = new AIFactory({ providers: [stepProvider(seen)], discover: 'none' });
    const res = await factory.process({ prompt: 'Weather in Oslo?', tools: [weather], toolChoice: 'required', maxSteps: 3 });
    expect(res.success).toBe(true);
    expect(res.data).toBe('It is 21C in Oslo.');
    expect(res.finishReason).toBe('stop');
    expect(res.steps).toHaveLength(1);
    expect(res.steps![0].toolResults).toEqual([{ toolCallId: 'c1', name: 'get_weather', result: { city: 'Oslo', tempC: 21 } }]);
    expect(seen).toHaveLength(2);
    expect(seen[1].prompt).toBeUndefined();
    expect(seen[1].toolChoice).toBeUndefined();
    expect(seen[1].messages).toEqual([
      { role: 'user', content: 'Weather in Oslo?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Oslo' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'get_weather', content: '{"city":"Oslo","tempC":21}' },
    ]);
  });

  test('maxSteps 1 (default) returns the calls without running anything', async () => {
    const seen: AIRequest[] = [];
    const factory = new AIFactory({ providers: [stepProvider(seen)], discover: 'none' });
    const res = await factory.process({ prompt: 'x', tools: [weather] });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.steps).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  test('a tool without execute stops the loop; a throwing tool reports { error } to the model', async () => {
    const seen: AIRequest[] = [];
    const factory = new AIFactory({ providers: [stepProvider(seen)], discover: 'none' });
    const manual = await factory.process({ prompt: 'x', tools: [{ ...weather, execute: undefined }], maxSteps: 3 });
    expect(manual.toolCalls).toHaveLength(1);
    expect(seen).toHaveLength(1);

    const boom: Tool = { ...weather, execute: async () => { throw new Error('offline'); } };
    const res = await factory.process({ prompt: 'x', tools: [boom], maxSteps: 3 });
    expect(res.success).toBe(true);
    expect(res.steps![0].toolResults[0]).toEqual({ toolCallId: 'c1', name: 'get_weather', error: 'offline' });
    expect(seen[2].messages![2]).toMatchObject({ role: 'tool', content: '{"error":"offline"}' });
  });

  test('stream: intermediate calls as tool-call chunks, one done chunk at the end', async () => {
    const seen: AIRequest[] = [];
    const factory = new AIFactory({ providers: [stepProvider(seen)], discover: 'none' });
    const chunks = await collect(factory.processStream({ prompt: 'x', tools: [weather], maxSteps: 3 }));
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'tool-call', text: '', toolCall: { id: 'c1', name: 'get_weather' } });
    expect(chunks.map((c) => c.text).join('')).toBe('It is 21C.');
    expect(chunks[chunks.length - 1].finishReason).toBe('stop');
    expect(seen[1].messages?.[2]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });
});

test('nextStepRequest keeps history-based requests working', () => {
  const next = nextStepRequest({ history: [{ role: 'user', content: 'a' }], prompt: 'b', tools: [weather] }, '', [{ id: '1', name: 'get_weather', arguments: {} }], [{ toolCallId: '1', name: 'get_weather', result: 1 }]);
  expect(next.history).toBeUndefined();
  expect(next.messages?.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool']);
});
