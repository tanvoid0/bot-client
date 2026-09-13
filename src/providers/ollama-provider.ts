import type { AIRequest, AIResponse, AIStreamChunk, BaseProviderConfig, FinishReason } from '../types/index.js';
import type { Refinement } from '../core/errors.js';
import { BaseProvider, buildChatMessages, inlineImage, mergeBody, textOf, totalTokens } from './base-provider.js';
import { openaiTools, parseArgs, recoverLeakedToolCalls } from '../core/tools.js';
import { jsonSchemaOf, wantsJson } from '../core/schema.js';
import type { ToolCall } from '../types/index.js';
import { parseNDJSON } from '../core/http.js';
import { splitThinkTags, ThinkFilter } from '../core/reasoning.js';
import type { runOllamaCLI, OllamaCLIResult, OllamaCLIOptions } from '../ollama-cli.js';

/** Optional configuration for OllamaProvider */
export interface OllamaProviderConfig extends BaseProviderConfig {
  /** Path to the ollama executable (default: "ollama" from PATH) */
  ollamaExecutablePath?: string;
  /** Base URL for Ollama API (default: "http://localhost:11434"). Used for list, ps, show, pull, rm, run when server is reachable. */
  baseURL?: string;
  /** Prefer CLI over API when both are available (default: false = try API first) */
  preferCLI?: boolean;
  /**
   * The `ollama` binary, for management calls when the server is down and for
   * `serve`, `stop`, `create`. Pass `runOllamaCLI` from
   * `@tanvoid0/bot-client/ollama-cli`; it lives there so the main entry pulls
   * in no `child_process`. Without it those calls return `ok: false`.
   */
  cli?: typeof runOllamaCLI;
}

export class OllamaProvider extends BaseProvider {
  private readonly ollamaExecutablePath: string;
  private readonly base: string;
  private readonly preferCLI: boolean;
  private readonly cli?: typeof runOllamaCLI;

  protected get baseURL(): string {
    return this.base;
  }

  constructor(config: OllamaProviderConfig = {}) {
    super(config);
    this.ollamaExecutablePath = config.ollamaExecutablePath ?? 'ollama';
    this.base = config.baseURL ?? 'http://localhost:11434';
    this.preferCLI = config.preferCLI ?? false;
    this.cli = config.cli;
  }

  private async tryApi<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  private apiResult(ok: boolean, data: unknown, error?: string): OllamaCLIResult {
    return {
      ok,
      code: ok ? 0 : 1,
      stdout: typeof data === 'string' ? data : JSON.stringify(data ?? ''),
      stderr: error ?? ''
    };
  }

  /** Run any native `ollama` CLI command. */
  async runCommand(
    subcommand: string,
    args: string[] = [],
    options: OllamaCLIOptions = {}
  ): Promise<OllamaCLIResult> {
    if (!this.cli) {
      return { ok: false, code: -1, stdout: '', stderr: 'Ollama CLI not configured: pass `cli: runOllamaCLI` from @tanvoid0/bot-client/ollama-cli' };
    }
    return this.cli(subcommand, args, { ...options, executablePath: options.executablePath ?? this.ollamaExecutablePath });
  }

  /** Check if the Ollama CLI is available on the system (needs `cli` in the config). */
  async isCLIAvailable(): Promise<boolean> {
    if (!this.cli) return false;
    try {
      await this.cli('ls', [], { timeout: 5_000, executablePath: this.ollamaExecutablePath });
      return true;
    } catch {
      return false;
    }
  }

  /** Pull a model (API: POST /api/pull, fallback: `ollama pull <model>`). */
  async pull(model: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      // A pull downloads gigabytes; the default 30 s JSON timeout must not cut it off.
      const result = await this.tryApi(() => this.http(`${this.base}/api/pull`, { body: { model, stream: false }, timeout: 0 }));
      if (result !== null) return this.apiResult(true, result);
    }
    return this.runCommand('pull', [model], options);
  }

  /** List models (API: GET /api/tags, fallback: `ollama ls`). */
  async list(options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const result = await this.tryApi(() => this.http(`${this.base}/api/tags`));
      if (result !== null) return this.apiResult(true, result);
    }
    return this.runCommand('ls', [], options);
  }

  /** Remove a model (API: DELETE /api/delete, fallback: `ollama rm <model>`). */
  async rm(model: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const ok = await this.tryApi(async () => {
        await this.http(`${this.base}/api/delete`, { method: 'DELETE', body: { model } });
        return true;
      });
      if (ok === true) return this.apiResult(true, { status: 'success' });
    }
    return this.runCommand('rm', [model], options);
  }

  /** Show model info (API: POST /api/show, fallback: `ollama show <model>`). */
  async show(
    model: string,
    options: OllamaCLIOptions & { modelfile?: boolean } = {}
  ): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const result = await this.tryApi(() =>
        this.http(`${this.base}/api/show`, { body: { model, verbose: options.modelfile } })
      );
      if (result !== null) return this.apiResult(true, result);
    }
    const { modelfile, ...cliOpts } = options;
    const args = [model];
    if (modelfile) args.push('--modelfile');
    return this.runCommand('show', args, cliOpts);
  }

  /** Run a model with an optional prompt (API: POST /api/generate when prompt given, fallback: `ollama run`). */
  async run(model: string, prompt?: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI && prompt !== undefined && prompt !== '') {
      const result = await this.tryApi(async () => {
        const res = await this.http(`${this.base}/api/generate`, { body: { model, prompt, stream: false } });
        return res?.response ?? res;
      });
      if (result !== null) {
        const text = typeof result === 'string' ? result : (result as { response?: string })?.response ?? JSON.stringify(result);
        return this.apiResult(true, text);
      }
    }
    const args = prompt !== undefined && prompt !== '' ? [model, prompt] : [model];
    return this.runCommand('run', args, options);
  }

  /** List running models (API: GET /api/ps, fallback: `ollama ps`). */
  async ps(options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const result = await this.tryApi(() => this.http(`${this.base}/api/ps`));
      if (result !== null) return this.apiResult(true, result);
    }
    return this.runCommand('ps', [], options);
  }

  /** Stop a running model using `ollama stop <model>`. */
  async stop(model: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    return this.runCommand('stop', [model], options);
  }

  /** Start the Ollama server using `ollama serve`. */
  async serve(options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    return this.runCommand('serve', [], options);
  }

  /** Create a model from a Modelfile using `ollama create -f <path>` or `ollama create <name> -f <path>`. */
  async create(
    modelfilePath: string,
    options: OllamaCLIOptions & { name?: string } = {}
  ): Promise<OllamaCLIResult> {
    const { name, ...cliOpts } = options;
    const args = name ? [name, '-f', modelfilePath] : ['-f', modelfilePath];
    return this.runCommand('create', args, cliOpts);
  }

  async discoverModels(): Promise<string[]> {
    const hit = this.cached();
    if (hit) return hit;
    try {
      const response = await this.http(`${this.base}/api/tags`);

      const models = response.models || [];
      return this.setDiscovered(models.map((model: { name: string }) => model.name));
    } catch {
      const cliResult = await this.list();
      if (cliResult.ok && cliResult.stdout) {
        return this.setDiscovered(this.parseListOutput(cliResult.stdout));
      }
      return [];
    }
  }

  private parseListOutput(stdout: string): string[] {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    return lines.slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  }

  get providerId(): string {
    return 'ollama';
  }

  get providerName(): string {
    return 'Ollama';
  }

  async testConnection(): Promise<boolean> {
    if (this.cached()) return true;
    try {
      await this.http(`${this.base}/api/tags`);
      return true;
    } catch {
      const cli = await this.list();
      return cli.ok;
    }
  }

  protected classify(_status: number, json: any, text: string): Refinement {
    const message: string = typeof json?.error === 'string' ? json.error : text;
    if (/not found|no such model/i.test(message)) {
      const m = /model ['"]?([^'"\s]+)['"]? not found/i.exec(message)?.[1];
      return { code: 'MODEL_NOT_FOUND', hint: `Run \`ollama pull ${m ?? '<model>'}\` and try again.` };
    }
    if (/context length|too many tokens|exceeds/i.test(message)) return { code: 'CONTEXT_LENGTH' };
    if (/does not support tools/i.test(message)) return { code: 'UNSUPPORTED', hint: 'Pick a model that lists "tools" in `ollama show`, or drop `tools` from the request.' };
    if (/out of memory|cuda|runner process/i.test(message)) return { code: 'SERVER' };
    return {};
  }

  private resolveModel(request: AIRequest): string | undefined {
    return request.modelId ?? this.supportedModels[0];
  }

  private noModel(): AIResponse {
    return this.fail(
      this.error('NO_MODEL', 'No Ollama model available', {
        hint: 'Pull one (`ollama pull llama3.1`) or pass modelId.',
      })
    );
  }

  private chatBody(request: AIRequest, model: string, stream: boolean): Record<string, unknown> {
    const messages = buildChatMessages(request).map((m) => {
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: parseArgs(c.arguments) } })) };
      }
      if (typeof m.content === 'string') return m;
      const images = m.content
        .filter((p): p is Extract<typeof p, { type: 'image' }> => p.type === 'image')
        .map((p) => {
          const inline = inlineImage(p);
          if (!inline) {
            throw this.error('UNSUPPORTED', 'Ollama takes image bytes, not URLs', {
              model,
              hint: 'Fetch the image yourself and pass { type: "image", data: bytes } or a data: URL.',
            });
          }
          return inline.data;
        });
      return { role: m.role, content: textOf(m.content), ...(images.length && { images }) };
    });
    return mergeBody(
      {
        model,
        messages,
        stream,
        ...(request.tools?.length && { tools: openaiTools(request.tools) }),
        think: request.reasoning ?? false,
        ...(wantsJson(request) && { format: jsonSchemaOf(request.schema) ?? 'json' }),
        options: {
          temperature: request.temperature ?? 0.7,
          ...(request.maxTokens !== undefined && { num_predict: request.maxTokens }),
        },
      },
      request.providerOptions
    );
  }

  /** A mid-stream `{"error": ...}` line, classified like an HTTP error body. */
  private lineError(message: string, model: string) {
    const refined = this.classify(0, { error: message }, message);
    return this.error(refined.code ?? 'SERVER', message, { model, hint: refined.hint });
  }

  /**
   * Ollama's `/api/chat` with `stream: true`, which answers in NDJSON: one
   * JSON object per line, the last carrying `done` and the token counts.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const model = this.resolveModel(request);
    if (!model) throw this.noModel().errorInfo;
    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await this.httpStream(`${this.base}/api/chat`, {
        body: this.chatBody(request, model, true),
        ...this.requestOptions(request),
      });
    } catch (error) {
      throw this.toError(error, model);
    }

    // Models that inline <think> tags instead of using the `thinking` field.
    const think = new ThinkFilter();
    const toolCalls: ToolCall[] = [];
    try {
      for await (const parsed of parseNDJSON(stream)) {
        if (typeof parsed?.error === 'string') throw this.lineError(parsed.error, model);
        toolCalls.push(...toolCallsOf(parsed?.message?.tool_calls, toolCalls.length));
        const thinking = parsed?.message?.thinking;
        if (typeof thinking === 'string' && thinking.length > 0) {
          yield { type: 'reasoning', text: '', reasoning: thinking, modelUsed: model };
        }
        const content = parsed?.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          const part = think.push(content);
          if (part.reasoning) yield { type: 'reasoning', text: '', reasoning: part.reasoning, modelUsed: model };
          if (part.text) yield { type: 'text', text: part.text, modelUsed: model };
        }
        if (parsed?.done) {
          const tail = think.flush();
          if (tail.reasoning) yield { type: 'reasoning', text: '', reasoning: tail.reasoning, modelUsed: model };
          if (tail.text) yield { type: 'text', text: tail.text, modelUsed: model };
          const promptTokens = parsed.prompt_eval_count;
          const completionTokens = parsed.eval_count;
          for (const toolCall of toolCalls) yield { type: 'tool-call', text: '', toolCall, modelUsed: model };
          yield {
            type: 'done',
            done: true,
            text: '',
            modelUsed: model,
            finishReason: toolCalls.length ? 'tool_calls' : doneReason(parsed.done_reason),
            ...(toolCalls.length && { toolCalls }),
            usage: { promptTokens, completionTokens, totalTokens: totalTokens(promptTokens, completionTokens) },
          };
        }
      }
    } catch (error) {
      throw this.toError(error, model);
    }
  }

  async process(request: AIRequest): Promise<AIResponse> {
    const model = this.resolveModel(request);
    if (!model) return this.noModel();
    try {
      const response = await this.http(`${this.base}/api/chat`, {
        body: this.chatBody(request, model, false),
        ...this.requestOptions(request),
      });
      if (typeof response?.error === 'string') return this.fail(this.lineError(response.error, model), model);
      const promptTokens = response?.prompt_eval_count;
      const completionTokens = response?.eval_count;
      const split = splitThinkTags(response?.message?.content ?? '');
      const thinking = typeof response?.message?.thinking === 'string' ? response.message.thinking : '';
      let toolCalls = toolCallsOf(response?.message?.tool_calls);
      let text = split.text;
      if (!toolCalls.length) ({ text, toolCalls } = recoverLeakedToolCalls(text, request.tools));
      return this.ok(text, {
        reasoning: [thinking, split.reasoning].filter(Boolean).join('\n') || undefined,
        modelUsed: response?.model ?? model,
        finishReason: doneReason(response?.done_reason),
        toolCalls,
        usage: { promptTokens, completionTokens, totalTokens: totalTokens(promptTokens, completionTokens) },
      });
    } catch (error) {
      return this.fail(this.toError(error, model), model);
    }
  }
}

/** Ollama sends `{ function: { name, arguments } }` with the arguments already an object and no id. */
function toolCallsOf(raw: unknown, offset = 0): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => ({ id: `call_${offset + i}`, name: t?.function?.name ?? '', arguments: parseArgs(t?.function?.arguments) }));
}

function doneReason(raw: unknown): FinishReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  return 'unknown';
}
