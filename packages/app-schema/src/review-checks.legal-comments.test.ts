import { describe, expect, it } from 'vitest';
import { runStaticReviewChecks, type OlanAppManifest } from './index.js';

/* Decision 2026-10-17: the CLI bundles with esbuild `legalComments: 'eof'`; those notices satisfy 6.1. */

const manifest = { schemaVersion: 1, id: 'com.acme.notes', name: 'Notes', version: '1.0.0', sdk: '^1.0.0', entry: 'dist/app.js', kind: 'app', surfaces: { app: { title: 'Notes' } }, permissions: [] } as unknown as OlanAppManifest;
const reactish = 'var e="https://react.dev/errors/";export default e;';
const eof = `\n/*! Bundled license information:\n\nreact/cjs/react.production.js:\n  (**\n   * @license React\n   * react.production.js\n   *\n   * Copyright (c) Meta Platforms, Inc. and affiliates.\n   *\n   * This source code is licensed under the MIT license found in the\n   * LICENSE file in the root directory of this source tree.\n   *)\n*/\n`;

const licenses = (code: string) =>
  runStaticReviewChecks({ manifest, files: { 'olan-app.json': '{}', 'dist/app.js': code } }).findings.filter((finding) => finding.check === 'licenses').map((finding) => finding.code);

describe('license notices from legalComments: eof', () => {
  it('flags React without notices, and accepts the eof notice block', () => {
    expect(licenses(reactish)).toContain('licenses.notices_missing');
    expect(licenses(reactish + eof)).toEqual(['licenses.found']);
  });

  it('finds the eof block after a "/*" inside a string (accept: ["image/*"])', () => {
    // The textual scan reads `/*","video/*"]…` as a comment that ends where the eof block ends.
    const code = `var e="https://react.dev/errors/";var a=["image/*","video/*"];${'var x=1;'.repeat(800)}export default [e,a];`;
    expect(licenses(code + eof)).toEqual(['licenses.found']);
  });
});
