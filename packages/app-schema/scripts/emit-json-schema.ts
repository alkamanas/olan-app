/**
 * Writes `schemas/olan-app.v1.json` from the zod manifest schema.
 * Run from this package: `npx tsx scripts/emit-json-schema.ts` (or `npm run emit-schema`).
 * Pass `--check` to fail instead of writing when the committed file is stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_JSON_SCHEMA_FILE, manifestJsonSchemaText } from '../src/json-schema.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(packageRoot, MANIFEST_JSON_SCHEMA_FILE);
const text = manifestJsonSchemaText();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // Missing file counts as stale.
  }
  if (current !== text) {
    console.error(`${MANIFEST_JSON_SCHEMA_FILE} is out of date. Run: npx tsx scripts/emit-json-schema.ts`);
    process.exit(1);
  }
  console.log(`${MANIFEST_JSON_SCHEMA_FILE} is up to date.`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`Wrote ${MANIFEST_JSON_SCHEMA_FILE}`);
}
