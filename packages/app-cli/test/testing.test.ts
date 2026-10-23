// @vitest-environment node
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { initApp } from '../src/commands/init';
import { runTests } from '../src/commands/test';
import { validateApp } from '../src/commands/validate';
import { renderApp } from '../src/testing';
import { manifest, tempProject } from './helpers';

const APP = `
import { defineApp, Screen, List, Button, Text, Form, TextField, Select, Menu, useQuery, useNavigation, olan } from '@olan-app/sdk';
import { useState } from 'react';

function Projects() {
  const nav = useNavigation();
  const projects = useQuery(() => olan.projects.list({ limit: 10 }));
  if (nav.screen === 'detail') return <Detail id={(nav.params as { id: string }).id} />;
  const items = (projects.data?.items ?? []).map((p) => ({ key: p.id, title: p.name }));
  return (
    <Screen title="Projeler" loading={projects.loading}>
      <List items={items} onSelect={({ key }) => nav.push('detail', { id: String(key) })} emptyText="Proje yok" />
    </Screen>
  );
}

function Detail({ id }: { id: string }) {
  const tasks = useQuery(() => olan.projects.tasks(id), [id]);
  const [saved, setSaved] = useState('');
  return (
    <Screen title="Görevler">
      {(tasks.data ?? []).map((t) => (
        <Menu key={t.id} label={t.title} items={[{ key: 'done', label: 'Tamamla' }]} onSelect={async () => {
          await olan.projects.updateTask(id, t.id, { status: 'completed', revision: t.revision });
          await olan.ui.toast({ text: 'Tamamlandı', tone: 'success' });
        }} />
      ))}
      <Form onSubmit={({ values }) => setSaved(values.note + '/' + values.kind)} submitLabel="Kaydet">
        <TextField name="note" label="Not" />
        <Select name="kind" label="Tür" options={[{ value: 'a', label: 'Birinci' }, { value: 'b', label: 'İkinci' }]} />
      </Form>
      {saved ? <Text text={'Kaydedildi: ' + saved} /> : null}
      <Button label="Geri" onPress={() => olan.navigation.pop()} />
    </Screen>
  );
}

export default defineApp({ app: Projects });
`;

describe('renderApp', () => {
  const project = tempProject('render', { 'olan-app.json': manifest({ permissions: ['projects:read', 'projects:write'] }), 'src/app.tsx': APP });
  afterAll(() => project.remove());

  it('renders with fixtures, navigates, fills forms and records calls', async () => {
    const app = await renderApp({ root: project.dir });
    app.expectText('Web sitesi');
    app.expectText('Mobil uygulama');
    await app.press('Web sitesi');
    app.expectText('Görev 2');
    expect(app.navigation()).toEqual([{ action: 'push', screen: 'detail', params: { id: 'p0' } }]);

    await app.press('Tamamla');
    expect(app.toasts()).toEqual([{ text: 'Tamamlandı', tone: 'success' }]);
    expect(app.calls('projects.updateTask')[0]).toMatchObject({ ok: true, params: { projectId: 'p0', taskId: 'p0-t0', status: 'completed' } });

    await app.fill('Not', 'merhaba');
    await app.select('Tür', 'İkinci');
    await app.press('Kaydet');
    app.expectText('Kaydedildi: merhaba/b');

    await app.press('Geri');
    app.expectText('Ofis taşınması');
    expect(app.tree()[0]?.type).toBe('Screen');
    await app.dispose();
  });

  it('reports missing permissions as failed calls', async () => {
    const app = await renderApp({ root: project.dir, permissions: [] });
    expect(app.calls('projects.list')[0]).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    app.expectText('Proje yok');
    await app.dispose();
  });

  it('sends the signed-in user as context.user (renderApp({ userId }))', async () => {
    const who = tempProject('render-user', {
      'olan-app.json': manifest({ permissions: ['users:read'] }),
      'fixtures/users.json': JSON.stringify([{ id: 'u-2', displayName: 'Ayşe', email: 'ayse@example.com' }]),
      'src/app.tsx': `
import { Screen, Text, defineApp, useUser, useUsers } from '@olan-app/sdk';
function Home() {
  const me = useUser();
  const people = useUsers([me.id]);
  return <Screen title="Kim"><Text text={'Ben: ' + me.id + ' ' + (people.data?.[0]?.displayName ?? '-')} /></Screen>;
}
export default defineApp({ app: Home });
`,
    });
    try {
      const first = await renderApp({ root: who.dir });
      first.expectText('Ben: 00000000-0000-4000-8000-000000000001 Utku');
      await first.dispose();
      const second = await renderApp({ root: who.dir, userId: 'u-2' });
      second.expectText('Ben: u-2 Ayşe');
      expect(second.host.userId).toBe('u-2');
      await second.dispose();
    } finally {
      who.remove();
    }
  });

  it('explains what can be pressed when a label is missing', async () => {
    const app = await renderApp({ root: project.dir });
    await expect(app.press('Yok böyle')).rejects.toThrow(/Pressable: Web sitesi \(List item\)/);
    await app.dispose();
  });
});

describe('data-list template', () => {
  it('passes validate --strict and its own tests against the mock database', async () => {
    const project = tempProject('data-list');
    try {
      initApp({ name: 'Notlar', template: 'data-list', cwd: project.dir, dir: 'app' });
      const dir = join(project.dir, 'app');
      const { errors } = await validateApp(dir, { strict: true, typecheck: false });
      expect(errors).toEqual([]);
      const summary = await runTests(dir);
      expect(summary.failures).toEqual([]);
      expect(summary).toMatchObject({ failed: 0, passed: 4 });
    } finally {
      project.remove();
    }
  });
});

describe('project templates (Phase 6)', () => {
  it.each([
    ['project-tab', 4],
    ['project-records', 5],
  ] as const)('the %s template passes validate --strict and its own tests', async (template, passed) => {
    const project = tempProject(template);
    try {
      initApp({ name: 'Proje uygulaması', template, cwd: project.dir, dir: 'app' });
      const dir = join(project.dir, 'app');
      // Type-checks src/ and tests/ against the workspace SDK (the new olan.project.* calls included).
      const { errors, result } = await validateApp(dir, { strict: true });
      expect(result.checks.find((check) => check.name === 'typescript')).toMatchObject({ ok: true });
      expect(result.checks.find((check) => check.name === 'typescript')?.skipped).toBeUndefined();
      expect(errors).toEqual([]);
      const summary = await runTests(dir);
      expect(summary.failures).toEqual([]);
      expect(summary.crashes).toEqual([]);
      expect(summary).toMatchObject({ failed: 0, passed });
    } finally {
      project.remove();
    }
  }, 120_000);
});

describe('remote template', () => {
  it('passes validate --strict (license notices of the real bundle included) and its UI and server tests', async () => {
    const project = tempProject('remote-template');
    try {
      initApp({ name: 'Dosyalar', template: 'remote', cwd: project.dir, dir: 'app' });
      const dir = join(project.dir, 'app');
      // Type-checks src/, tests/ and app-server/ with the workspace's TypeScript and @types/node.
      const { errors, result } = await validateApp(dir, { strict: true });
      expect(result.checks.find((check) => check.name === 'typescript')).toMatchObject({ ok: true });
      expect(result.checks.find((check) => check.name === 'typescript')?.skipped).toBeUndefined();
      expect(errors).toEqual([]);
      // The bundle has `accept: ['image/*', …]` before esbuild's legalComments: 'eof' block.
      const licenses = (result.review?.findings ?? []).filter((finding) => finding.check === 'licenses').map((finding) => finding.code);
      expect(licenses).toEqual(['licenses.found']);
      const summary = await runTests(dir);
      expect(summary.failures).toEqual([]);
      expect(summary.crashes).toEqual([]);
      expect(summary).toMatchObject({ failed: 0, passed: 8 });
    } finally {
      project.remove();
    }
  }, 120_000);
});
