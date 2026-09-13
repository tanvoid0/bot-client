import { Readable } from 'stream';
import { streamLines } from '../src/providers/base-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import type { AIStreamChunk } from '../src/index.js';

/** Feeds bytes in exactly the pieces given, framing be damned. */
const chunked = (pieces: string[]) => Readable.from(pieces.map((p) => Buffer.from(p)));

/** `fetch` answering 200 with the pieces as the streamed body. (A hand-rolled ReadableStream: `Readable.toWeb` misbehaves on Node 18.) */
function stubStream(pieces: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(Buffer.from(p));
      controller.close();
    },
  });
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

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
    // Gemini frames events with CRLF and a blank line; a network read can end mid-frame.
    const fetchMock = stubStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"there"}]},"finishReason":"STOP"}],',
      '"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}\r\n\r\n',
    ]);

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
    expect(last.finishReason).toBe('stop');
    expect(last.usage).toEqual({
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
    });
    // Streaming endpoint, SSE framing.
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.pathname).toContain(':streamGenerateContent');
    expect(url.searchParams.get('alt')).toBe('sse');
    // The caller's abort reaches the request.
    const sent = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    expect(sent.aborted).toBe(false);
    controller.abort();
    expect(sent.aborted).toBe(true);
  });

  it('skips a frame that is not JSON rather than failing the answer', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    stubStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\r\n\r\n',
      'data: {broken\r\n\r\n',
    ]);

    const chunks = await collect(provider.processStream({ prompt: 'hi' }));
    expect(chunks.map((c) => c.text).join('')).toBe('ok');
  });
});

describe('OllamaProvider.processStream', () => {
  it('reads NDJSON and reports the token counts', async () => {
    const provider = new OllamaProvider({});
    const fetchMock = stubStream([
      '{"message":{"content":"one "}}\n{"message":{"content":"two"}}\n',
      '{"done":true,"prompt_eval_count":5,"eval_count":3}\n',
    ]);

    const controller = new AbortController();
    const chunks = await collect(
      provider.processStream({ prompt: 'hi', modelId: 'gemma4', signal: controller.signal }),
    );

    expect(chunks.map((c) => c.text).join('')).toBe('one two');
    expect(chunks[chunks.length - 1].usage?.totalTokens).toBe(8);
    // The caller's abort reaches the request.
    const sent = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    controller.abort();
    expect(sent.aborted).toBe(true);
  });

  it('throws on a mid-stream error line instead of ending silently', async () => {
    const provider = new OllamaProvider({});
    stubStream([
      '{"message":{"content":"partial "}}\n',
      '{"error":"model runner crashed"}\n',
    ]);

    await expect(collect(provider.processStream({ prompt: 'hi', modelId: 'gemma4' }))).rejects.toThrow(
      'model runner crashed',
    );
  });
});
