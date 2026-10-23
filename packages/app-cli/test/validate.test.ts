// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { validateApp } from '../src/commands/validate';
import { manifest, tempProject } from './helpers';

const OK_APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() {
  return <Screen title="Merhaba"><Text text="Merhaba" /></Screen>;
}
export default defineApp({ app: Home });
`;

async function codesFor(files: Record<string, string>, strict = true) {
  const project = tempProject('validate', files);
  try {
    const { errors, warnings, result } = await validateApp(project.dir, { strict, typecheck: false });
    return { errors, warnings, result, codes: errors.map((item) => item.code) };
  } finally {
    project.remove();
  }
}

describe('validate', () => {
  it('passes a correct app and reports every check', async () => {
    const { errors, result } = await codesFor({ 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': OK_APP });
    expect(errors).toEqual([]);
    expect(result.checks.map((check) => check.name)).toEqual(['manifest', 'build', 'files', 'size', 'strict']);
    expect(result.surfaces).toMatchObject([{ surface: 'app', rendered: true, nodes: 2 }]);
    expect(result.bundleBytes).toBeGreaterThan(10_000);
  });

  it('--strict warns about a template description left unchanged; unsigned packs are fine for the marketplace', async () => {
    const template = await codesFor({ 'olan-app.json': manifest({ permissions: [], description: 'Ekibin notları, uygulamanın kendi veritabanında' }), 'src/app.tsx': OK_APP });
    expect(template.warnings.find((item) => item.code === 'manifest.description_template')).toMatchObject({ file: 'olan-app.json' });
    expect(template.warnings.find((item) => item.code === 'validate.unsigned')?.message).toContain('fine for `olan-app publish --marketplace`');
    const own = await codesFor({ 'olan-app.json': manifest({ permissions: [], description: 'Okuma listesi' }), 'src/app.tsx': OK_APP });
    expect(own.warnings.map((item) => item.code)).not.toContain('manifest.description_template');
  });

  it('locates manifest errors in olan-app.json', async () => {
    const { errors } = await codesFor({ 'olan-app.json': manifest({ colour: 'red', version: '1.0' }), 'src/app.tsx': OK_APP });
    const unknown = errors.find((item) => item.code === 'manifest.unknown_field');
    expect(unknown).toMatchObject({ file: 'olan-app.json', line: expect.any(Number) });
    expect(errors.map((item) => item.code)).toContain('manifest.version');
  });

  it('rejects DOM, react-dom and Node imports at build time', async () => {
    const { codes, errors } = await codesFor({
      'olan-app.json': manifest(),
      'src/app.tsx': `import { createRoot } from 'react-dom/client';\nimport fs from 'node:fs';\nexport default { createRoot, fs };\n`,
    });
    expect(codes).toEqual(['build.forbidden_import', 'build.forbidden_import']);
    expect(errors[0]).toMatchObject({ file: 'src/app.tsx', line: 1, hint: expect.stringContaining('components.md') });
  });

  it('reports build errors with file and line', async () => {
    const { errors } = await codesFor({ 'olan-app.json': manifest(), 'src/app.tsx': 'export default defineApp({ app: Home ;\n' });
    expect(errors[0]).toMatchObject({ code: 'build.error', file: 'src/app.tsx', line: 1 });
  });

  it('renders surfaces: unknown components, loose text, labels, keys and missing permissions', async () => {
    const { codes, warnings, result } = await codesFor({
      'olan-app.json': manifest({ permissions: [] }),
      'src/app.tsx': `
import { createElement } from 'react';
import { Button, List, Screen, Stack, defineApp, olan, useQuery } from '@olan-app/sdk';
function Home() {
  useQuery(() => olan.projects.list({}));
  useQuery(() => olan.http.fetch('https://api.example.com/x'));
  return (
    <Screen title="X">
      <Stack>
        loose text
        {createElement('div', {})}
        <Button label="" onPress={() => undefined} />
        <List items={[{ key: 1, title: 'a' }, { key: 1, title: 'b' }]} />
      </Stack>
    </Screen>
  );
}
export default defineApp({ app: Home });
`,
    });
    // Labels, keys and permissions come from the marketplace's review checks (same codes and severities).
    for (const code of ['tree.text_outside_text', 'tree.unknown_type', 'a11y.button_label_missing', 'permissions.missing', 'permissions.http_missing']) {
      expect(codes, code).toContain(code);
    }
    expect(warnings.find((item) => item.code === 'a11y.duplicate_key')).toMatchObject({ file: 'src/app.tsx', message: expect.stringMatching(/^app: /) });
    expect(result.review?.usage.rpcMethods).toEqual(['http.fetch', 'projects.list']);
    expect(result.review?.findings.find((item) => item.code === 'permissions.http_missing')).toMatchObject({ severity: 'error', rule: '2.3' });
  });

  it('checks surfaces against the manifest and the default export', async () => {
    const missing = await codesFor({ 'olan-app.json': manifest({ surfaces: { app: {}, settings: {} } }), 'src/app.tsx': OK_APP });
    expect(missing.codes).toContain('app.surface_missing');
    const noExport = await codesFor({ 'olan-app.json': manifest(), 'src/app.tsx': 'export default { hello: 1 };' });
    expect(noExport.codes).toEqual(['app.default_export']);
    const undeclared = await codesFor({
      'olan-app.json': manifest({ permissions: [] }),
      'src/app.tsx': OK_APP.replace('defineApp({ app: Home })', "defineApp({ app: Home, 'project.widget': Home })"),
    });
    expect(undeclared.errors).toEqual([]);
    expect(undeclared.warnings.map((item) => item.code)).toContain('app.surface_undeclared');
  });

  it('explains sandbox globals in runtime errors', async () => {
    const { errors } = await codesFor({
      'olan-app.json': manifest({ permissions: [] }),
      'src/app.tsx': `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() {
  const stored = localStorage.getItem('x');
  return <Screen title="X"><Text text={String(stored)} /></Screen>;
}
export default defineApp({ app: Home });
`,
    });
    const runtime = errors.find((item) => item.code === 'runtime.error');
    expect(runtime?.hint).toContain('"localStorage" does not exist in the Olan sandbox');
  });

  it('warns about missing HTTP fixtures when the host is permitted', async () => {
    const { errors, warnings } = await codesFor({
      'olan-app.json': manifest({ permissions: ['http:api.example.com'] }),
      'src/app.tsx': `
import { Screen, Text, defineApp, olan, useQuery } from '@olan-app/sdk';
function Home() {
  const q = useQuery(() => olan.http.fetch('https://api.example.com/x'));
  return <Screen title="X"><Text text={q.error ? 'hata' : 'ok'} /></Screen>;
}
export default defineApp({ app: Home });
`,
    });
    expect(errors).toEqual([]);
    expect(warnings.map((item) => item.code)).toContain('fixtures.http_missing');
  });

  it('checks olan.db and record-write permissions and fixtures/db.json', async () => {
    const data = { version: 1, collections: { notes: { scope: 'organization', fields: { title: { type: 'string', required: true, maxLength: 100, indexed: true } } } } };
    const DB_APP = `
import { Button, List, Screen, defineApp, olan, useCollection } from '@olan-app/sdk';
function Home() {
  const notes = useCollection<{ title: string }>('notes');
  const add = async () => {
    // olan.projects.deleteList(…) in a comment does not count
    await olan.projects.createTask('p0', { title: 'x' });
    await olan.projects.deleteTask('p0', 'p0-t1', { revision: 1 });
  };
  return <Screen title="Notlar"><List items={notes.rows.map((row) => ({ key: row.id, title: row.data.title }))} /><Button label="Ekle" onPress={add} /></Screen>;
}
export default defineApp({ app: Home });
`;
    const missing = await codesFor({ 'olan-app.json': manifest({ sdk: '^1.1.0', permissions: [], data }), 'src/app.tsx': DB_APP });
    const messages = missing.errors.filter((item) => item.code === 'permissions.missing').map((item) => `${item.file}:${item.line ?? ''} ${item.message}`);
    // The marketplace's permission findings; the calls the source scan located keep their file and line.
    expect(messages).toEqual([
      'dist/app.js: olan.db needs the "db" permission, which olan-app.json does not request.',
      'dist/app.js: olan.db.query needs the "db" permission, which olan-app.json does not request.',
      'src/app.tsx:7 olan.projects.createTask needs the "tasks:write" permission, which olan-app.json does not request.',
      'src/app.tsx:8 olan.projects.deleteTask needs the "tasks:delete" permission, which olan-app.json does not request.',
      'olan-app.json: olan-app.json declares "data" (an app database) but not the "db" permission.',
    ]);
    expect(missing.codes).not.toContain('permission.missing');

    const ok = await codesFor({
      'olan-app.json': manifest({ sdk: '^1.1.0', permissions: ['db', 'tasks:write', 'tasks:delete'], data }),
      'src/app.tsx': DB_APP,
      'fixtures/db.json': JSON.stringify({ notes: [{ data: { title: 'Bir' } }] }),
    });
    expect(ok.errors).toEqual([]);
    expect(ok.result.surfaces[0]?.text).toContain('Bir');

    const badFixtures = await codesFor({
      'olan-app.json': manifest({ sdk: '^1.1.0', permissions: ['db', 'tasks:write', 'tasks:delete'], data }),
      'src/app.tsx': DB_APP,
      'fixtures/db.json': JSON.stringify({ notes: [{ data: { title: 7 } }], tasks: [] }),
    });
    expect(badFixtures.codes).toEqual(['fixtures.db_invalid', 'fixtures.db_unknown_collection']);
    expect(badFixtures.result.surfaces).toMatchObject([{ surface: 'app', rendered: true }]);
  });

  it('runs tsc when the project has a tsconfig.json', async () => {
    const project = tempProject('validate-ts', {
      'olan-app.json': manifest({ permissions: [] }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'bundler', target: 'ES2022', lib: ['ES2022', 'WebWorker'], allowImportingTsExtensions: true, isolatedModules: true, skipLibCheck: true, types: [] }, include: ['src'] }),
      'src/app.tsx': OK_APP.replace('<Text text="Merhaba" />', '<Text text={42} />'),
    });
    try {
      const { errors } = await validateApp(project.dir, { strict: false });
      expect(errors).toMatchObject([{ code: 'typescript.TS2322', file: 'src/app.tsx', line: expect.any(Number) }]);
    } finally {
      project.remove();
    }
  });
});
