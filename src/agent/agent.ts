/**
 * Agent: a name, a model, a system prompt, tools and a step budget, run
 * through the factory's tool loop. Deliberately a config holder with two
 * methods; multi-agent is two tools (`asTool`, `handoff`), not a runtime.
 */
import type { AIFactory } from '../ai-factory.js';
import { nextStepRequest, runTools } from '../core/tools.js';
import type { AIRequest, AIResponse, AIStreamChunk, Message, Step, Tool, ToolCall } from '../types/index.js';

export interface AgentConfig {
  name: string;
  /** Routed like `AIRequest.modelId` (`claude-sonnet-4-5`, `openai/gpt-4o`, ...). */
  model?: string;
  /** System prompt. */
  system?: string;
  tools?: Tool[];
  /** Rounds of model call + tool execution per `run` (default 8). */
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /** Factory to run on. Default: the shared `aiFactory` from the main entry. */
  factory?: AIFactory;
  /** Observe each round of the tool loop. */
  onStep?: (step: Step, agent: Agent) => void | Promise<void>;
}

export interface AgentResult extends AIResponse {
  /** Set when a `handoff` tool fired: the agent that produced this answer. Its own `handedOffTo` continues the chain. */
  handedOffTo?: string;
}

/** Anything an agent can be asked: a prompt, or a whole conversation. */
export type AgentInput = string | Message[];

const HANDOFF = Symbol('handoff');
type HandoffTool = Tool & { [HANDOFF]: Agent };

export class Agent {
  readonly name: string;
  readonly tools: Tool[];
  private readonly cfg: AgentConfig;

  constructor(config: AgentConfig) {
    this.cfg = config;
    this.name = config.name;
    this.tools = config.tools ?? [];
  }

  /** The request `run` sends: this agent's defaults, the input, then `overrides`. */
  request(input: AgentInput, overrides: Partial<AIRequest> = {}): AIRequest {
    const cfg = this.cfg;
    return {
      ...(cfg.model && { modelId: cfg.model }),
      ...(cfg.system && { systemPrompt: cfg.system }),
      ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
      ...(cfg.maxTokens !== undefined && { maxTokens: cfg.maxTokens }),
      ...(this.tools.length && { tools: this.tools }),
      maxSteps: cfg.maxSteps ?? 8,
      ...(cfg.onStep && { onStep: (step: Step) => cfg.onStep!(step, this) }),
      ...(typeof input === 'string' ? { prompt: input } : { messages: input }),
      ...overrides,
    };
  }

  async run(input: AgentInput, overrides: Partial<AIRequest> = {}): Promise<AgentResult> {
    const factory = await this.factory();
    const req = this.request(input, overrides);
    const res = await factory.process(req);
    const target = this.handoffTarget(res.toolCalls);
    if (!target || !res.success) return res;
    // A handoff tool has no `execute`, so the factory's loop stopped here with the calls unrun.
    // Run the ordinary ones, mark the handoff, and continue the same conversation as `target`.
    const results = await this.handoffResults(res.toolCalls!, target, req.signal);
    const step: Step = { text: res.data ?? '', toolCalls: res.toolCalls!, toolResults: results, usage: res.usage };
    await req.onStep?.(step);
    const next = nextStepRequest(req, res.data ?? '', res.toolCalls!, results);
    const out = await target.run(next.messages!, { signal: req.signal });
    return { ...out, handedOffTo: target.name, steps: [...(res.steps ?? []), step, ...(out.steps ?? [])] };
  }

  async *stream(input: AgentInput, overrides: Partial<AIRequest> = {}): AsyncGenerator<AIStreamChunk, void, void> {
    const factory = await this.factory();
    const req = this.request(input, overrides);
    let text = '';
    for await (const chunk of factory.processStream(req)) {
      if (chunk.type === 'text') text += chunk.text;
      const target = chunk.type === 'done' ? this.handoffTarget(chunk.toolCalls) : undefined;
      if (!target) {
        yield chunk;
        continue;
      }
      const calls = (chunk as { toolCalls?: ToolCall[] }).toolCalls!;
      const results = await this.handoffResults(calls, target, req.signal);
      await req.onStep?.({ text, toolCalls: calls, toolResults: results, usage: chunk.type === 'done' ? chunk.usage : undefined });
      yield* target.stream(nextStepRequest(req, text, calls, results).messages!, { signal: req.signal });
      return;
    }
  }

  /**
   * This agent as a tool for another agent: one `input` string in, the
   * answer text out. A supervisor lists sub-agents here and the model picks.
   */
  asTool(options: { name?: string; description?: string } = {}): Tool {
    return {
      name: options.name ?? this.name,
      description: options.description ?? this.cfg.system ?? `Ask the ${this.name} agent`,
      parameters: { type: 'object', properties: { input: { type: 'string', description: 'The task or question' } }, required: ['input'] },
      execute: async ({ input }: { input: string }, { signal }) => {
        const res = await this.run(String(input), { signal });
        if (!res.success) throw res.errorInfo ?? new Error(res.error ?? `${this.name} failed`);
        return res.data ?? '';
      },
    };
  }

  /** The configured factory, else the shared zero-config one (loaded on first use, so `./core` bundles do not pay for the built-in providers unless this path runs). */
  private async factory(): Promise<AIFactory> {
    return this.cfg.factory ?? (await import('../index.js')).aiFactory;
  }

  private handoffTarget(calls: ToolCall[] | undefined): Agent | undefined {
    for (const call of calls ?? []) {
      const tool = this.tools.find((t) => t.name === call.name) as HandoffTool | undefined;
      if (tool?.[HANDOFF]) return tool[HANDOFF];
    }
    return undefined;
  }

  private async handoffResults(calls: ToolCall[], target: Agent, signal?: AbortSignal) {
    const results = await runTools(this.tools, calls, signal);
    return results.map((r) => ((this.tools.find((t) => t.name === r.name) as HandoffTool | undefined)?.[HANDOFF] ? { ...r, error: undefined, result: `Handed off to ${target.name}` } : r));
  }
}

/**
 * A tool that ends the current agent's turn and continues the same
 * conversation as `to`. `run` on the first agent returns `to`'s answer with
 * `handedOffTo: to.name`.
 */
export function handoff(to: Agent, description?: string): Tool {
  const tool: HandoffTool = {
    name: `handoff_to_${to.name.replace(/[^\w-]/g, '_')}`,
    description: description ?? `Hand the conversation to the ${to.name} agent`,
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
    [HANDOFF]: to,
  };
  return tool;
}
