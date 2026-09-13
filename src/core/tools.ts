/**
 * Tool calling shared by every provider: the OpenAI-format definitions most
 * hosts take, argument parsing, recovery of calls a weak model leaks as text,
 * running the tools, and the request for the next step of the loop.
 */
import type { AIRequest, Message, Tool, ToolCall, ToolResult } from '../types/index.js';

/** `tools[]` as OpenAI-format function definitions (Ollama and every compatible host take the same shape). */
export function openaiTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, ...(t.description && { description: t.description }), parameters: t.parameters },
  }));
}

export function openaiToolChoice(choice: AIRequest['toolChoice']): unknown {
  return typeof choice === 'object' ? { type: 'function', function: { name: choice.name } } : choice;
}

/** A tool call's arguments: parsed when the provider sent JSON text, the raw string when that text is not JSON. */
export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The text a provider wants for a tool's arguments. */
export function stringifyArgs(args: unknown): string {
  return typeof args === 'string' ? args : JSON.stringify(args ?? {});
}

const LEAKED = /<function=([\w.:-]+)>([\s\S]*?)<\/function>/g;

/**
 * Weak local models print `<function=name>{json}</function>` as text instead
 * of a real tool call. Recovers those (first occurrence per tool wins) and
 * strips the markup from the shown text. Only tools in `tools` are recovered;
 * anything else is left as written.
 */
export function recoverLeakedToolCalls(text: string, tools: Tool[] | undefined): { text: string; toolCalls: ToolCall[] } {
  if (!tools?.length || !text.includes('<function=')) return { text, toolCalls: [] };
  const known = new Set(tools.map((t) => t.name));
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const stripped = text.replace(LEAKED, (whole, name: string, body: string) => {
    if (!known.has(name)) return whole;
    if (!seen.has(name)) {
      seen.add(name);
      toolCalls.push({ id: `leaked_${toolCalls.length}`, name, arguments: parseArgs(body.trim()) });
    }
    return '';
  });
  return { text: toolCalls.length ? stripped.trim() : text, toolCalls };
}

/** Whether every call names a tool that has `execute`, so the loop can run them. */
export function canRun(tools: Tool[] | undefined, calls: ToolCall[]): boolean {
  return calls.length > 0 && calls.every((c) => tools?.find((t) => t.name === c.name)?.execute);
}

/** Runs the calls in parallel. A throwing tool becomes an `error` result the model sees; the request does not fail. */
export function runTools(tools: Tool[], calls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
  return Promise.all(
    calls.map(async (call): Promise<ToolResult> => {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool?.execute) return { toolCallId: call.id, name: call.name, error: `No tool named "${call.name}"` };
      try {
        return { toolCallId: call.id, name: call.name, result: await tool.execute(call.arguments, { signal }) };
      } catch (e) {
        return { toolCallId: call.id, name: call.name, error: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

/** What goes back to the model for one result. */
export function toolResultContent(r: ToolResult): string {
  if (r.error !== undefined) return JSON.stringify({ error: r.error });
  return typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
}

/**
 * The request for the next step: the conversation so far, the assistant turn
 * that made the calls, and one tool message per result. `toolChoice` is
 * dropped so a forced first call does not force every step.
 */
export function nextStepRequest(req: AIRequest, text: string, calls: ToolCall[], results: ToolResult[]): AIRequest {
  const messages: Message[] = [
    ...((req.messages ?? req.history ?? []) as Message[]),
    ...(req.prompt !== undefined ? [{ role: 'user', content: req.prompt } as Message] : []),
    { role: 'assistant', content: text, toolCalls: calls },
    ...results.map((r): Message => ({ role: 'tool', toolCallId: r.toolCallId, name: r.name, content: toolResultContent(r) })),
  ];
  return { ...req, messages, prompt: undefined, history: undefined, toolChoice: undefined };
}
