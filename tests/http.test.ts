/** Direct coverage of src/core/http.ts: the wire-format parsers and the fetch wrapper's timeout/idle/abort handling. */
import { Readable } from 'stream';
import { parseSSE, parseNDJSON, streamLines, httpStream, httpJson } from '../src/core/http.js';
import { toAIError } from '../src/core/errors.js';

async function* toStream(...chunks: string[]): AsyncGenerator<string, void, void> {
  for (const c of chunks) yield c;
}

afterEach(() => jest.restoreAllMocks());

describe('parseSSE', () => {
  test('event/data frames, CRLF, comments, multi-line data, and a trailing frame with no final blank line', async () => {
    const input = [
      ': this is a comment, ignored\n',
      'event: greeting\r\n',
      'data: line one\r\n',
      'data: line two\r\n',
      '\r\n',
      'data: {"x":1}\n',
      '\n',
      'event: tail\n',
      'data: no trailing blank line',
    ].join('');
    const events: { event?: string; data: string }[] = [];
    for await (const e of parseSSE(toStream(input))) events.push(e);
    expect(events).toEqual([
      { event: 'greeting', data: 'line one\nline two' },
      { event: undefined, data: '{"x":1}' },
      { event: 'tail', data: 'no trailing blank line' },
    ]);
  });

  test('a frame split across separate reads is still dispatched once', async () => {
    const events: { event?: string; data: string }[] = [];
    for await (const e of parseSSE(toStream('data: hel', 'lo\n\n'))) events.push(e);
    expect(events).toEqual([{ event: undefined, data: 'hello' }]);
  });
});

describe('parseNDJSON', () => {
  test('skips a line that does not parse as JSON', async () => {
    const items: unknown[] = [];
    for await (const item of parseNDJSON(toStream('{"a":1}\nnot json\n{"b":2}\n'))) items.push(item);
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('streamLines', () => {
  test('reassembles a multi-byte char split across chunk boundaries', async () => {
    const bytes = Buffer.from('{"text":"café"}\n');
    const cut = bytes.indexOf(0xa9); // splits the 0xC3 0xA9 pair of 'é'
    const lines: string[] = [];
    for await (const line of streamLines(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"text":"café"}']);
    expect(lines[0]).not.toContain('�');
  });
});

describe('httpStream idle timeout', () => {
  // The source never closes and never gets another chunk; the idle clock has to end it.
  it('fails with STREAM_IDLE when upstream goes silent past idleTimeout', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
        // Never enqueues again or closes: upstream has gone quiet.
      },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));

    const stream = await httpStream('http://x.test/stream', { idleTimeout: 50 });
    const it = stream[Symbol.asyncIterator]();
    await it.next(); // the first chunk arrives fine
    const started = Date.now();
    await expect(it.next()).rejects.toMatchObject({ code: 'STREAM_IDLE' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('breaking out of a for-await early aborts the signal sent to fetch', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.enqueue(new TextEncoder().encode('b'));
      },
    });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));

    const stream = await httpStream('http://x.test/stream');
    for await (const _chunk of stream) {
      break;
    }
    const sent = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    expect(sent.aborted).toBe(true);
  });
});

describe('httpJson timeout and abort', () => {
  test('rejects with TIMEOUT when fetch never resolves, honouring the abort signal', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    await expect(httpJson('http://x.test/json', { timeout: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('a caller abort propagates as AbortError and toAIError classifies it as ABORTED', async () => {
    const controller = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    const promise = httpJson('http://x.test/json', { signal: controller.signal });
    controller.abort(); // default reason
    const err = await promise.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(toAIError(err, { provider: 'x' }).code).toBe('ABORTED');
  });
});
