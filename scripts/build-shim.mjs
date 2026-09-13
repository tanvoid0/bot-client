// Writes shim/: the @tanvoid0/bot-client package that re-exports llmwire, one major long.
// Publish with `npm publish ./shim` after llmwire itself is published.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const OLD = '@tanvoid0/bot-client';
const NEW = pkg.name;
const out = 'shim';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

const exportsMap = {};
const typesVersions = {};
for (const sub of Object.keys(pkg.exports)) {
  if (sub === './cli' || sub === './package.json') continue;
  const name = sub === '.' ? 'index' : sub.slice(2);
  const target = sub === '.' ? NEW : `${NEW}${sub.slice(1)}`;
  writeFileSync(`${out}/${name}.js`, `export * from '${target}';\n`);
  writeFileSync(`${out}/${name}.cjs`, `module.exports = require('${target}');\n`);
  writeFileSync(`${out}/${name}.d.ts`, `export * from '${target}';\n`);
  exportsMap[sub] = { types: `./${name}.d.ts`, import: `./${name}.js`, require: `./${name}.cjs` };
  if (sub !== '.') typesVersions[name] = [`${name}.d.ts`];
}
writeFileSync(`${out}/cli.js`, `#!/usr/bin/env node\nimport '${NEW}/cli';\n`);

writeFileSync(`${out}/package.json`, JSON.stringify({
  name: OLD,
  version: pkg.version,
  description: `Renamed to ${NEW}. This package re-exports it unchanged; switch your import when convenient.`,
  type: 'module',
  main: './index.cjs',
  module: './index.js',
  types: './index.d.ts',
  exports: exportsMap,
  typesVersions: { '*': typesVersions },
  bin: { 'bot-client': './cli.js' },
  dependencies: { [NEW]: `^${pkg.version}` },
  sideEffects: false,
  keywords: pkg.keywords,
  repository: pkg.repository,
  homepage: pkg.homepage,
  license: pkg.license,
  author: pkg.author,
  publishConfig: pkg.publishConfig,
}, null, 2) + '\n');

writeFileSync(`${out}/README.md`, `# ${OLD}\n\nRenamed to [\`${NEW}\`](https://www.npmjs.com/package/${NEW}). This package re-exports it unchanged, including every subpath (\`${OLD}/openai\` → \`${NEW}/openai\`) and the \`bot-client\` CLI. Switch your import when convenient; this shim is kept for one major.\n`);
console.log(`shim/ written for ${OLD}@${pkg.version} → ${NEW}`);
