// The CJS build lands inside a "type": "module" package, so Node would still
// read its .js files as ESM. A nested package.json flips that one directory
// back to CommonJS. Also strips the .js extensions the ESM sources use in
// relative imports, which Node's CJS resolver does not need but tolerates.
const fs = require('fs');
const path = require('path');

const cjsDir = path.join(__dirname, '..', 'dist', 'cjs');

fs.writeFileSync(
  path.join(cjsDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);

console.log('CJS build finalized:', cjsDir);
