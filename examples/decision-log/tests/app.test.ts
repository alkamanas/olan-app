import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_USER_ID, renderApp } from '@olan-app/cli/testing';

// fixtures/projects.json (UUID ids: `ref:project` fields hold UUIDs) and fixtures/db.json are
// loaded automatically. `app.host.data.db` is the live mock database, `app.host.audit()` the
// deletions and refused deletions as Olan's audit log records them.

const LAUNCH = '7a1d4c2e-1f3b-4e5a-9c6d-0b8e2f4a6c10';
const DEFAULT_LIST = 'c0a80101-0000-4000-8000-000000000001';
const OLD_IDEAS = 'c0a80101-0000-4000-8000-000000000003';
const DONE_DECISION = 'a3c1e5f7-2b4d-4c6e-8a0b-1d3f5a7c9e01';

test('lists decisions newest first, with pins and projects, and filters by status', async () => {
  const app = await renderApp();
  const titles = () => (app.find('List')[0]?.props.items as { title: string; subtitle?: string }[]).map((item) => `${item.title} | ${item.subtitle ?? ''}`);
  assert.deepEqual(titles(), ['Basın bültenini ajans yazsın | Lansman', 'Lansman tarihi 1 Kasım | Sabitlendi · Lansman']);
  app.expectText('Karara bağlandı');

  await app.select('Durum', 'open');
  assert.deepEqual(app.calls('db.query').at(-1)?.params, { collection: 'decisions', where: { status: 'open' }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 10 });
  assert.deepEqual(titles(), ['Basın bültenini ajans yazsın | Lansman']);
  await app.dispose();
});

test('adds a decision (insert, then the list queries it)', async () => {
  const app = await renderApp({ now: '2026-10-17T09:00:00Z' });
  await app.press('Yeni karar');
  await app.fill('Karar', 'Lansman bütçesi 50 bin');
  await app.select('Proje', 'Lansman');
  await app.fill('Karar tarihi', '2026-10-17');
  await app.press('Kaydet');

  assert.equal(app.calls('db.insert')[0]?.ok, true);
  assert.deepEqual(app.toasts().at(-1), { text: 'Karar eklendi', tone: 'success' });
  const row = app.host.data.db.decisions?.find((candidate) => candidate.data.title === 'Lansman bütçesi 50 bin');
  assert.deepEqual(row?.data, { title: 'Lansman bütçesi 50 bin', status: 'open', projectId: LAUNCH, decidedOn: '2026-10-17' });
  assert.equal(row?.createdBy, DEFAULT_USER_ID);
  const first = (app.find('List')[0]?.props.items as { title: string }[])[0];
  assert.equal(first?.title, 'Lansman bütçesi 50 bin');
  await app.dispose();
});

test('turns a decision into a task, deletes that task and then the decision', async () => {
  const app = await renderApp();
  await app.press('Yeni karar');
  await app.fill('Karar', 'Demo videosu çekilsin');
  await app.select('Proje', 'Lansman');
  await app.press('Kaydet');
  await app.press('Demo videosu çekilsin');
  app.expectText('Görev: yok');

  await app.press('Göreve dönüştür');
  const created = app.calls('projects.createTask')[0];
  assert.equal(created?.ok, true);
  const tasks = app.host.data.projects[0]!.tasks;
  const task = tasks.find((candidate) => candidate.title === 'Demo videosu çekilsin');
  // No listId: Olan puts it in the project's default work package and records the app.
  assert.equal(task?.listId, DEFAULT_LIST);
  assert.equal(task?.createdByApp, 'com.visetra.decision-log');
  const row = app.host.data.db.decisions?.find((candidate) => candidate.data.title === 'Demo videosu çekilsin');
  assert.equal(row?.data.taskId, task?.id);
  app.expectText('Görev: Demo videosu çekilsin');
  app.expectText('Görev oluşturuldu: Demo videosu çekilsin');

  await app.press('Görevi sil');
  assert.equal(app.calls('projects.deleteTask')[0]?.ok, true);
  assert.equal(app.host.data.projects[0]!.tasks.some((candidate) => candidate.id === task?.id), false);
  app.expectText('Görev: yok');

  await app.press('Kararı sil');
  assert.equal(app.calls('db.delete')[0]?.ok, true);
  assert.deepEqual(app.toasts().at(-1), { text: 'Karar silindi' });
  app.expectNoText('Demo videosu çekilsin');
  assert.equal(app.host.data.db.decisions?.length, 2);
  assert.deepEqual(app.host.audit(), [
    { action: 'record.delete', detail: { kind: 'task', projectId: LAUNCH, recordId: task!.id, title: 'Demo videosu çekilsin' } },
    { action: 'db.delete', detail: { collection: 'decisions', rowId: row!.id } },
  ]);
  await app.dispose();
});

test('cleaning up removes empty work packages but the default one is protected', async () => {
  const app = await renderApp();
  await app.press('Projeler');
  await app.press('Lansman');
  app.expectText('Varsayılan');

  await app.press('Boş iş paketlerini temizle');
  const calls = app.calls('projects.deleteList');
  // "Tasarım" has a task, so it is not attempted; the default one is, and Olan refuses it.
  assert.deepEqual(calls.map((call) => [(call.params as { listId: string }).listId, call.ok ? 'ok' : call.error?.code]), [
    [DEFAULT_LIST, 'forbidden_record'],
    [OLD_IDEAS, 'ok'],
  ]);
  assert.ok(app.toasts().some((toast) => toast.text === 'Varsayılan iş paketi korunuyor' && toast.tone === 'warning'));
  app.expectText('1 boş iş paketi kaldırıldı · Varsayılan iş paketi korunuyor');
  app.expectNoText('Eski fikirler');
  assert.deepEqual(app.host.audit(), [
    { action: 'record.delete_denied', detail: { kind: 'list', projectId: LAUNCH, recordId: DEFAULT_LIST, reason: 'default_record' } },
    { action: 'record.delete', detail: { kind: 'list', projectId: LAUNCH, recordId: OLD_IDEAS, title: 'Eski fikirler' } },
  ]);
  await app.dispose();
});

test('only the creator deletes a decision, and pins are personal', async () => {
  const other = await renderApp({ userId: 'u3' });
  // The default user's pin is not u3's.
  other.expectNoText('Sabitlendi');
  await other.press('Lansman tarihi 1 Kasım');
  await other.press('Kararı sil');
  assert.equal(other.calls('db.delete')[0]?.error?.code, 'forbidden_record');
  assert.ok(other.toasts().some((toast) => toast.text === 'Bu kayıt korunuyor'));
  assert.ok(other.host.data.db.decisions?.some((row) => row.id === DONE_DECISION));

  // Pinning is per person: u3 pins it, the default user's pins are unchanged.
  await other.press('Sabitle');
  other.expectText('Sabitlendi');
  assert.deepEqual(other.host.data.db.pins?.map((row) => row.createdBy).sort(), [DEFAULT_USER_ID, 'u3'].sort());
  await other.dispose();
});

test('needs its permissions', async () => {
  const noDb = await renderApp({ permissions: ['projects:read'] });
  assert.equal(noDb.calls('db.query')[0]?.error?.code, 'permission_denied');
  noDb.expectText('Kararlar yüklenemedi');
  await noDb.dispose();

  const noDelete = await renderApp({ permissions: ['projects:read', 'db', 'tasks:write'] });
  await noDelete.press('Projeler');
  await noDelete.press('Lansman');
  await noDelete.press('Boş iş paketlerini temizle');
  assert.equal(noDelete.calls('projects.deleteList')[0]?.error?.code, 'permission_denied');
  noDelete.expectText('Bu işlem için izin verilmemiş');
  await noDelete.dispose();
});
