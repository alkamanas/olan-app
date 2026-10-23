#!/usr/bin/env node
// `olan-app` on npm is a shortcut for @olan-app/cli, so `npx olan-app …` runs the real CLI.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cli = dirname(require.resolve('@olan-app/cli/package.json'));
await import(pathToFileURL(join(cli, 'bin', 'olan-app.js')).href);
