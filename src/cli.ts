#!/usr/bin/env node

/**
 * CLI for @tanvoid0/bot-client: Ollama models, API keys, and provider config.
 * Run with: npx @tanvoid0/bot-client <command> [subcommand] [options]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { OllamaProvider } from './providers/ollama-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { LMStudioProvider } from './providers/lmstudio-provider.js';
import { OpenAICompatibleProvider, PRESETS, type PresetId } from './providers/openai-compatible.js';
import { runOllamaCLI } from './ollama-cli.js';
import type { AIProvider } from './types/index.js';

const KNOWN_KEYS = [
  'BOT_CLIENT_PROVIDER',
  'BOT_CLIENT_OPENAI_KEY',
  'BOT_CLIENT_ANTHROPIC_KEY',
  'BOT_CLIENT_GEMINI_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY'
] as const;

function getEnvPath(): string {
  return resolve(process.cwd(), '.env');
}

function loadEnv(): Record<string, string> {
  const path = getEnvPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function saveEnv(env: Record<string, string>): void {
  const path = getEnvPath();
  const lines = Object.entries(env).map(([k, v]) => {
    const safe = /^\w+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
    return `${k}=${safe}`;
  });
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function mask(value: string): string {
  if (!value || value.length < 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function printHelp(): void {
  const help = `
bot-client - Ollama models, API keys, and provider config

Usage:
  npx @tanvoid0/bot-client ollama <command> [args...]
  npx @tanvoid0/bot-client keys <command> [args...]
  npx @tanvoid0/bot-client doctor [provider...]
  npx @tanvoid0/bot-client help

Doctor:
  Lists each provider's models, then sends it a one-line prompt and prints
  the model that answered or the classified error. Built-ins by default;
  name presets (groq, openrouter, deepseek, mistral, xai, together) to add them.

Ollama commands (uses local API when server is up, else ollama CLI):
  list, ls          List models
  pull <model>      Pull a model
  rm <model>        Remove a model
  show <model>      Show model info
  ps                List running models
  run <model> [prompt]  Run model with optional prompt

Keys commands (read/write .env in current directory):
  list, ls          List known API keys (masked)
  get <key> [--show]  Get value for KEY (masked unless --show)
  set <key> <value>   Set KEY=value in .env

Examples:
  npx @tanvoid0/bot-client ollama list
  npx @tanvoid0/bot-client ollama pull llama3.1:8b
  npx @tanvoid0/bot-client keys list
  npx @tanvoid0/bot-client keys set BOT_CLIENT_OPENAI_KEY sk-...
  npx @tanvoid0/bot-client keys get BOT_CLIENT_OPENAI_KEY --show
  npx @tanvoid0/bot-client doctor
  npx @tanvoid0/bot-client doctor groq
`;
  console.log(help.trim());
}

async function runOllama(argv: string[]): Promise<number> {
  const cmd = argv[0]?.toLowerCase();
  const rest = argv.slice(1);
  const provider = new OllamaProvider({
    baseURL: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    cli: runOllamaCLI,
  });

  if (!cmd || cmd === 'help') {
    console.log('Ollama: list | pull <model> | rm <model> | show <model> | ps | run <model> [prompt]');
    return 0;
  }

  try {
    if (cmd === 'list' || cmd === 'ls') {
      const r = await provider.list();
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Failed to list models');
        return 1;
      }
      try {
        const data = JSON.parse(r.stdout);
        if (data.models && Array.isArray(data.models)) {
          data.models.forEach((m: { name?: string }) => console.log(m.name ?? m));
        } else {
          console.log(r.stdout);
        }
      } catch {
        console.log(r.stdout);
      }
      return 0;
    }

    if (cmd === 'pull') {
      const model = rest[0];
      if (!model) {
        console.error('Usage: ollama pull <model>');
        return 1;
      }
      const r = await provider.pull(model, { onStderr: (c) => process.stderr.write(c) });
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Pull failed');
        return 1;
      }
      console.log(r.stdout || 'Pull completed');
      return 0;
    }

    if (cmd === 'rm') {
      const model = rest[0];
      if (!model) {
        console.error('Usage: ollama rm <model>');
        return 1;
      }
      const r = await provider.rm(model);
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Remove failed');
        return 1;
      }
      console.log('Model removed');
      return 0;
    }

    if (cmd === 'show') {
      const model = rest[0];
      if (!model) {
        console.error('Usage: ollama show <model>');
        return 1;
      }
      const r = await provider.show(model);
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Show failed');
        return 1;
      }
      console.log(r.stdout);
      return 0;
    }

    if (cmd === 'ps') {
      const r = await provider.ps();
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Failed');
        return 1;
      }
      try {
        const data = JSON.parse(r.stdout);
        if (data.models && Array.isArray(data.models)) {
          data.models.forEach((m: { model?: string }) => console.log(m.model ?? m));
        } else {
          console.log(r.stdout);
        }
      } catch {
        console.log(r.stdout);
      }
      return 0;
    }

    if (cmd === 'run') {
      const model = rest[0];
      const prompt = rest.slice(1).join(' ').trim() || undefined;
      if (!model) {
        console.error('Usage: ollama run <model> [prompt]');
        return 1;
      }
      const r = await provider.run(model, prompt);
      if (!r.ok) {
        console.error(r.stderr || r.stdout || 'Run failed');
        return 1;
      }
      if (r.stdout) console.log(r.stdout);
      return 0;
    }

    console.error('Unknown ollama command:', cmd);
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

function runKeys(argv: string[]): number {
  const cmd = argv[0]?.toLowerCase();
  const rest = argv.slice(1);
  const showValue = rest.includes('--show');
  const args = rest.filter((a) => a !== '--show');

  if (!cmd || cmd === 'help') {
    console.log('Keys: list | get <key> [--show] | set <key> <value>');
    return 0;
  }

  if (cmd === 'list' || cmd === 'ls') {
    const env = { ...process.env, ...loadEnv() };
    KNOWN_KEYS.forEach((key) => {
      const v = env[key];
      console.log(v ? `${key}=${mask(v)}` : `${key}=(not set)`);
    });
    return 0;
  }

  if (cmd === 'get') {
    const key = args[0];
    if (!key) {
      console.error('Usage: keys get <key> [--show]');
      return 1;
    }
    const env = { ...process.env, ...loadEnv() };
    const v = env[key];
    if (v === undefined) {
      console.error(`Key ${key} is not set`);
      return 1;
    }
    console.log(showValue ? v : mask(v));
    return 0;
  }

  if (cmd === 'set') {
    const key = args[0];
    const value = args.slice(1).join(' ').trim();
    if (!key || value === '') {
      console.error('Usage: keys set <key> <value>');
      return 1;
    }
    const env = loadEnv();
    env[key] = value;
    saveEnv(env);
    console.log(`Set ${key} in ${getEnvPath()}`);
    return 0;
  }

  console.error('Unknown keys command:', cmd);
  return 1;
}

/** One line per provider: reachability, first model, and the classified error with its hint when it fails. */
async function runDoctor(argv: string[]): Promise<number> {
  const providers: AIProvider[] = [
    new OpenAIProvider(),
    new AnthropicProvider(),
    new GeminiProvider(),
    new OllamaProvider({ baseURL: process.env.OLLAMA_HOST ?? 'http://localhost:11434', cli: runOllamaCLI }),
    new LMStudioProvider(),
  ];
  for (const name of argv) {
    if (!(name in PRESETS)) {
      console.error(`Unknown preset "${name}"; known: ${Object.keys(PRESETS).join(', ')}`);
      return 1;
    }
    providers.push(new OpenAICompatibleProvider({ preset: name as PresetId }));
  }
  const rows = await Promise.all(
    providers.map(async (p) => {
      const t0 = Date.now();
      const models = await p.discoverModels().catch(() => [] as string[]);
      const r = await p.process({ prompt: 'Reply with the single word: ok', maxTokens: 16, timeout: 20_000 });
      const ms = Date.now() - t0;
      const status = r.success ? `ok    ${r.modelUsed}` : `FAIL  ${r.errorInfo?.code ?? 'UNKNOWN'}`;
      const detail = r.success ? `${models.length} models` : `${r.error}${r.errorInfo?.hint ? ` — ${r.errorInfo.hint}` : ''}`;
      return { id: p.providerId, line: `${p.providerId.padEnd(12)} ${status.padEnd(34)} ${detail} (${ms} ms)`, ok: r.success };
    })
  );
  for (const row of rows) console.log(row.line);
  return rows.some((r) => r.ok) ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const top = argv[0]?.toLowerCase();
  const rest = argv.slice(1);

  if (!top || top === 'help' || top === '--help' || top === '-h') {
    printHelp();
    return 0;
  }

  if (top === 'ollama') return runOllama(rest);
  if (top === 'keys') return runKeys(rest);
  if (top === 'doctor') return runDoctor(rest);

  console.error('Unknown command:', top);
  printHelp();
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
