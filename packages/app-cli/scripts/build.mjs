// Bundles the CLI (dist/cli.js) and the headless test helpers (dist/testing.js) for plain Node.
// The CLI's own sources, @olan-app/schema and @olan-app/sdk are bundled; tools with native
// binaries or their own module graph stay external.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// @olan-app/runtime forks its own dist/main.js and loads isolated-vm (native) / QuickJS (WASM).
const external = ['esbuild', 'ws', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'react', 'react-reconciler', 'zod', 'fflate', '@olan-app/runtime', 'isolated-vm', 'quickjs-emscripten'];

rmSync(join(root, 'dist'), { recursive: true, force: true });
const started = Date.now();
await build({
  entryPoints: { cli: join(root, 'src/main.ts'), testing: join(root, 'src/testing/index.ts'), index: join(root, 'src/index.ts') },
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  sourcemap: 'linked',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __olanCreateRequire } from 'node:module'; const require = __olanCreateRequire(import.meta.url);" },
});
console.log(`@olan-app/cli built into dist/ in ${Date.now() - started} ms`);
