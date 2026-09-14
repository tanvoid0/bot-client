/** @module llmwire/mcp-stdio */
/**
 * MCP stdio transport (Node only): spawns the server and speaks
 * newline-delimited JSON-RPC over its stdin/stdout. Pass it to
 * `McpClient.connect({ transport })`.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mcpError, type JsonRpcRequest, type JsonRpcResponse, type McpTransport } from './mcp.js';

export interface StdioOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** ms to wait for a reply before failing the call with `MCP_ERROR`. Default 60000; 0 disables. */
  timeout?: number;
}

export class McpStdioTransport implements McpTransport {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private exited?: string;

  constructor(private readonly opts: StdioOptions) {
    this.child = spawn(opts.command, opts.args ?? [], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.read(chunk));
    this.child.on('error', (err) => this.fail(`MCP server failed to start: ${err.message}`));
    this.child.on('exit', (code, signal) => this.fail(`MCP server exited (${signal ?? code})`));
  }

  request(msg: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.exited) return Promise.reject(mcpError(this.exited));
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeoutMs = this.opts.timeout ?? 60_000;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(msg.id!);
        reject(mcpError(`No reply to ${msg.method} within ${timeoutMs} ms`));
      }, timeoutMs) : undefined;
      this.pending.set(msg.id!, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write(msg);
    });
  }

  async notify(msg: JsonRpcRequest): Promise<void> {
    if (this.exited) throw mcpError(this.exited);
    this.write(msg);
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private write(msg: unknown): void {
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server's stray stdout line, not ours to fail on
      }
      const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (waiter && ('result' in msg || 'error' in msg)) {
        this.pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  }

  private fail(reason: string): void {
    this.exited = reason;
    for (const w of this.pending.values()) w.reject(mcpError(reason));
    this.pending.clear();
  }
}
