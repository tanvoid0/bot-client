// Published-size check: bundle + minify dist output with esbuild, then gzip.
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

function bundle(entry) {
  return buildSync({ entryPoints: [isAbsolute(entry) ? entry : join(dist, entry)], bundle: true, minify: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].contents;
}

/** What a consumer who imports `./core` plus one provider subpath actually ships. */
function bundleSource(source) {
  const entry = join(tmpdir(), `bot-client-size-${process.pid}.mjs`);
  writeFileSync(entry, source.replaceAll('<dist>', dist.replaceAll('\\', '/')));
  try {
    return bundle(entry);
  } finally {
    unlinkSync(entry);
  }
}

function report(label, entry, raw = bundle(entry)) {
  const gz = gzipSync(raw);
  console.log(`${label}: raw=${raw.length}B  gz=${gz.length}B`);
}

report('index.js (.)', 'index.js');
report('core.js (./core)', 'core.js');
report(
  './core + ./openai',
  null,
  bundleSource("import { AIFactory } from '<dist>/core.js'; import { OpenAIProvider } from '<dist>/providers/openai-provider.js'; console.log(new AIFactory({ providers: [new OpenAIProvider()] }));")
);
for (const p of ['openai-compatible', 'openai-provider', 'anthropic-provider', 'gemini-provider', 'ollama-provider', 'lmstudio-provider']) {
  report(`providers/${p}.js`, `providers/${p}.js`);
}
for (const a of ['agent', 'session', 'mcp', 'embed', 'cost']) {
  report(`agent/${a}.js (./${a})`, `agent/${a}.js`);
}
