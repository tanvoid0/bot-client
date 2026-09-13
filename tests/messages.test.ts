/**
 * `messages[]` with image parts: one wire shape per provider, the deprecated
 * `history` still honoured, and the request guard in the factory.
 */
import { OpenAIProvider } from '../src/providers/openai-provider.js';
import { AnthropicProvider } from '../src/providers/anthropic-provider.js';
import { GeminiProvider } from '../src/providers/gemini-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { buildChatMessages, inlineImage } from '../src/providers/base-provider.js';
import { AIFactory } from '../src/ai-factory.js';
import type { AIRequest } from '../src/types/index.js';

// 1x1 PNG, as bytes and as the same bytes base64-encoded.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

const REQUEST: AIRequest = {
  systemPrompt: 'Be brief.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', data: PNG }] },
    { role: 'assistant', content: 'A dot.' },
  ],
  prompt: 'And this?',
};

/** Captures the JSON body the provider sends and answers with `reply`. */
function capture(reply: unknown) {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
  return () => JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
}

afterEach(() => jest.restoreAllMocks());

describe('buildChatMessages', () => {
  test('systemPrompt, then messages, then prompt as a user turn', () => {
    expect(buildChatMessages(REQUEST).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  test('messages alone, no prompt', () => {
    expect(buildChatMessages({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('a removed 1.x field fails loudly at the factory', async () => {
    const factory = new AIFactory({ providers: [new OpenAIProvider({ apiKey: 'k', models: ['gpt-4o'] })], discover: 'none' });
    const res = await factory.process({ prompt: 'p', history: [{ role: 'user', content: 'old' }] } as AIRequest);
    expect(res.errorInfo?.code).toBe('INVALID_REQUEST');
    expect(res.errorInfo?.message).toContain('history was removed in 2.0');
    expect(res.errorInfo?.hint).toContain('messages');
  });
});

describe('inlineImage', () => {
  test('bytes → base64 with the mime type sniffed', () => {
    expect(inlineImage({ type: 'image', data: PNG })).toEqual({ mimeType: 'image/png', data: PNG_B64 });
  });

  test('base64 string kept as is; explicit mimeType wins', () => {
    expect(inlineImage({ type: 'image', data: '/9j/abc', mimeType: 'image/jpg' })).toEqual({ mimeType: 'image/jpg', data: '/9j/abc' });
    expect(inlineImage({ type: 'image', data: '/9j/abc' })?.mimeType).toBe('image/jpeg');
  });

  test('data: URL parsed', () => {
    expect(inlineImage({ type: 'image', url: `data:image/webp;base64,${PNG_B64}` })).toEqual({ mimeType: 'image/webp', data: PNG_B64 });
  });

  test('remote URL → undefined', () => {
    expect(inlineImage({ type: 'image', url: 'https://x/y.png' })).toBeUndefined();
  });
});

test('OpenAI: text + image_url parts with a data: URL; plain strings untouched', async () => {
  const body = capture({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  await new OpenAIProvider({ apiKey: 'k' }).process({ ...REQUEST, modelId: 'gpt-4o' });
  const { messages } = body();
  expect(messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
  expect(messages[1].content).toEqual([
    { type: 'text', text: 'What is this?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
  ]);
  expect(messages[2]).toEqual({ role: 'assistant', content: 'A dot.' });
  expect(messages[3]).toEqual({ role: 'user', content: 'And this?' });
});

test('OpenAI: a remote image URL is passed through', async () => {
  const body = capture({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  await new OpenAIProvider({ apiKey: 'k' }).process({
    modelId: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x/y.png' }] }],
  });
  expect(body().messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'https://x/y.png' } });
});

test('Anthropic: base64 source, url source, system stays top-level', async () => {
  const body = capture({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  await new AnthropicProvider({ apiKey: 'k' }).process({
    ...REQUEST,
    messages: [...REQUEST.messages!, { role: 'user', content: [{ type: 'image', url: 'https://x/y.png' }] }],
  });
  const b = body();
  expect(b.system).toBe('Be brief.');
  expect(b.messages[0].content).toEqual([
    { type: 'text', text: 'What is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
  ]);
  expect(b.messages[2].content).toEqual([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
});

test('Gemini: inlineData for bytes, fileData for a URI', async () => {
  const body = capture({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  await new GeminiProvider({ apiKey: 'k' }).process({
    ...REQUEST,
    messages: [...REQUEST.messages!, { role: 'user', content: [{ type: 'image', url: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'image/png' }] }],
  });
  const b = body();
  expect(b.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  expect(b.contents[0]).toEqual({ role: 'user', parts: [{ text: 'What is this?' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] });
  expect(b.contents[1]).toEqual({ role: 'model', parts: [{ text: 'A dot.' }] });
  expect(b.contents[2].parts[0]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } });
});

test('Ollama: images[] of base64 next to the text; a remote URL is UNSUPPORTED', async () => {
  const body = capture({ message: { content: 'ok' }, done: true, done_reason: 'stop' });
  const ollama = new OllamaProvider();
  await ollama.process({ ...REQUEST, modelId: 'llava' });
  expect(body().messages[1]).toEqual({ role: 'user', content: 'What is this?', images: [PNG_B64] });

  const res = await ollama.process({ modelId: 'llava', messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x/y.png' }] }] });
  expect(res.success).toBe(false);
  expect(res.errorInfo?.code).toBe('UNSUPPORTED');
  expect(res.errorInfo?.hint).toContain('data');
});

test('factory: neither prompt nor messages → INVALID_REQUEST without touching a provider', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  const factory = new AIFactory({ providers: [new OpenAIProvider({ apiKey: 'k', models: ['gpt-4o'] })], discover: 'none' });
  const res = await factory.process({} as AIRequest);
  expect(res.success).toBe(false);
  expect(res.errorInfo?.code).toBe('INVALID_REQUEST');
  await expect(factory.processStream({ messages: [] }).next()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(fetchMock).not.toHaveBeenCalled();
});
