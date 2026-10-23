import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// The clock is frozen so "overdue" does not depend on the day the tests run.
const NOW = '2026-10-16T09:00:00Z';

test('lists the overdue open tasks of the project, most overdue first', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'site' }, now: NOW });
  app.expectText('Geciken görevler');
  app.expectText('2 görev');
  assert.deepEqual(app.find('List')[0]?.props.items, [
    { key: 's2', title: 'Görseller', subtitle: 'Bitiş: 2026-10-09', meta: '7 gün', badge: { text: 'Gecikti', tone: 'warning' } },
    { key: 's1', title: 'Ana sayfa metni', subtitle: 'Bitiş: 2026-10-14', meta: '2 gün', badge: { text: 'Gecikti', tone: 'warning' } },
  ]);
  app.expectNoText('Alan adı'); // completed
  app.expectNoText('Eski tasarım'); // cancelled
  app.expectNoText('SSS sayfası'); // not due yet
  app.expectNoText('Yazım denetimi'); // no due date
  assert.deepEqual(
    app.calls().map((call) => [call.method, call.params]),
    [['projects.tasks', { projectId: 'site' }]],
  );
  await app.dispose();
});

test('marks tasks more than a week late', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'site' }, now: '2026-10-20T09:00:00Z' });
  app.expectText('Çok gecikti');
  app.expectText('11 gün');
  await app.dispose();
});

test('the graceDays setting hides recently overdue tasks', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'site' }, now: NOW, settings: { graceDays: 3 } });
  app.expectText('1 görev');
  app.expectText('Görseller');
  app.expectNoText('Ana sayfa metni');
  await app.dispose();
});

test('says so when nothing is overdue', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'calm' }, now: NOW });
  app.expectText('Geciken görev yok');
  await app.dispose();
});

test('needs projects:read', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'site' }, now: NOW, permissions: [] });
  assert.equal(app.calls('projects.tasks')[0]?.error?.code, 'permission_denied');
  app.expectText('Görevler yüklenemedi');
  await app.dispose();
});
