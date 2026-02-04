import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';
import {
  runOllamaCLI,
  isOllamaCLIAvailable,
  type OllamaCLIResult,
  type OllamaCLIOptions
} from '../ollama-cli.js';

/** Optional configuration for OllamaProvider */
export interface OllamaProviderConfig {
  /** Path to the ollama executable (default: "ollama" from PATH) */
  ollamaExecutablePath?: string;
  /** Base URL for Ollama API (default: "http://localhost:11434"). Used for list, ps, show, pull, rm, run when server is reachable. */
  baseURL?: string;
  /** Prefer CLI over API when both are available (default: false = try API first) */
  preferCLI?: boolean;
}

export class OllamaProvider extends BaseProvider {
  private readonly ollamaExecutablePath: string;
  private readonly baseURL: string;
  private readonly preferCLI: boolean;

  constructor(config: OllamaProviderConfig = {}) {
    super();
    this.ollamaExecutablePath = config.ollamaExecutablePath ?? 'ollama';
    this.baseURL = config.baseURL ?? 'http://localhost:11434';
    this.preferCLI = config.preferCLI ?? false;
  }

  private getApiClient() {
    return this.createClient(this.baseURL);
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
    const mergedOptions: OllamaCLIOptions = {
      ...options,
      executablePath: options.executablePath ?? this.ollamaExecutablePath
    };
    return runOllamaCLI(subcommand, args, mergedOptions);
  }

  /** Check if the Ollama CLI is available on the system. */
  async isCLIAvailable(): Promise<boolean> {
    return isOllamaCLIAvailable(this.ollamaExecutablePath);
  }

  /** Pull a model (API: POST /api/pull, fallback: `ollama pull <model>`). */
  async pull(model: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const client = this.getApiClient();
      const result = await this.tryApi(async () => {
        const res = await client.post('/api/pull', { model, stream: false });
        return res.data;
      });
      if (result !== null) return this.apiResult(true, result);
    }
    return this.runCommand('pull', [model], options);
  }

  /** List models (API: GET /api/tags, fallback: `ollama ls`). */
  async list(options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const client = this.getApiClient();
      const result = await this.tryApi(async () => {
        const res = await client.get('/api/tags');
        return res.data;
      });
      if (result !== null) return this.apiResult(true, result);
    }
    return this.runCommand('ls', [], options);
  }

  /** Remove a model (API: DELETE /api/delete, fallback: `ollama rm <model>`). */
  async rm(model: string, options: OllamaCLIOptions = {}): Promise<OllamaCLIResult> {
    if (!this.preferCLI) {
      const client = this.getApiClient();
      const ok = await this.tryApi(async () => {
        await client.delete('/api/delete', { data: { model } });
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
      const client = this.getApiClient();
      const result = await this.tryApi(async () => {
        const res = await client.post('/api/show', {
          model,
          verbose: options.modelfile
        });
        return res.data;
      });
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
      const client = this.getApiClient();
      const result = await this.tryApi(async () => {
        const res = await client.post('/api/generate', { model, prompt, stream: false });
        return res.data?.response ?? res.data;
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
      const client = this.getApiClient();
      const result = await this.tryApi(async () => {
        const res = await client.get('/api/ps');
        return res.data;
      });
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
    try {
      const client = this.getApiClient();
      const response = await client.get('/api/tags');

      const models = response.data.models || [];
      this._supportedModels = models.map((model: { name: string }) => model.name);

      return this._supportedModels;
    } catch {
      const cliResult = await this.list();
      if (cliResult.ok && cliResult.stdout) {
        const names = this.parseListOutput(cliResult.stdout);
        this._supportedModels = names;
        return names;
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
    try {
      const client = this.getApiClient();
      await client.get('/api/tags');
      return true;
    } catch {
      const cli = await this.list();
      return cli.ok;
    }
  }

  async process(request: AIRequest): Promise<AIResponse> {
    try {
      const client = this.getApiClient();
      const modelToUse = request.modelId ?? this.supportedModels[0];

      const messages = buildChatMessages(request);
      const response = await client.post('/api/chat', {
        model: modelToUse,
        messages,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens ?? 1000
        }
      });

      const content = response.data.message?.content ?? '';
      return this.createResponse(true, content, undefined, request.modelId ?? modelToUse);
    } catch (error) {
      this.handleError(error, 'Ollama processing');
    }
  }
}
