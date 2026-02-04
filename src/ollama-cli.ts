import { spawn } from 'child_process';

/** Result of running an Ollama CLI command */
export interface OllamaCLIResult {
  /** Exit code (0 = success) */
  code: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether the command succeeded */
  ok: boolean;
}

/** Options for running Ollama CLI commands */
export interface OllamaCLIOptions {
  /** Timeout in milliseconds (default: none for pull, 30s for others) */
  timeout?: number;
  /** Optional path to the ollama executable (default: "ollama" from PATH) */
  executablePath?: string;
  /** Callback for progress output (e.g. pull progress on stderr) */
  onStderr?: (chunk: string) => void;
}

const DEFAULT_TIMEOUT = 30_000;
/** No timeout for long operations like pull */
const NO_TIMEOUT = 0;

/**
 * Run the native `ollama` CLI with a subcommand and arguments.
 * Uses the system PATH to find `ollama` unless executablePath is set.
 *
 * @example
 * const result = await runOllamaCLI('pull', ['llama3.1:8b'], { onStderr: (c) => console.log(c) });
 * const listResult = await runOllamaCLI('ls', []);
 */
export function runOllamaCLI(
  subcommand: string,
  args: string[] = [],
  options: OllamaCLIOptions = {}
): Promise<OllamaCLIResult> {
  const { timeout, executablePath = 'ollama', onStderr } = options;
  const effectiveTimeout =
    timeout !== undefined
      ? timeout
      : subcommand === 'pull' || subcommand === 'serve'
        ? NO_TIMEOUT
        : DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const proc = spawn(executablePath, [subcommand, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      resolve({
        code: code ?? (proc.exitCode ?? -1),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ok: code === 0
      });
    };

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        timer && clearTimeout(timer);
        reject(err);
      }
    });

    proc.on('close', (code, signal) => {
      finish(signal ? -1 : (code ?? -1));
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(-1);
      }, effectiveTimeout);
    }
  });
}

/**
 * Check if the Ollama CLI is available on the system.
 * Returns true if the `ollama` binary can be executed (e.g. found on PATH).
 */
export async function isOllamaCLIAvailable(executablePath: string = 'ollama'): Promise<boolean> {
  try {
    await runOllamaCLI('ls', [], {
      timeout: 5_000,
      executablePath
    });
    return true;
  } catch {
    return false;
  }
}
