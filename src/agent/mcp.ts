/**
 * MCP client: JSON-RPC 2.0 over Streamable HTTP (`fetch`, any runtime), no
 * SDK. A server's tools come back as `Tool[]` whose `execute` calls
 * `tools/call`, so they drop straight into an `Agent` or `AIRequest.tools`.
 * Stdio lives in `./mcp-stdio` (Node only). Sampling, roots and the
 * server-initiated notification stream are not implemented; only replies to
 * our own requests are read.
 */
import { AIError, toAIError } from '../core/errors.js';
import { parseSSE } from '../core/http.js';
import type { FetchLike } from '../core/http.js';
import type { Tool } from '../types/index.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** How messages reach the server. `request` resolves with the matching response; `notify` expects none. */
export interface McpTransport {
  request(msg: JsonRpcRequest): Promise<JsonRpcResponse>;
  notify(msg: JsonRpcRequest): Promise<void>;
  close?(): Promise<void>;
}

export interface McpHttpOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface McpConnectOptions extends Partial<McpHttpOptions> {
  transport?: McpTransport;
  /** Sent in `initialize` as `clientInfo`. */
  name?: string;
  version?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
/** One item of a tool result, resource read or prompt message. */
export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [k: string]: unknown;
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export function mcpError(message: string, extra: { code?: number; details?: unknown; status?: number } = {}): AIError {
  return AIError.from({
    message,
    provider: 'mcp',
    code: 'MCP_ERROR',
    providerCode: extra.code !== undefined ? String(extra.code) : undefined,
    statusCode: extra.status,
    details: extra.details,
    hint: 'The MCP server rejected the call; the message is its own. Check the tool name and arguments against `tools()`.',
  });
}

/** Streamable HTTP: every message is a POST; the reply is JSON or an SSE stream carrying the response. */
export class McpHttpTransport implements McpTransport {
  private sessionId?: string;
  constructor(private readonly opts: McpHttpOptions) {}

  async request(msg: JsonRpcRequest): Promise<JsonRpcResponse> {
    const res = await this.post(msg);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      if (!res.body) throw mcpError('Empty event stream from the MCP server');
      for await (const ev of parseSSE(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (!ev.data) continue;
        const parsed = JSON.parse(ev.data);
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) if (m.id === msg.id && ('result' in m || 'error' in m)) return m;
      }
      throw mcpError(`No response to ${msg.method} before the MCP server closed the stream`);
    }
    const parsed = await res.json();
    const reply = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => m.id === msg.id);
    if (!reply) throw mcpError(`No response to ${msg.method} in the MCP server's reply`, { details: parsed });
    return reply;
  }

  async notify(msg: JsonRpcRequest): Promise<void> {
    const res = await this.post(msg);
    await res.body?.cancel().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await this.send('DELETE').catch(() => undefined);
    this.sessionId = undefined;
  }

  private async post(msg: JsonRpcRequest): Promise<Response> {
    const res = await this.send('POST', msg);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  private async send(method: 'POST' | 'DELETE', body?: unknown): Promise<Response> {
    const f = this.opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await f(this.opts.url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          ...(this.sessionId && { 'mcp-session-id': this.sessionId }),
          ...this.opts.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.opts.signal,
      });
    } catch (err) {
      throw toAIError(err, { provider: 'mcp', providerName: 'MCP', baseURL: this.opts.url });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw mcpError(text || `${res.status} ${res.statusText} from the MCP server`, { status: res.status });
    }
    return res;
  }
}

export class McpClient {
  serverInfo?: { name: string; version?: string };
  capabilities: Record<string, unknown> = {};
  private nextId = 1;

  private constructor(private readonly transport: McpTransport) {}

  /** Connects and runs the `initialize` handshake. Pass `url` for Streamable HTTP, or `transport` (e.g. from `./mcp-stdio`). */
  static async connect(options: McpConnectOptions): Promise<McpClient> {
    const transport = options.transport ?? new McpHttpTransport({ url: must(options.url, 'url'), headers: options.headers, fetch: options.fetch, signal: options.signal });
    const client = new McpClient(transport);
    const init = await client.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.name ?? 'llmwire', version: options.version ?? '2.1.0' },
    });
    client.serverInfo = init.serverInfo;
    client.capabilities = init.capabilities ?? {};
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return client;
  }

  /** Any JSON-RPC method; the raw `result`. A JSON-RPC error becomes an `AIError` with code `MCP_ERROR` and `providerCode` set to the RPC code. */
  async call(method: string, params?: unknown): Promise<any> {
    const res = await this.transport.request({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (res.error) throw mcpError(res.error.message, { code: res.error.code, details: res.error.data });
    return res.result;
  }

  async ping(): Promise<void> {
    await this.call('ping');
  }

  /** The server's tools, paginated to the end. */
  async listTools(): Promise<McpTool[]> {
    return this.paginate('tools/list', 'tools');
  }

  /** The server's tools as `Tool[]`: the server's own JSON Schema, and an `execute` that calls `tools/call` and flattens the result to text. */
  async tools(): Promise<Tool[]> {
    return (await this.listTools()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
      execute: (args: unknown) => this.callTool(t.name, args),
    }));
  }

  /** `tools/call`, flattened: text items joined by newlines, anything else as JSON. A result marked `isError` throws so the model sees `{ error }`. */
  async callTool(name: string, args: unknown = {}): Promise<string> {
    const res = await this.call('tools/call', { name, arguments: args ?? {} });
    const text = flatten(res.content ?? []);
    if (res.isError) throw mcpError(text || `Tool "${name}" reported an error`);
    return res.structuredContent !== undefined && !text ? JSON.stringify(res.structuredContent) : text;
  }

  async resources(): Promise<McpResource[]> {
    return this.paginate('resources/list', 'resources');
  }

  async readResource(uri: string): Promise<McpContent[]> {
    return (await this.call('resources/read', { uri })).contents ?? [];
  }

  async prompts(): Promise<McpPrompt[]> {
    return this.paginate('prompts/list', 'prompts');
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ description?: string; messages: Array<{ role: string; content: McpContent }> }> {
    return this.call('prompts/get', { name, ...(args && { arguments: args }) });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private async paginate<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call(method, cursor ? { cursor } : undefined);
      out.push(...(page[key] ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
}

/** Text of a content list: text items verbatim, images and resources noted, anything else as JSON. */
export function flatten(content: McpContent[]): string {
  return content
    .map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image' || c.type === 'audio') return `[${c.type} ${c.mimeType ?? ''}]`.trim();
      if (c.type === 'resource') return flatten([c.resource as McpContent]);
      if (c.type === 'resource_link') return `[resource ${c.uri}]`;
      return JSON.stringify(c);
    })
    .join('\n');
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw mcpError(`McpClient.connect needs \`${name}\` or a \`transport\``);
  return v;
}
