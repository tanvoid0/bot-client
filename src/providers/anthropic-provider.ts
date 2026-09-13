import { AIRequest, AIResponse } from '../types/index.js';
import { BaseProvider, buildChatMessages } from './base-provider.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com';

/** Anthropic has no native JSON mode; ask for JSON in the system prompt. */
const DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
const SYSTEM_JOINER = '\n\n';

export interface AnthropicProviderConfig {
  apiKey?: string;
}

export class AnthropicProvider extends BaseProvider {
  private apiKey?: string;

  constructor(config?: AnthropicProviderConfig) {
    super();
    this.apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.BOT_CLIENT_ANTHROPIC_KEY;
  }

  async discoverModels(): Promise<string[]> {
    return [];
  }

  get providerId(): string {
    return 'anthropic';
  }

  get providerName(): string {
    return 'Anthropic';
  }

  async process(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      return this.createResponse(false, undefined, 'Anthropic API key required');
    }

    try {
      // The Messages API takes the system prompt as a top-level field and
      // rejects a system role inside `messages`.
      const all = buildChatMessages(request);
      const system = all
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join(SYSTEM_JOINER);
      const messages = all.filter((m) => m.role !== 'system');

      const response = await this.http(`${ANTHROPIC_BASE}/v1/messages`, {
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': this.apiKey },
        body: {
        model: request.modelId ?? DEFAULT_MODEL,
        messages,
        ...(system && { system }),
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7
        }
      });

      const content = response.content?.[0]?.text ?? '';
      const modelUsed = request.modelId ?? DEFAULT_MODEL;
      const usage = response.usage;
      return this.createResponse(true, content, undefined, modelUsed, {
        promptTokens: usage?.input_tokens,
        completionTokens: usage?.output_tokens,
        totalTokens:
          usage?.input_tokens !== undefined && usage?.output_tokens !== undefined
            ? usage.input_tokens + usage.output_tokens
            : undefined
      });
    } catch (error) {
      this.handleError(error, 'Anthropic processing');
    }
  }
}
