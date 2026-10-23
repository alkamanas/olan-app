// @vitest-environment node
// Apps written before the `@olan-app` scope import `@olan/app-sdk` (and `@olan/app-schema`): the
// build keeps accepting those names, subpaths included, as aliases of `@olan-app/sdk`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { buildBackend } from '../src/backend/build';
import { buildApp } from '../src/commands/build';
import { CliError } from '../src/errors';
import { canonicalPackageName } from '../src/package-aliases';
import { renderApp } from '../src/testing';
import { manifest, tempProject, type TempProject } from './helpers';

const SDK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app-sdk');

const LEGACY_APP = `import { Screen, Text, defineApp } from '@olan/app-sdk';
import type { UiNode } from '@olan/app-sdk/tree';
import { APP_ID_PATTERN } from '@olan/app-schema';
import { olan } from '@olan-app/sdk';
const node: UiNode | null = null;
function Home() {
  return <Screen title="Eski"><Text text={APP_ID_PATTERN.test('com.example.x') && typeof olan === 'object' && node === null ? 'Eski ad' : 'x'} /></Screen>;
}
export default defineApp({ app: Home });
`;

const LEGACY_SERVER = `import { defineBackend } from '@olan/app-sdk/backend';
export default defineBackend({ functions: { ping: () => 'pong' } });
`;

const projects: TempProject[] = [];
const cleanups: string[] = [];
afterAll(() => {
  for (const project of projects) project.remove();
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): TempProject {
  const created = tempProject(name, files);
  projects.push(created);
  return created;
}

function sdkInputs(projectDir: string): string[] {
  const metafile = JSON.parse(readFileSync(join(projectDir, '.olan-app', 'metafile.json'), 'utf8')) as { inputs: Record<string, unknown> };
  return Object.keys(metafile.inputs).filter((input) => input.includes('app-sdk/src/'));
}

describe('legacy package names', () => {
  it('maps @olan/app-* to @olan-app/*', () => {
    expect(canonicalPackageName('@olan/app-sdk')).toBe('@olan-app/sdk');
    expect(canonicalPackageName('@olan/app-schema')).toBe('@olan-app/schema');
    expect(canonicalPackageName('react')).toBe('react');
  });

  it('builds an app that imports @olan/app-sdk, its subpaths and @olan/app-schema (one SDK copy)', async () => {
    const app = project('legacy-ui', { 'olan-app.json': manifest(), 'src/app.tsx': LEGACY_APP });
    const { result } = await buildApp(app.dir, { minify: false });
    expect(result.bytes).toBeGreaterThan(0);
    const inputs = sdkInputs(app.dir);
    expect(inputs.length).toBeGreaterThan(0);
    // Every SDK module comes from the one SDK directory, whichever name imported it.
    expect(new Set(inputs.map((input) => input.split('app-sdk/src/')[0]))).toHaveProperty('size', 1);
    const rendered = await renderApp({ root: app.dir });
    rendered.expectText('Eski ad');
    await rendered.dispose();
  });

  it('builds backend code that imports @olan/app-sdk/backend, and still rejects the UI SDK there', async () => {
    const backendManifest = manifest({ sdk: '^1.4.0', server: { entry: 'server/index.ts' } });
    const ok = project('legacy-backend', { 'olan-app.json': backendManifest, 'src/app.tsx': LEGACY_APP, 'server/index.ts': LEGACY_SERVER });
    const built = await buildBackend(ok.dir, JSON.parse(backendManifest), { write: false });
    expect(built.code).toContain('__olanBackendModule');

    const bad = project('legacy-backend-ui', { 'olan-app.json': backendManifest, 'src/app.tsx': LEGACY_APP, 'server/index.ts': `import { Text } from '@olan/app-sdk';\nimport { defineBackend } from '@olan/app-sdk/backend';\nexport default defineBackend({ functions: { f: () => String(Text) } });\n` });
    const failure = await buildBackend(bad.dir, JSON.parse(backendManifest), { write: false }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).issues.map((entry) => entry.code)).toContain('build.backend_forbidden_import');
  });

  it('builds an app whose SDK is installed under the legacy name only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olan-app-legacy-'));
    cleanups.push(dir);
    mkdirSync(join(dir, 'node_modules', '@olan'), { recursive: true });
    symlinkSync(SDK_DIR, join(dir, 'node_modules', '@olan', 'app-sdk'), 'dir');
    // Outside the workspace: no @olan-app/sdk anywhere on the lookup path.
    const files = { 'olan-app.json': manifest(), 'src/app.tsx': `import { Screen, Text, defineApp } from '@olan/app-sdk';\nexport default defineApp({ app: () => <Screen title="Eski"><Text text="Yalnız eski ad" /></Screen> });\n` };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    // The generated entry imports @olan-app/sdk/runtime; it resolves to the legacy install.
    const { result } = await buildApp(dir, { minify: false });
    expect(result.bytes).toBeGreaterThan(0);
    expect(sdkInputs(dir).length).toBeGreaterThan(0);
  });
});
