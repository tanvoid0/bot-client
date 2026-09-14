/**
 * Session: a conversation an agent continues across calls, kept in a `Store`
 * and held under a token budget. No tokenizer ships: the estimate is
 * `chars / 4`, corrected by the provider's last reported prompt tokens.
 */
import type { Agent, AgentResult } from './agent.js';
import { toolResultContent } from '../core/tools.js';
import type { AIRequest, AIResponse, Message } from '../types/index.js';

export interface Store {
  get(id: string): Promise<Message[] | undefined>;
  set(id: string, messages: Message[]): Promise<void>;
  delete?(id: string): Promise<void>;
}

/** In-process store; a Redis, SQLite or file store is the same three methods. */
export class MemoryStore implements Store {
  private readonly data = new Map<string, Message[]>();
  async get(id: string): Promise<Message[] | undefined> {
    return this.data.get(id);
  }
  async set(id: string, messages: Message[]): Promise<void> {
    this.data.set(id, messages);
  }
  async delete(id: string): Promise<void> {
    this.data.delete(id);
  }
}

export interface SessionConfig {
  id: string;
  /** Default: a `MemoryStore` private to this session. */
  store?: Store;
  /** Prompt budget in tokens. Oldest turns go first; tool results are shortened before anything is dropped. Default: unlimited. */
  maxTokens?: number;
  /** Replace dropped turns with one model-written summary (asks the agent's model). Default: false, dropped turns are gone. */
  summarize?: boolean;
  /** Longest a tool result stays once the budget is hit (chars). Default 400. */
  toolResultChars?: number;
}

const TRUNCATED = ' …[truncated]';

export class Session {
  readonly id: string;
  private readonly store: Store;
  private readonly cfg: SessionConfig;
  /** chars-per-token from the last answer's `usage.promptTokens`, so the estimate learns the model's tokenizer. */
  private charsPerToken = 4;

  constructor(config: SessionConfig) {
    this.cfg = config;
    this.id = config.id;
    this.store = config.store ?? new MemoryStore();
  }

  async messages(): Promise<Message[]> {
    return (await this.store.get(this.id)) ?? [];
  }

  async clear(): Promise<void> {
    await (this.store.delete ? this.store.delete(this.id) : this.store.set(this.id, []));
  }

  /** Ask `agent` in the context of this session; the user turn, every tool round and the answer are appended. */
  async send(agent: Agent, input: string | Message, overrides: Partial<AIRequest> = {}): Promise<AgentResult> {
    const history = await this.messages();
    const user: Message = typeof input === 'string' ? { role: 'user', content: input } : input;
    const res = await agent.run([...history, user], overrides);
    if (!res.success) return res;
    let next = [...history, user, ...transcript(res)];
    if (res.usage?.promptTokens) this.charsPerToken = Math.max(1, chars(next) / res.usage.promptTokens);
    next = await this.fit(next, agent);
    await this.store.set(this.id, next);
    return res;
  }

  /** Tokens the stored conversation is estimated to cost. */
  async estimateTokens(): Promise<number> {
    return Math.ceil(chars(await this.messages()) / this.charsPerToken);
  }

  private async fit(messages: Message[], agent: Agent): Promise<Message[]> {
    const budget = this.cfg.maxTokens;
    if (!budget) return messages;
    const over = (m: Message[]) => chars(m) / this.charsPerToken > budget;
    if (!over(messages)) return messages;

    // 1. Shorten tool results, oldest first: they are the bulk and the least worth keeping verbatim.
    const cap = this.cfg.toolResultChars ?? 400;
    messages = messages.map((m) => (m.role === 'tool' && m.content.length > cap ? { ...m, content: m.content.slice(0, cap) + TRUNCATED } : m));
    if (!over(messages)) return messages;

    // 2. Drop whole turns (a user message and everything up to the next one) oldest first, never the last one.
    // Whole turns so an assistant's tool calls never lose their results.
    const system = messages.filter((m) => m.role === 'system');
    const turns = splitTurns(messages.filter((m) => m.role !== 'system'));
    const dropped: Message[][] = [];
    while (turns.length > 1 && over([...system, ...turns.flat()])) dropped.push(turns.shift()!);
    if (dropped.length && this.cfg.summarize) {
      const summary = await summarize(agent, dropped.flat());
      if (summary) system.push({ role: 'system', content: `Earlier in this conversation (summarized):\n${summary}` });
    }
    return [...system, ...turns.flat()];
  }
}

/** The messages an answer adds to the conversation: one assistant turn per tool round with its results, then the answer. */
export function transcript(res: AIResponse): Message[] {
  const out: Message[] = [];
  for (const step of res.steps ?? []) {
    out.push({ role: 'assistant', content: step.text, toolCalls: step.toolCalls });
    for (const r of step.toolResults) out.push({ role: 'tool', toolCallId: r.toolCallId, name: r.name, content: toolResultContent(r) });
  }
  // Calls the loop did not run (no `execute`, or `maxSteps` reached) are not stored: a call without its result is a request most hosts reject.
  out.push({ role: 'assistant', content: res.data ?? '' });
  return out;
}

function chars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += typeof m.content === 'string' ? m.content.length : m.content.reduce((a, p) => a + (p.type === 'text' ? p.text.length : 1000), 0);
    if (m.role === 'assistant' && m.toolCalls) n += JSON.stringify(m.toolCalls).length;
  }
  return n;
}

function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(m);
  }
  return turns;
}

async function summarize(agent: Agent, dropped: Message[]): Promise<string | undefined> {
  const text = dropped
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')}`)
    .join('\n');
  const res = await agent.run(`Summarize this conversation so far in a few sentences, keeping every fact, decision and open question:\n\n${text}`, {
    tools: undefined,
    maxSteps: 1,
    systemPrompt: 'You write terse, complete summaries.',
  });
  return res.success ? res.data : undefined;
}
