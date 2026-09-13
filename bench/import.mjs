// Cold-import cost of the core entry, measured in a fresh child each time so
// the module cache can't warm later runs. Also proves the import touches no network.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

const child = `
globalThis.fetch = () => { throw new Error('unexpected network call during import'); };
const t0 = performance.now();
await import(${JSON.stringify('file:///' + entry.replace(/\\/g, '/'))});
console.log(performance.now() - t0);
`;

const RUNS = 5;
const times = [];
for (let i = 0; i < RUNS; i++) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(1);
  }
  times.push(Number(result.stdout.trim()));
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`runs: ${times.map((t) => t.toFixed(2)).join(', ')} ms`);
console.log(`median cold import: ${median.toFixed(2)}ms`);
