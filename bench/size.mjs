// Published-size check: bundle + minify dist output with esbuild, then gzip.
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
// Run the esbuild JS wrapper directly via `node`: avoids `npx`/cmd-shim
// resolution weirdness on Windows and the shell:true arg-escaping warning.
const esbuildBin = createRequire(import.meta.url).resolve('esbuild/bin/esbuild');

function bundle(entry) {
  return execFileSync(
    process.execPath,
    [esbuildBin, entry, '--bundle', '--minify', '--format=esm', '--platform=node'],
    { cwd: dist, maxBuffer: 32 * 1024 * 1024 }
  );
}

function report(label, entry) {
  const raw = bundle(entry);
  const gz = gzipSync(raw);
  console.log(`${label}: raw=${raw.length}B  gz=${gz.length}B`);
}

report('index.js (.)', 'index.js');
for (const p of ['openai-compatible', 'openai-provider', 'anthropic-provider', 'gemini-provider', 'ollama-provider', 'lmstudio-provider']) {
  report(`providers/${p}.js`, `providers/${p}.js`);
}
