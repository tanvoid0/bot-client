import { Readable } from 'stream';
import { streamLines } from '../src/providers/base-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import type { AIStreamChunk } from '../src/index.js';

/** Feeds bytes in exactly the pieces given, framing be damned. */
const chunked = (pieces: string[]) => Readable.from(pieces.map((p) => Buffer.from(p)));

async function collect(
  stream: AsyncGenerator<AIStreamChunk, void, void>,
): Promise<AIStreamChunk[]> {
  const out: AIStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('streamLines', () => {
  it('joins a line split across reads, and yields the tail', async () => {
    const lines: string[] = [];
    for await (const line of streamLines(chunked(['one\ntw', 'o\nthree']))) {
      lines.push(line);
    }
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('reassembles a multi-byte char split across chunk boundaries', async () => {
    const bytes = Buffer.from('{"text":"café"}\n'); // "café"
    const cut = bytes.indexOf(0xa9); // splits the 0xC3 0xA9 pair of 'é'
    const lines: string[] = [];
    for await (const line of streamLines(
      Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]),
    )) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"text":"café"}']);
    expect(lines[0]).not.toContain('�');
  });
});

describe('GeminiProvider.processStream', () => {
  it('yields text as it arrives and usage at the end', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    const post = jest.fn().mockResolvedValue({
      data: chunked([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"there"}]}}],',
        '"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}\n',
        'data: [DONE]\n',
      ]),
    });
    (provider as unknown as { _client: unknown })._client = { post };

    const controller = new AbortController();
    const chunks = await collect(
      provider.processStream({
        prompt: 'hi',
        modelId: 'gemini-2.0-flash',
        signal: controller.signal,
      }),
    );

    expect(chunks.map((c) => c.text).join('')).toBe('Hello there');
    const last = chunks[chunks.length - 1];
    expect(last.done).toBe(true);
    expect(last.usage).toEqual({
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
    });
    // Streaming endpoint, SSE framing.
    expect(post.mock.calls[0][0]).toContain(':streamGenerateContent');
    expect(post.mock.calls[0][2].params.alt).toBe('sse');
    // No socket idle timeout, and the caller's abort signal is wired through.
    expect(post.mock.calls[0][2].timeout).toBe(0);
    expect(post.mock.calls[0][2].signal).toBe(controller.signal);
  });

  it('skips a frame that is not JSON rather than failing the answer', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    (provider as unknown as { _client: unknown })._client = {
      post: jest.fn().mockResolvedValue({
        data: chunked([
          'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n',
          'data: {broken\n',
        ]),
      }),
    };

    const chunks = await collect(provider.processStream({ prompt: 'hi' }));
    expect(chunks.map((c) => c.text).join('')).toBe('ok');
  });
});

describe('OllamaProvider.processStream', () => {
  it('reads NDJSON and reports the token counts', async () => {
    const provider = new OllamaProvider({});
    const post = jest.fn().mockResolvedValue({
      data: chunked([
        '{"message":{"content":"one "}}\n{"message":{"content":"two"}}\n',
        '{"done":true,"prompt_eval_count":5,"eval_count":3}\n',
      ]),
    });
    (provider as unknown as { createClient: unknown }).createClient = () => ({ post });

    const controller = new AbortController();
    const chunks = await collect(
      provider.processStream({ prompt: 'hi', modelId: 'gemma4', signal: controller.signal }),
    );

    expect(chunks.map((c) => c.text).join('')).toBe('one two');
    expect(chunks[chunks.length - 1].usage?.totalTokens).toBe(8);
    // No socket idle timeout, and the caller's abort signal is wired through.
    expect(post.mock.calls[0][2].timeout).toBe(0);
    expect(post.mock.calls[0][2].signal).toBe(controller.signal);
  });

  it('throws on a mid-stream error line instead of ending silently', async () => {
    const provider = new OllamaProvider({});
    const post = jest.fn().mockResolvedValue({
      data: chunked([
        '{"message":{"content":"partial "}}\n',
        '{"error":"model runner crashed"}\n',
      ]),
    });
    (provider as unknown as { createClient: unknown }).createClient = () => ({ post });

    await expect(collect(provider.processStream({ prompt: 'hi' }))).rejects.toThrow(
      'model runner crashed',
    );
  });
});
