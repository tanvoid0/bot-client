import { splitThinkTags, ThinkFilter } from '../src/core/reasoning.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import type { AIStreamChunk } from '../src/index.js';

function stubJson(reply: unknown) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
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

async function collect(stream: AsyncGenerator<AIStreamChunk, void, void>) {
  const chunks: AIStreamChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return {
    chunks,
    text: chunks.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    reasoning: chunks.map((c) => (c.type === 'reasoning' ? c.text : '')).join(''),
  };
}

const sse = (frames: unknown[]) => [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'];

afterEach(() => jest.restoreAllMocks());

describe('ThinkFilter', () => {
  it('splits a tag that arrives across two deltas without leaking tag text', () => {
    const f = new ThinkFilter();
    const a = f.push('<thi');
    const b = f.push('nk>plan');
    const c = f.push('</think>answer');
    const tail = f.flush();
    expect(a).toEqual({ text: '', reasoning: '' });
    expect(b).toEqual({ text: '', reasoning: 'plan' });
    expect(c).toEqual({ text: 'answer', reasoning: '' });
    expect(tail).toEqual({ text: '', reasoning: '' });
  });

  it('releases a held suffix that turned out not to be a tag', () => {
    const f = new ThinkFilter();
    expect(f.push('a <b')).toEqual({ text: 'a <b', reasoning: '' });
    expect(f.push('1 <')).toEqual({ text: '1 ', reasoning: '' });
    expect(f.flush()).toEqual({ text: '<', reasoning: '' });
  });

  it('splitThinkTags handles the whole-answer form', () => {
    expect(splitThinkTags('<think>\nhmm\n</think>\n\nThe answer.')).toEqual({ text: 'The answer.', reasoning: 'hmm' });
    expect(splitThinkTags('plain')).toEqual({ text: 'plain', reasoning: '' });
  });
});

describe('OpenAI format, reasoning as a field', () => {
  const provider = () => new OpenAICompatibleProvider({ id: 'test', baseURL: 'http://x', models: ['m'] });

  it('non-stream: reasoning_content is surfaced beside the answer', async () => {
    stubJson({
      choices: [{ message: { content: 'The answer.', reasoning_content: 'Let me think.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    const res = await provider().process({ prompt: 'q' });
    expect(res.data).toBe('The answer.');
    expect(res.reasoning).toBe('Let me think.');
  });

  it('stream: reasoning deltas come first, as reasoning chunks with empty text', async () => {
    stubStream(
      sse([
        { choices: [{ delta: { reasoning_content: 'Let me ' } }] },
        { choices: [{ delta: { reasoning: 'think.' } }] },
        { choices: [{ delta: { content: 'The ' } }] },
        { choices: [{ delta: { content: 'answer.' }, finish_reason: 'stop' }] },
      ])
    );
    const out = await collect(provider().processStream({ prompt: 'q' }));
    expect(out.reasoning).toBe('Let me think.');
    expect(out.text).toBe('The answer.');
    expect(out.chunks[out.chunks.length - 1]).toMatchObject({ type: 'done', finishReason: 'stop' });
  });
});

describe('OpenAI format, reasoning inline as <think> tags', () => {
  const provider = () => new OpenAICompatibleProvider({ id: 'test', baseURL: 'http://x', models: ['m'] });

  it('non-stream: tags are stripped from data into reasoning', async () => {
    stubJson({ choices: [{ message: { content: '<think>plan it</think>\n\nDone.' }, finish_reason: 'stop' }] });
    const res = await provider().process({ prompt: 'q' });
    expect(res.data).toBe('Done.');
    expect(res.reasoning).toBe('plan it');
  });

  it('stream: a tag split across frames never reaches text', async () => {
    stubStream(
      sse([
        { choices: [{ delta: { content: '<thi' } }] },
        { choices: [{ delta: { content: 'nk>plan' } }] },
        { choices: [{ delta: { content: ' it</think>Done' } }] },
        { choices: [{ delta: { content: '.' }, finish_reason: 'stop' }] },
      ])
    );
    const out = await collect(provider().processStream({ prompt: 'q' }));
    expect(out.reasoning).toBe('plan it');
    expect(out.text).toBe('Done.');
    expect(out.text).not.toContain('<');
  });
});

describe('Ollama reasoning', () => {
  it('sends think:false by default and think:true with reasoning:true', async () => {
    const fetchMock = stubJson({ message: { content: 'x' }, done_reason: 'stop' });
    await new OllamaProvider().process({ prompt: 'q', modelId: 'm' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).think).toBe(false);
    await new OllamaProvider().process({ prompt: 'q', modelId: 'm', reasoning: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).think).toBe(true);
  });

  it('non-stream: message.thinking becomes reasoning', async () => {
    stubJson({ message: { content: 'Answer.', thinking: 'Thought.' }, done_reason: 'stop' });
    const res = await new OllamaProvider().process({ prompt: 'q', modelId: 'm', reasoning: true });
    expect(res.data).toBe('Answer.');
    expect(res.reasoning).toBe('Thought.');
  });

  it('stream: thinking deltas are reasoning chunks', async () => {
    stubStream([
      '{"message":{"thinking":"Th"}}\n{"message":{"thinking":"ought."}}\n',
      '{"message":{"content":"Answer."}}\n{"done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":2}\n',
    ]);
    const out = await collect(new OllamaProvider().processStream({ prompt: 'q', modelId: 'm', reasoning: true }));
    expect(out.reasoning).toBe('Thought.');
    expect(out.text).toBe('Answer.');
  });
});

describe('Anthropic reasoning', () => {
  it('reasoning:true enables extended thinking with temperature 1 and returns thinking blocks', async () => {
    const fetchMock = stubJson({
      content: [{ type: 'thinking', thinking: 'Deep thought.' }, { type: 'text', text: 'Answer.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const res = await new AnthropicProvider({ apiKey: 'k' }).process({ prompt: 'q', reasoning: true, maxTokens: 4000 });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
    expect(body.temperature).toBe(1);
    expect(res.reasoning).toBe('Deep thought.');
    expect(res.data).toBe('Answer.');
  });
});
