/** Real SSE streaming for the providers that speak it: OpenAI/LM Studio (shared path) and Anthropic. */
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { LMStudioProvider } from '../src/providers/lmstudio-provider.js';
import type { AIStreamChunk, DoneChunk } from '../src/index.js';

/** `fetch` answering 200 with the pieces as the streamed body (same helper as tests/streaming.test.ts). */
function stubStream(pieces: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(Buffer.from(p));
      controller.close();
    },
  });
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
}

async function collect(stream: AsyncGenerator<AIStreamChunk, void, void>): Promise<AIStreamChunk[]> {
  const out: AIStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

afterEach(() => jest.restoreAllMocks());

describe('OpenAIProvider streaming', () => {
  test('joins delta text, reports finishReason/usage, and requests usage on the stream', async () => {
    const fetchMock = stubStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = new OpenAIProvider({ apiKey: 'k' });
    const chunks = await collect(provider.processStream({ prompt: 'hi', modelId: 'gpt-4o' }));

    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toBe('Hello');
    const last = (chunks[chunks.length - 1] as DoneChunk);
    expect(last.type).toBe('done');
    expect(last.finishReason).toBe('stop');
    expect(last.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('AnthropicProvider streaming', () => {
  test('joins text deltas, reports finishReason length and combined usage', async () => {
    stubStream([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi there"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const provider = new AnthropicProvider({ apiKey: 'k' });
    const chunks = await collect(provider.processStream({ prompt: 'hi', modelId: 'claude-3-5' }));

    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toBe('Hi there');
    const last = (chunks[chunks.length - 1] as DoneChunk);
    expect(last.type).toBe('done');
    expect(last.finishReason).toBe('length');
    expect(last.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(last.modelUsed).toBe('claude-x');
  });

  test('an error event mid-stream rejects with the classified AIError', async () => {
    stubStream([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":10}}}\n\n',
      'event: error\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);
    const provider = new AnthropicProvider({ apiKey: 'k' });
    await expect(collect(provider.processStream({ prompt: 'hi', modelId: 'claude-3-5' }))).rejects.toMatchObject({
      code: 'OVERLOADED',
      message: 'Overloaded',
    });
  });

  test('jsonMode puts the JSON instruction in the system field', async () => {
    const fetchMock = stubStream(['event: message_stop\n', 'data: {"type":"message_stop"}\n\n']);
    const provider = new AnthropicProvider({ apiKey: 'k' });
    await collect(provider.processStream({ prompt: 'hi', modelId: 'claude-3-5', jsonMode: true }));
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.system).toContain('JSON');
  });

  test('discoverModels reads GET /v1/models data[].id', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-3-5' }, { id: 'claude-3-haiku' }] }), { status: 200 }));
    const models = await new AnthropicProvider({ apiKey: 'k' }).discoverModels();
    expect(models).toEqual(['claude-3-5', 'claude-3-haiku']);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/v1/models');
  });
});

describe('LMStudioProvider streaming', () => {
  test('streams via the shared OpenAI-compatible SSE path', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = new LMStudioProvider({ models: ['local-model'] });
    const chunks = await collect(provider.processStream({ prompt: 'hi' }));
    expect(chunks.map((c) => (c.type === 'text' ? c.text : '')).join('')).toBe('Hi');
    expect((chunks[chunks.length - 1] as DoneChunk).finishReason).toBe('stop');
  });
});
