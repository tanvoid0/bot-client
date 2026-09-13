import type { AIRequest, AIResponse, AIStreamChunk, BaseProviderConfig, FinishReason } from '../types/index.js';
import type { Refinement } from '../core/errors.js';
import { BaseProvider, buildChatMessages, firstEnv, inlineImage, mergeBody, partsOf, totalTokens } from './base-provider.js';
import { openaiToolChoice, openaiTools, parseArgs, recoverLeakedToolCalls, stringifyArgs } from '../core/tools.js';
import { jsonSchemaOf, wantsJson } from '../core/schema.js';
import type { ToolCall } from '../types/index.js';
import { parseSSE } from '../core/http.js';
import { splitThinkTags, ThinkFilter } from '../core/reasoning.js';

/**
 * Hosts with a known origin and key variable. `new OpenAICompatibleProvider({ preset: 'groq' })`
 * reads `GROQ_API_KEY`; any field given alongside overrides the preset.
 */
export const PRESETS = {
  groq: { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: ['GROQ_API_KEY'] },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: ['OPENROUTER_API_KEY'] },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: ['DEEPSEEK_API_KEY'] },
  // Mistral rejects unknown fields (422) and reports usage on the last chunk anyway.
  mistral: { name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: ['MISTRAL_API_KEY'], streamUsage: false },
  xai: { name: 'xAI', baseURL: 'https://api.x.ai/v1', apiKeyEnv: ['XAI_API_KEY'] },
  together: { name: 'Together', baseURL: 'https://api.together.xyz/v1', apiKeyEnv: ['TOGETHER_API_KEY'] },
  /** The agent-platform `/v1` proxy: local, bearer-authenticated, emits `AIErrorCode` names in `error.code`. */
  'agent-platform': { name: 'agent-platform', baseURL: 'http://127.0.0.1:18410/v1', apiKeyEnv: ['AGENT_PLATFORM_KEY'] },
} as const satisfies Record<string, Omit<OpenAICompatibleConfig, 'preset'>>;

export type PresetId = keyof typeof PRESETS;

export interface OpenAICompatibleConfig extends BaseProviderConfig {
  /** A shipped host (`groq`, `openrouter`, ...): fills `id`, `name`, `baseURL`, `apiKeyEnv` and `requireApiKey`. */
  preset?: PresetId;
  /** Provider id used in routing and errors (`openai`, `groq`, ...). */
  id?: string;
  /** Display name. */
  name?: string;
  apiKey?: string;
  /** Origin, with or without `/v1` (`https://api.groq.com/openai/v1`, `http://localhost:1234`). */
  baseURL?: string;
  /** Keep only these ids from `GET /models`. Default: keep all. */
  modelFilter?: (id: string) => boolean;
  /** Used when the request names no model and discovery found none. */
  defaultModel?: string;
  /** `max_tokens` when the request sets none. Default: omit (provider default). */
  defaultMaxTokens?: number;
  /** Refuse requests without an API key (cloud APIs). Default false. */
  requireApiKey?: boolean;
  /** Send `stream_options: { include_usage: true }` on streams. Default true. */
  streamUsage?: boolean;
  /** Environment variables consulted for the key, in order. */
  apiKeyEnv?: string[];
}

function finishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * Any server speaking the OpenAI chat-completions dialect: OpenAI itself,
 * LM Studio, Groq, OpenRouter, DeepSeek, Mistral, xAI, Together, vLLM, ...
 */
export class OpenAICompatibleProvider extends BaseProvider {
  protected readonly apiKey?: string;
  protected readonly v1: string;
  private readonly cfg: OpenAICompatibleConfig;
  private readonly authHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleConfig = {}) {
    const preset = config.preset && PRESETS[config.preset];
    const cfg: OpenAICompatibleConfig = preset ? { id: config.preset, requireApiKey: true, ...preset, ...config } : config;
    super(cfg);
    this.cfg = cfg;
    const base = (cfg.baseURL ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.v1 = base.endsWith('/v1') ? base : `${base}/v1`;
    this.apiKey = cfg.apiKey ?? firstEnv(cfg.apiKeyEnv ?? []);
    this.authHeaders = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  get providerId(): string {
    return this.cfg.id ?? 'openai-compatible';
  }

  get providerName(): string {
    return this.cfg.name ?? this.providerId;
  }

  protected get baseURL(): string {
    return this.v1;
  }

  async testConnection(): Promise<boolean> {
    if (this.cfg.requireApiKey && !this.apiKey) return false;
    if (this.cached()) return true;
    try {
      await this.http(`${this.v1}/models`, { headers: this.authHeaders });
      return true;
    } catch {
      return false;
    }
  }

  async discoverModels(): Promise<string[]> {
    if (this.cfg.requireApiKey && !this.apiKey) return [];
    const hit = this.cached();
    if (hit) return hit;
    try {
      const response = await this.http(`${this.v1}/models`, { headers: this.authHeaders });
      // Together answers with a bare array instead of `{ data: [...] }`.
      const ids: string[] = (Array.isArray(response) ? response : response?.data ?? [])
        .map((m: { id?: string }) => m.id)
        .filter((id: unknown): id is string => typeof id === 'string');
      return this.setDiscovered(this.cfg.modelFilter ? ids.filter(this.cfg.modelFilter) : ids);
    } catch {
      return this._supportedModels;
    }
  }

  protected classify(status: number, json: any): Refinement {
    const code: string | undefined = json?.error?.code ?? json?.error?.type;
    const message: string = json?.error?.message ?? '';
    const out: Refinement = { providerCode: code };
    if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') out.code = 'QUOTA';
    else if (code === 'invalid_api_key' || status === 401) out.code = 'AUTH';
    else if (code === 'model_not_found' || /model .* (does not exist|not found)/i.test(message)) out.code = 'MODEL_NOT_FOUND';
    else if (code === 'context_length_exceeded' || /maximum context length|context length|too many tokens/i.test(message))
      out.code = 'CONTEXT_LENGTH';
    else if (code === 'rate_limit_exceeded' || status === 429) out.code = 'RATE_LIMIT';
    else if (code === 'server_error' || code === 'engine_overloaded') out.code = 'OVERLOADED';
    return out;
  }

  protected resolveModel(request: AIRequest): string | undefined {
    return request.modelId ?? this.supportedModels[0] ?? this.cfg.defaultModel;
  }

  protected body(request: AIRequest, model: string, stream: boolean): Record<string, unknown> {
    const maxTokens = request.maxTokens ?? this.cfg.defaultMaxTokens;
    const messages = buildChatMessages(request).map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: stringifyArgs(c.arguments) } })),
        };
      }
      if (typeof m.content === 'string') return m;
      return {
        role: m.role,
        content: partsOf(m.content).map((p) => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          const inline = inlineImage(p);
          return { type: 'image_url', image_url: { url: inline ? `data:${inline.mimeType};base64,${inline.data}` : p.url } };
        }),
      };
    });
    return mergeBody(
      {
        model,
        messages,
        ...(request.tools?.length && {
          tools: openaiTools(request.tools),
          ...(request.toolChoice && { tool_choice: openaiToolChoice(request.toolChoice) }),
        }),
        ...(maxTokens !== undefined && { max_tokens: maxTokens }),
        temperature: request.temperature ?? 0.7,
        ...(wantsJson(request) && { response_format: responseFormat(request) }),
        ...(stream && { stream: true }),
        ...(stream && this.cfg.streamUsage !== false && { stream_options: { include_usage: true } }),
      },
      request.providerOptions
    );
  }

  private missing(request: AIRequest): AIResponse | null {
    if (this.cfg.requireApiKey && !this.apiKey) {
      return this.fail(this.error('NO_API_KEY', `${this.providerName} API key required`));
    }
    if (!this.resolveModel(request)) {
      return this.fail(this.error('NO_MODEL', `No model available on ${this.providerName}`));
    }
    return null;
  }

  async process(request: AIRequest): Promise<AIResponse> {
    const blocked = this.missing(request);
    if (blocked) return blocked;
    const model = this.resolveModel(request)!;
    try {
      const { data, headers } = await this.httpFull(`${this.v1}/chat/completions`, {
        headers: this.authHeaders,
        body: this.body(request, model, false),
        ...this.requestOptions(request),
      });
      const choice = data?.choices?.[0];
      const usage = data?.usage;
      const split = splitThinkTags(choice?.message?.content ?? '');
      const field = reasoningField(choice?.message);
      let toolCalls = toolCallsOf(choice?.message?.tool_calls);
      let text = split.text;
      if (!toolCalls.length) ({ text, toolCalls } = recoverLeakedToolCalls(text, request.tools));
      return this.ok(text, {
        reasoning: [field, split.reasoning].filter(Boolean).join('\n') || undefined,
        modelUsed: data?.model ?? model,
        finishReason: finishReason(choice?.finish_reason),
        toolCalls,
        requestId: headers.get('x-request-id') ?? undefined,
        usage: usage && {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens ?? totalTokens(usage.prompt_tokens, usage.completion_tokens),
          ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
            cachedTokens: usage.prompt_tokens_details.cached_tokens,
          }),
        },
      });
    } catch (error) {
      return this.fail(this.toError(error, model), model);
    }
  }

  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const blocked = this.missing(request);
    if (blocked) throw blocked.errorInfo;
    const model = this.resolveModel(request)!;
    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await this.httpStream(`${this.v1}/chat/completions`, {
        headers: this.authHeaders,
        body: this.body(request, model, true),
        ...this.requestOptions(request),
      });
    } catch (error) {
      throw this.toError(error, model);
    }

    let finish: FinishReason | undefined;
    let usage: AIStreamChunk['usage'];
    let modelUsed = model;
    const think = new ThinkFilter();
    // Tool call deltas arrive by index: the id and name first, then argument text in pieces.
    const calls: Array<{ id?: string; name?: string; args: string }> = [];
    try {
      for await (const { data } of parseSSE(stream)) {
        if (data === '[DONE]') break;
        let frame: any;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        if (frame?.error) throw this.error('UNKNOWN', frame.error.message ?? 'stream error', { model, details: frame.error });
        if (typeof frame?.model === 'string') modelUsed = frame.model;
        const choice = frame?.choices?.[0];
        const thinking = reasoningField(choice?.delta);
        if (thinking) yield { text: '', reasoning: thinking, modelUsed };
        const text = choice?.delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          const part = think.push(text);
          if (part.reasoning) yield { text: '', reasoning: part.reasoning, modelUsed };
          if (part.text) yield { text: part.text, modelUsed };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const slot = (calls[tc.index ?? calls.length] ??= { args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
        }
        if (choice?.finish_reason) finish = finishReason(choice.finish_reason);
        if (frame?.usage) {
          usage = {
            promptTokens: frame.usage.prompt_tokens,
            completionTokens: frame.usage.completion_tokens,
            totalTokens: frame.usage.total_tokens ?? totalTokens(frame.usage.prompt_tokens, frame.usage.completion_tokens),
          };
        }
      }
    } catch (error) {
      throw this.toError(error, model);
    }
    const tail = think.flush();
    if (tail.reasoning) yield { text: '', reasoning: tail.reasoning, modelUsed };
    if (tail.text) yield { text: tail.text, modelUsed };
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name ?? '', arguments: parseArgs(c.args) }));
    yield {
      text: '',
      done: true,
      modelUsed,
      usage,
      finishReason: toolCalls.length ? 'tool_calls' : (finish ?? 'unknown'),
      ...(toolCalls.length && { toolCalls }),
    };
  }
}

/** `message.tool_calls` from a one-shot reply. Ollama-style entries carry the arguments as an object and no id. */
function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => ({ id: t?.id ?? `call_${i}`, name: t?.function?.name ?? '', arguments: parseArgs(t?.function?.arguments) }));
}

/** `json_schema` when the request carries a JSON form of its schema, plain `json_object` otherwise. */
function responseFormat(request: AIRequest): Record<string, unknown> {
  const schema = jsonSchemaOf(request.schema);
  return schema ? { type: 'json_schema', json_schema: { name: 'response', schema } } : { type: 'json_object' };
}

/** DeepSeek, vLLM and llama.cpp use `reasoning_content`; OpenRouter and LM Studio use `reasoning`. */
function reasoningField(message: any): string {
  const v = message?.reasoning_content ?? message?.reasoning;
  return typeof v === 'string' ? v : '';
}
