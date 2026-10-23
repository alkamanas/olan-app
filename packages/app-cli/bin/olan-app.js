#!/usr/bin/env node
// olan-app: the bundled CLI lives in dist/ (`npm --workspace @olan-app/cli run build`).
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`olan-app needs Node.js 22 or newer (this is ${process.version}).`);
  process.exit(1);
}
try {
  await import('../dist/cli.js');
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('dist')) {
    console.error('olan-app is not built yet: run `npm --workspace @olan-app/cli run build` (or `npm run build` in packages/app-cli).');
    process.exit(1);
  }
  throw error;
}
