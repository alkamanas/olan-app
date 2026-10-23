import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// fixtures/projects.json is loaded automatically; `fixtures` overrides it per test.

test('lists projects, then a project with status badges', async () => {
  const app = await renderApp();
  app.expectText('Lansman');
  app.expectText('Ürün lansmanı');
  app.expectText('İç araçlar');

  await app.press('Lansman');
  assert.deepEqual(app.navigation(), [{ action: 'push', screen: 'project', params: { projectId: 'launch' } }]);
  app.expectText('Basın bülteni');
  app.expectText('Sürüyor');
  app.expectText('Tamamlandı');
  app.expectText('İptal');
  app.expectText('2 açık');
  app.expectText('1 tamamlandı');
  assert.deepEqual(
    app.find('List')[0]?.props.items,
    [
      { key: 't1', title: 'Basın bülteni', meta: '2026-10-20', badge: { text: 'Sürüyor', tone: 'accent' } },
      { key: 't2', title: 'Web sayfası', meta: '2026-10-12', badge: { text: 'Tamamlandı', tone: 'success' } },
      { key: 't3', title: 'Sosyal medya planı', badge: { text: 'Yapılacak', tone: 'default' } },
      { key: 't4', title: 'Etkinlik salonu', meta: '2026-10-05', badge: { text: 'İptal', tone: 'muted' } },
    ],
  );
  await app.dispose();
});

test('changes a task status from the Menu with projects.updateTask', async () => {
  const app = await renderApp();
  await app.press('Lansman');
  await app.press('Sosyal medya planı');
  app.expectText('Durumu değiştir');
  app.expectText('Yapılacak');

  await app.press('Tamamlandı'); // a Menu item
  const [call] = app.calls('projects.updateTask');
  assert.deepEqual(call?.params, { projectId: 'launch', taskId: 't3', status: 'completed', revision: 1 });
  assert.equal(call?.ok, true);
  assert.deepEqual(app.toasts(), [{ text: 'Durum: Tamamlandı', tone: 'success' }]);
  assert.equal(app.host.data.projects[0]!.tasks[2]!.status, 'completed');
  assert.equal(app.host.data.projects[0]!.tasks[2]!.revision, 2);

  // The screen reloaded: the badge shows the new status and the next change uses revision 2.
  assert.deepEqual(app.find('Badge').map((node) => node.props.text), ['Tamamlandı']);
  await app.press('Sürüyor');
  assert.equal(app.calls('projects.updateTask')[1]?.params && (app.calls('projects.updateTask')[1]!.params as { revision: number }).revision, 2);

  await app.back();
  await app.back();
  app.expectText('İç araçlar');
  await app.dispose();
});

test('the current status cannot be chosen again', async () => {
  const app = await renderApp();
  await app.press('Lansman');
  await app.press('Basın bülteni');
  await assert.rejects(app.press('Sürüyor'), /disabled/);
  await app.dispose();
});

test('without projects:write the change fails with a toast', async () => {
  const app = await renderApp({ permissions: ['projects:read'] });
  await app.press('Lansman');
  await app.press('Web sayfası');
  await app.press('Sürüyor');
  assert.equal(app.calls('projects.updateTask')[0]?.error?.code, 'permission_denied');
  assert.deepEqual(app.toasts(), [{ text: 'Görevleri değiştirme izni yok', tone: 'danger' }]);
  await app.dispose();
});

test('shows an error with a retry without projects:read', async () => {
  const app = await renderApp({ permissions: [] });
  assert.equal(app.calls('projects.list')[0]?.error?.code, 'permission_denied');
  app.expectText('Projeler yüklenemedi');
  app.host.permissions = ['projects:read'];
  await app.press('Tekrar dene');
  app.expectText('Lansman');
  await app.dispose();
});

test('says so when there are no projects', async () => {
  const app = await renderApp({ fixtures: { projects: [] } });
  app.expectText('Henüz proje yok');
  await app.dispose();
});
