import type { AIProvider, AIRequest, AIResponse, AIFactoryConfig, AIStreamChunk, DiscoveryMode, DoneChunk, Hooks, Step, ToolCall } from './types/index.js';
import { chunksOf } from './providers/base-provider.js';
import { canRun, nextStepRequest, runTools } from './core/tools.js';
import { parseJson, validate, wantsJson } from './core/schema.js';
import { AIError, toAIError, SINGLE_RETRY } from './core/errors.js';
import { DEFAULT_RETRY, retryDelay, sleep, type RetryOptions } from './core/retry.js';
import { guessProvider, splitExplicit } from './core/catalog.js';

const REMOVED_REQUEST_FIELDS: Record<string, string> = {
  history: 'Pass the same array as `messages`.',
  responseSchema: 'Pass it as `schema` (a JSON Schema object or a Standard Schema).',
  usageContext: 'It was never read; delete it.',
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class AIFactory {
  private providers: Map<string, AIProvider> = new Map();
  private initializationPromise: Promise<void> | null = null;
  private probed = new Set<string>();
  /** Providers that failed their connection check at eager init, with the reason. */
  private unavailable = new Map<string, string>();
  private readonly config: AIFactoryConfig;
  private readonly retry: Required<RetryOptions>;
  private readonly discover: DiscoveryMode;

  constructor(config?: AIFactoryConfig) {
    this.config = config ?? {};
    this.retry = {
      ...DEFAULT_RETRY,
      ...this.config.retry,
      ...(this.config.retries !== undefined && { retries: this.config.retries }),
    };
    this.discover = this.config.discover ?? 'lazy';
  }

  // ---- concurrency: one permit per in-flight provider call (a stream holds its permit until it ends) ----
  private active = 0;
  private waiters: Array<() => void> = [];

  private async acquire(): Promise<void> {
    const max = this.config.concurrency;
    if (!max) return;
    if (this.active < max) {
      this.active++;
      return;
    }
    // The releasing call hands its slot straight to us, so `active` never dips and lets a newcomer cut in.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    if (!this.config.concurrency) return;
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * Provider discovery probes providers over the network. It runs on first
   * use, not on construction, so importing or wiring this into a DI container
   * is free.
   */
  private ensureInitialized(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;

    // A discovery run that registered nothing is usually a transient outage.
    // Forgetting it lets the next request retry instead of leaving the factory
    // permanently empty until the process restarts.
    this.initializationPromise = this.initializeProviders().then(() => {
      if (this.providers.size === 0) this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  private log(level: keyof NonNullable<AIFactoryConfig['logger']>, message: string, ...args: unknown[]): void {
    this.config.logger?.[level]?.(message, ...args);
  }

  private hook<K extends keyof Hooks>(name: K, ctx: Parameters<NonNullable<Hooks[K]>>[0]): void | Promise<void> {
    const fn = this.config.hooks?.[name] as ((ctx: unknown) => void | Promise<void>) | undefined;
    return fn?.(ctx);
  }

  /** Providers used when the config names none. Empty here; the `.` entry's subclass supplies the built-ins. */
  protected defaults(): AIProvider[] {
    return [];
  }

  private candidates(): AIProvider[] {
    return this.config.providers ?? this.defaults();
  }

  private async initializeProviders(): Promise<void> {
    const list = this.candidates();
    this.log('info', 'Initializing AI providers...');

    if (this.discover === 'eager') {
      // All probes in parallel: first use waits for the slowest provider, not the sum.
      await Promise.all(
        list.map(async (provider) => {
          try {
            this.log('info', `Testing ${provider.providerName}...`);
            await provider.discoverModels();
            if (await provider.testConnection()) {
              this.providers.set(provider.providerId, provider);
              this.log('info', `${provider.providerName} initialized successfully with ${provider.supportedModels.length} models`);
            } else {
              this.unavailable.set(provider.providerId, 'connection test failed (missing or rejected API key, or server not running)');
              this.log('warn', `${provider.providerName} connection test failed`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.unavailable.set(provider.providerId, msg);
            this.log('warn', `${provider.providerName} initialization failed: ${msg}`);
          } finally {
            this.probed.add(provider.providerId);
          }
        })
      );
      // Keep the configured order, not the order probes finished in.
      const ordered = new Map<string, AIProvider>();
      for (const p of list) if (this.providers.has(p.providerId)) ordered.set(p.providerId, p);
      this.providers = ordered;
    } else {
      for (const provider of list) this.providers.set(provider.providerId, provider);
    }

    this.log('info', `Total providers available: ${this.providers.size}`);
  }

  /** `lazy` mode: list a provider's models the first time a request lands on it. */
  private async probe(provider: AIProvider): Promise<void> {
    if (this.discover !== 'lazy' || this.probed.has(provider.providerId)) return;
    // Seeded models mean the caller already knows what to send; no probe needed.
    if (provider.supportedModels.length > 0) return;
    this.probed.add(provider.providerId);
    try {
      await provider.discoverModels();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('warn', `${provider.providerName} discovery failed: ${msg}`);
    }
  }

  /**
   * Which provider handles this request, and the request as that provider
   * should see it (an explicit `openai/gpt-4o` prefix is stripped).
   *
   * Order: explicit prefix, a provider that lists the model, the static
   * catalog, `defaultProvider`, `providerOrder`, first registered.
   */
  private resolve(request: AIRequest): { provider: AIProvider; request: AIRequest } | AIError {
    // 1.x fields fail loudly rather than being silently ignored, so an upgrade cannot pass unnoticed.
    for (const [field, hint] of Object.entries(REMOVED_REQUEST_FIELDS)) {
      if (field in request) {
        return AIError.from({ message: `AIRequest.${field} was removed in 2.0`, provider: 'AIFactory', code: 'INVALID_REQUEST', hint: `${hint} See MIGRATION.md.` });
      }
    }
    if (request.prompt === undefined && !request.messages?.length) {
      return AIError.from({ message: 'Pass prompt or messages', provider: 'AIFactory', code: 'INVALID_REQUEST', hint: 'A request needs a prompt string or a non-empty messages array.' });
    }
    const req: AIRequest = {
      ...request,
      timeout: request.timeout ?? this.config.timeout,
      streamIdleTimeout: request.streamIdleTimeout ?? this.config.streamIdleTimeout,
    };
    if (req.modelId) {
      const explicit = splitExplicit(req.modelId, [...this.providers.keys(), ...this.unavailable.keys()]);
      if (explicit) {
        const p = this.providers.get(explicit.providerId);
        return p ? { provider: p, request: { ...req, modelId: explicit.modelId } } : this.notAvailable(explicit.providerId, req.modelId);
      }
      const byModel = this.getProviderForModel(req.modelId);
      if (byModel) return { provider: byModel, request: req };
      const guessed = guessProvider(req.modelId);
      if (guessed && this.providers.has(guessed)) return { provider: this.providers.get(guessed)!, request: req };
      // The model clearly belongs to a provider we probed and dropped: say so
      // rather than sending `gpt-4o` to Ollama and reporting "model not found".
      if (guessed && this.unavailable.has(guessed)) return this.notAvailable(guessed, req.modelId);
    }
    const provider = this.resolveDefault();
    return provider ? { provider, request: req } : this.noProviders();
  }

  private notAvailable(providerId: string, modelId: string): AIError {
    const available = this.getAvailableProviders();
    return AIError.from({
      message: `Provider "${providerId}" (for model "${modelId}") is not available: ${this.unavailable.get(providerId)}`,
      provider: providerId,
      code: 'NO_PROVIDERS',
      model: modelId,
      hint: available.length
        ? `Fix the ${providerId} setup, or pick a model from an available provider (${available.join(', ')}).`
        : `Fix the ${providerId} setup (API key or server), then retry.`,
    });
  }

  private resolveDefault(): AIProvider | null {
    if (this.config.defaultProvider && this.providers.has(this.config.defaultProvider)) {
      return this.providers.get(this.config.defaultProvider)!;
    }
    for (const id of this.config.providerOrder ?? []) {
      if (this.providers.has(id)) return this.providers.get(id)!;
    }
    return this.providers.values().next().value ?? null;
  }

  /** Providers to try after `primary`, in order, deduplicated. */
  private fallbacks(primary: AIProvider): AIProvider[] {
    const ids = [this.config.fallbackProvider, ...(this.config.fallbackProviders ?? [])];
    const out: AIProvider[] = [];
    for (const id of ids) {
      if (!id || id === primary.providerId) continue;
      const p = this.providers.get(id);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  private noProviders(): AIError {
    return AIError.from({
      message: 'No AI providers available',
      provider: 'AIFactory',
      code: 'NO_PROVIDERS',
      hint: 'No provider passed its connection check; set an API key or start a local server (ollama serve).',
    });
  }

  async generate(prompt: string, options?: Partial<AIRequest>): Promise<string> {
    const response = await this.process({ prompt, ...options });
    if (!response.success) {
      throw response.errorInfo ?? new AIError(response.error ?? 'Generation failed', response.providerId ?? 'AIFactory');
    }
    return response.data ?? '';
  }

  /**
   * One answer, with retries and fallback.
   *
   * A retryable failure (rate limit, overload, network, timeout) is retried
   * with backoff, honouring `Retry-After`; anything else moves straight to the
   * next fallback provider. Never throws for a provider failure: the result
   * carries `success: false` and a classified `errorInfo`.
   */
  async process(request: AIRequest): Promise<AIResponse> {
    const maxSteps = request.maxSteps ?? 1;
    if (maxSteps <= 1 || !request.tools?.length) return this.processOnce(request);
    const steps: Step[] = [];
    let req = request;
    for (let step = 1; ; step++) {
      const res = await this.processOnce(req);
      const calls = res.success ? (res.toolCalls ?? []) : [];
      if (step >= maxSteps || !canRun(req.tools, calls)) return steps.length ? { ...res, steps } : res;
      const results = await runTools(req.tools!, calls, req.signal);
      const done: Step = { text: res.data ?? '', toolCalls: calls, toolResults: results, usage: res.usage };
      steps.push(done);
      await request.onStep?.(done);
      req = nextStepRequest(req, res.data ?? '', calls, results);
    }
  }

  private async processOnce(request: AIRequest): Promise<AIResponse> {
    await this.acquire();
    try {
      return await this.processGated(request);
    } finally {
      this.release();
    }
  }

  private async processGated(request: AIRequest): Promise<AIResponse> {
    await this.ensureInitialized();
    const started = now();
    const resolved = this.resolve(request);
    if (resolved instanceof AIError) {
      return this.finish(
        { success: false, error: resolved.message, errorInfo: resolved, providerId: resolved.code === 'NO_PROVIDERS' && resolved.provider === 'AIFactory' ? 'none' : resolved.provider, modelUsed: request.modelId, finishReason: 'error' },
        started, 0, false
      );
    }

    let retryCount = 0;
    let fallbackUsed = false;
    let last: AIResponse | undefined;
    const chain = [resolved.provider, ...this.fallbacks(resolved.provider)];
    for (const provider of chain) {
      if (provider !== resolved.provider) fallbackUsed = true;
      await this.probe(provider);
      const request = this.forProvider(provider, resolved);
      for (let attempt = 0; ; attempt++) {
        await this.hook('onRequest', { provider: provider.providerId, model: request.modelId, request });
        const result = await this.attempt(provider, request);
        if (result.success) {
          const done = this.finish(result, started, retryCount, fallbackUsed);
          await this.hook('onResponse', { provider: provider.providerId, model: request.modelId, response: done, durationMs: done.durationMs! });
          return done;
        }
        last = result;
        const err = result.errorInfo!;
        const budget = SINGLE_RETRY.has(err.code) ? Math.min(1, this.retry.retries) : this.retry.retries;
        const willRetry = err.retryable && attempt < budget && err.code !== 'ABORTED';
        await this.hook('onError', { provider: provider.providerId, model: request.modelId, error: err, willRetry });
        if (!willRetry) break;
        retryCount++;
        const delay = retryDelay(attempt + 1, this.retry, result.errorInfo?.retryAfterMs);
        this.log('warn', `${provider.providerName} failed (${result.errorInfo?.code ?? 'UNKNOWN'}); retry ${attempt + 1}/${this.retry.retries} in ${delay}ms`);
        try {
          await sleep(delay, request.signal);
        } catch (reason) {
          return this.finish(this.failure(provider, reason, request.modelId), started, retryCount, fallbackUsed);
        }
      }
      if (last?.errorInfo?.code === 'ABORTED') break;
      if (chain.length > 1) this.log('warn', `${provider.providerName} failed (${last?.errorInfo?.code ?? 'UNKNOWN'}: ${last?.error}); trying the next provider`);
    }
    return this.finish(last!, started, retryCount, fallbackUsed);
  }

  /**
   * The request as a fallback provider should see it. A model id that belongs
   * to the provider that just failed (`gpt-4o` when OpenAI is down) is dropped
   * so the fallback answers with its own default model instead of 404ing.
   */
  private forProvider(provider: AIProvider, resolved: { provider: AIProvider; request: AIRequest }): AIRequest {
    const { request } = resolved;
    if (provider === resolved.provider || !request.modelId) return request;
    if (provider.isModelSupported(request.modelId)) return request;
    const owner = guessProvider(request.modelId);
    if (owner === null || owner === provider.providerId) return request;
    this.log('warn', `${provider.providerName}: model "${request.modelId}" belongs to ${owner}; using the default model instead`);
    return { ...request, modelId: undefined };
  }

  private async attempt(provider: AIProvider, request: AIRequest): Promise<AIResponse> {
    let result: AIResponse;
    try {
      result = await provider.process(request);
    } catch (error) {
      return this.failure(provider, error, request.modelId);
    }
    if (!result.success && !result.errorInfo) {
      // Unclassified failure from a custom provider: retried, as 1.x did.
      result.errorInfo = AIError.from({ message: result.error ?? 'Request failed', provider: provider.providerId, model: request.modelId, retryable: true });
    }
    // A JSON answer cut off by maxTokens is unusable; say so instead of handing back half a document.
    if (result.success && wantsJson(request) && result.finishReason === 'length') {
      return this.reject(result, provider, 'TRUNCATED', 'JSON answer truncated by maxTokens', 'Raise maxTokens; the answer was cut off before the JSON was complete.', result.data);
    }
    if (result.success && request.schema !== undefined && !result.toolCalls) {
      const parsed = parseJson(result.data ?? '');
      if ('error' in parsed) {
        return this.reject(result, provider, 'INVALID_JSON', `Answer is not valid JSON: ${parsed.error}`, 'Ask for JSON in the prompt as well, or lower the temperature; the raw text is in errorInfo.details.', result.data);
      }
      const checked = await validate(request.schema, parsed.value);
      if ('issues' in checked) {
        const first = checked.issues[0];
        return this.reject(result, provider, 'SCHEMA_MISMATCH', `Answer does not match the schema: ${first?.path ? `${first.path}: ` : ''}${first?.message ?? 'validation failed'}`, 'Describe the fields in the prompt, or loosen the schema; every issue is in errorInfo.details.', checked.issues);
      }
      return { ...result, object: checked.value };
    }
    return result;
  }

  /** A successful reply the factory refuses after the fact, keeping the provider's text on `data`. */
  private reject(result: AIResponse, provider: AIProvider, code: AIError['code'], message: string, hint: string, details: unknown): AIResponse {
    const err = AIError.from({ message, provider: provider.providerId, code, model: result.modelUsed, hint, details });
    return { ...result, success: false, error: err.message, errorInfo: err };
  }

  private failure(provider: AIProvider, error: unknown, model?: string): AIResponse {
    const err = toAIError(error, { provider: provider.providerId, providerName: provider.providerName, model });
    return { success: false, error: err.message, errorInfo: err, providerId: provider.providerId, modelUsed: model, finishReason: 'error' };
  }

  private finish(result: AIResponse, started: number, retryCount: number, fallbackUsed: boolean): AIResponse {
    const durationMs = Math.round(now() - started);
    return { ...result, durationMs, retryCount, fallbackUsed };
  }

  /**
   * The same call as [process], streamed.
   *
   * Retry and fallback apply only until the first chunk arrives: by then the
   * caller has usually shown part of an answer, and restarting on another
   * provider would splice two different answers together. A failure after
   * that is thrown from the iterator as an `AIError`.
   */
  async *processStream(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const maxSteps = request.maxSteps ?? 1;
    if (maxSteps <= 1 || !request.tools?.length) return yield* this.streamOnce(request);
    let req = request;
    for (let step = 1; ; step++) {
      let text = '';
      let calls: ToolCall[] = [];
      let done: DoneChunk | undefined;
      // Tool-call chunks pass straight through; only the done chunk is held back while the loop continues.
      for await (const chunk of this.streamOnce(req)) {
        if (chunk.type === 'text') text += chunk.text;
        if (chunk.type !== 'done') {
          yield chunk;
          continue;
        }
        done = chunk;
        calls = chunk.toolCalls ?? [];
      }
      if (step >= maxSteps || !canRun(req.tools, calls)) {
        if (done) yield done;
        return;
      }
      const results = await runTools(req.tools!, calls, req.signal);
      await request.onStep?.({ text, toolCalls: calls, toolResults: results, usage: done?.usage });
      req = nextStepRequest(req, text, calls, results);
    }
  }

  private async *streamOnce(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    await this.acquire();
    try {
      yield* this.streamGated(request);
    } finally {
      this.release();
    }
  }

  private async *streamGated(request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    await this.ensureInitialized();
    const started = now();
    const resolved = this.resolve(request);
    if (resolved instanceof AIError) throw resolved;

    let lastError: AIError | undefined;
    const chain = [resolved.provider, ...this.fallbacks(resolved.provider)];
    for (const provider of chain) {
      await this.probe(provider);
      const request = this.forProvider(provider, resolved);
      for (let attempt = 0; ; attempt++) {
        const gen = provider.processStream
          ? provider.processStream(request)
          : this.oneChunk(provider, request);
        let first: IteratorResult<AIStreamChunk, void>;
        await this.hook('onRequest', { provider: provider.providerId, model: request.modelId, request });
        try {
          first = await gen.next();
        } catch (error) {
          lastError = toAIError(error, { provider: provider.providerId, providerName: provider.providerName, model: request.modelId });
          const budget = SINGLE_RETRY.has(lastError.code) ? Math.min(1, this.retry.retries) : this.retry.retries;
          const willRetry = lastError.retryable && attempt < budget && lastError.code !== 'ABORTED';
          await this.hook('onError', { provider: provider.providerId, model: request.modelId, error: lastError, willRetry });
          if (lastError.code === 'ABORTED') throw lastError;
          if (!willRetry) break;
          const delay = retryDelay(attempt + 1, this.retry, lastError.retryAfterMs);
          this.log('warn', `${provider.providerName} stream failed (${lastError.code}); retry ${attempt + 1}/${this.retry.retries} in ${delay}ms`);
          await sleep(delay, request.signal);
          continue;
        }
        yield* this.drain(first, gen, provider, request.modelId, started);
        return;
      }
    }
    throw lastError ?? this.noProviders();
  }

  private async *oneChunk(provider: AIProvider, request: AIRequest): AsyncGenerator<AIStreamChunk, void, void> {
    const result = await provider.process(request);
    if (!result.success) throw result.errorInfo ?? new AIError(result.error ?? 'AI request failed', provider.providerId);
    yield* chunksOf(result);
  }

  /** Relays chunks, stamping timings on the `done` chunk and classifying anything thrown. */
  private async *drain(
    first: IteratorResult<AIStreamChunk, void>,
    gen: AsyncGenerator<AIStreamChunk, void, void>,
    provider: AIProvider,
    model: string | undefined,
    started: number
  ): AsyncGenerator<AIStreamChunk, void, void> {
    let ttft: number | undefined;
    let r = first;
    try {
      while (!r.done) {
        const chunk = r.value;
        if (!('type' in chunk)) {
          throw AIError.from({
            message: `${provider.providerId} yielded a 1.x stream chunk ({ text, done }); 2.0 chunks carry a type`,
            provider: provider.providerId,
            code: 'INVALID_RESPONSE',
            hint: "Yield { type: 'text', text }, { type: 'reasoning', text }, { type: 'tool-call', toolCall } and a final { type: 'done', finishReason }. See MIGRATION.md.",
          });
        }
        if (ttft === undefined && chunk.type === 'text' && chunk.text) ttft = Math.round(now() - started);
        if (chunk.type === 'done') {
          const durationMs = Math.round(now() - started);
          const done: DoneChunk = { ...chunk, durationMs, timeToFirstTokenMs: ttft };
          await this.hook('onResponse', { provider: provider.providerId, model, response: done, durationMs });
          yield done;
        } else {
          yield chunk;
        }
        r = await gen.next();
      }
    } catch (error) {
      const err = toAIError(error, { provider: provider.providerId, providerName: provider.providerName, model });
      await this.hook('onError', { provider: provider.providerId, model, error: err, willRetry: false });
      throw err;
    } finally {
      await gen.return?.(undefined).catch(() => undefined);
    }
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getProvider(providerId: string): AIProvider | null {
    return this.providers.get(providerId) ?? null;
  }

  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /** First provider that lists the given model, or null. */
  getProviderForModel(modelId: string): AIProvider | null {
    for (const p of this.providers.values()) {
      if (p.isModelSupported(modelId)) return p;
    }
    return null;
  }

  /** All model IDs supported by any registered provider. */
  getAllSupportedModels(): string[] {
    const set = new Set<string>();
    for (const p of this.providers.values()) {
      for (const m of p.supportedModels) set.add(m);
    }
    return Array.from(set);
  }

  /** Test each registered provider; returns map of providerId -> ok. */
  async testProviders(): Promise<Record<string, boolean>> {
    await this.ensureInitialized();
    const entries = await Promise.all(
      Array.from(this.providers.entries()).map(async ([id, p]) => [id, await p.testConnection()] as const)
    );
    return Object.fromEntries(entries);
  }

  /** Runs provider discovery if it has not run yet. */
  ready(): Promise<void> {
    return this.ensureInitialized();
  }
}
