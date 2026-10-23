import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// fixtures/*.json are loaded automatically (projects incl. p-saha, listed first, with its default and an empty
// work package, chat, http, db with two notes). fixtures/versions/ is not mock data: the 1.1.0 manifest.

const ROOT = process.env.OLAN_APP_ROOT ?? process.cwd();
const readManifest = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { version: string; permissions: string[] } & Record<string, unknown>;

/** The 1.0.0 package permissions (the source minus tasks:delete, projects:delete). */
const BASE_PERMISSIONS = ['projects:read', 'tasks:write', 'db', 'storage', 'chat:read', 'http:api.example.com'];

test('home lists every section and shows theme, locale and platform', async () => {
  const app = await renderApp({ platform: 'ios', theme: 'light', locale: 'tr' });
  for (const title of ['Bileşenler', 'Form', 'Etkileşimler', 'Uzun liste', 'Veri', 'Veritabanı']) app.expectText(title);
  app.expectText('Tema: açık · Dil: tr · Platform: ios');
  // The mock host's default user (contract §10.1).
  app.expectText('Kullanıcı: 00000000-0000-4000-8000-000000000001');
  app.expectText('Saha ekibi · Açık tema');
  await app.setContext({ theme: 'dark', locale: 'en-US' });
  app.expectText('Tema: koyu · Dil: en-US · Platform: ios');
  app.expectText('Koyu tema');
  await app.press('Hakkında');
  assert.equal(app.toasts().length, 1);
  await app.dispose();
});

test('home shows the signed-in user id (useUser)', async () => {
  const app = await renderApp({ userId: '7d3c1a52-0b6e-4f39-9a51-2f0c8e6b4d10' });
  app.expectText('Kullanıcı: 7d3c1a52-0b6e-4f39-9a51-2f0c8e6b4d10');
  await app.dispose();
});

test('components screen renders every component and its interactions', async () => {
  const app = await renderApp();
  await app.press('Bileşenler');
  assert.deepEqual(app.navigation()[0], { action: 'push', screen: 'components', params: null });
  const types = new Set(app.tree().map((node) => node.type));
  for (const type of ['Screen', 'Stack', 'Text', 'Card', 'Badge', 'Button', 'Menu', 'List', 'Table', 'Chart', 'EmptyState']) assert.ok(types.has(type), `missing ${type}`);
  assert.deepEqual(
    new Set(app.find('Text').map((node) => node.props.variant).filter(Boolean)),
    new Set(['title', 'heading', 'body', 'caption', 'label']),
  );
  assert.deepEqual(new Set(app.find('Badge').map((node) => node.props.tone ?? 'default')), new Set(['default', 'muted', 'accent', 'danger', 'success', 'warning']));
  assert.deepEqual(new Set(app.find('Chart').map((node) => node.props.kind)), new Set(['bar', 'line']));
  assert.deepEqual(new Set(app.find('Button').map((node) => node.props.variant).filter(Boolean)), new Set(['primary', 'secondary', 'ghost', 'danger']));

  await app.press('Sil');
  app.expectText('Menü seçimi: delete');
  await assert.rejects(app.press('Arşivle (kapalı)'), /disabled/);
  await assert.rejects(app.press('Devre dışı'), /disabled/);
  await app.press('Kadıköy');
  await app.press('Örnek ekle');
  app.expectText('Boş durum eylemi çalıştı');
  await app.press('Yenile');
  await app.press('Kart eylemi');
  assert.deepEqual(app.toasts().map((toast) => toast.text), ['Satır: kadikoy', 'Yenilendi', 'Kart eylemi']);

  await app.press('Kablo kontrolü');
  assert.deepEqual(app.navigation().at(-1), { action: 'push', screen: 'detail', params: { from: 'Bileşenler', key: 'a1' } });
  app.expectText('Seçilen: a1');
  await app.dispose();
});

test('form validates the required title, saves to storage and shows the last submission', async () => {
  const app = await renderApp();
  await app.press('Form');
  app.expectText('Henüz gönderim yok');
  await app.submit('Kaydet');
  app.expectText('Başlık zorunlu');
  assert.equal(app.calls('storage.set').length, 0);

  await app.fill('Başlık', 'Pano kontrolü');
  app.expectNoText('Başlık zorunlu');
  await app.fill('Notlar', 'İkinci kat\nKuzey cephe');
  await app.fill('PIN', '1234');
  await app.select('Öncelik', 'Yüksek');
  await app.fill('Bitiş tarihi', '2026-10-30');
  await app.fill('Hatırlatma', '2026-10-29T08:00:00.000Z');
  await app.submit('Kaydet');
  const saved = app.host.data.storage.lastSubmission as { values: Record<string, string> };
  assert.equal(saved.values.title, 'Pano kontrolü');
  assert.equal(saved.values.priority, 'high');
  assert.equal(saved.values.due, '2026-10-30');
  assert.equal(saved.values.remindAt, '2026-10-29T08:00:00.000Z');
  assert.equal(saved.values.pin, '••••');
  assert.deepEqual(app.toasts(), [{ text: 'Form kaydedildi', tone: 'success' }]);
  app.expectText('Son gönderim');
  app.expectText('Öncelik: Yüksek');

  await app.press('Vazgeç');
  assert.deepEqual(app.navigation().at(-1), { action: 'pop' });
  await app.dispose();
});

test('the last submission is read back from storage', async () => {
  const app = await renderApp({ fixtures: { storage: { lastSubmission: { values: { title: 'Eski kayıt', priority: 'low', due: '', remindAt: '', notes: '' }, at: '2026-10-16T10:00:00.000Z' } } } });
  await app.press('Form');
  app.expectText('Başlık: Eski kayıt');
  app.expectText('Öncelik: Düşük');
  await app.dispose();
});

test('interactions call every olan.ui method and navigation', async () => {
  const app = await renderApp({
    ui: { confirm: true, prompt: 'Beşiktaş', menu: 'remove', datePicker: (params: { mode?: string }) => (params.mode === 'datetime' ? '2026-10-18T10:00:00.000Z' : '2026-10-18') },
  });
  await app.press('Etkileşimler');
  await app.press('Onay iste');
  app.expectText('Onay: true');
  assert.deepEqual(app.calls('ui.confirm')[0]?.params, { title: 'Kayıt silinsin mi?', message: 'Bu işlem geri alınamaz.', confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true });
  await app.press('Metin iste');
  app.expectText('Metin: "Beşiktaş"');
  await app.press('Menü aç');
  app.expectText('Menü: "remove"');
  await app.press('Tarih seç');
  app.expectText('Tarih: "2026-10-18"');
  await app.press('Tarih ve saat seç');
  app.expectText('Tarih-saat: "2026-10-18T10:00:00.000Z"');
  await app.press('Paylaş');
  assert.deepEqual(app.host.shares, [{ text: 'Saha Kiti raporu', url: 'https://olan.app' }]);
  for (const label of ['Bildirim', 'Başarı', 'Uyarı', 'Hata']) await app.press(label);
  assert.deepEqual(app.toasts().map((toast) => toast.tone), [undefined, 'success', 'warning', 'danger']);

  await app.press('Ayrıntıya git');
  assert.deepEqual(app.navigation().at(-1), { action: 'push', screen: 'detail', params: { from: 'Etkileşimler', key: 'nav' } });
  app.expectText('Yığın derinliği: 3');
  await app.press('Geri dön');
  assert.deepEqual(app.navigation().at(-1), { action: 'pop' });
  app.expectText('Etkileşimler');
  await app.dispose();
});

test('dismissed dialogs answer null and false', async () => {
  const app = await renderApp({ ui: { confirm: false } });
  await app.press('Etkileşimler');
  await app.press('Onay iste');
  app.expectText('Onay: false');
  await app.press('Metin iste');
  app.expectText('Metin: boş');
  await app.dispose();
});

test('HTTP dene uses the http:api.example.com permission the manifest asks for', async () => {
  assert.ok(readManifest('olan-app.json').permissions.includes('http:api.example.com'));
  const allowed = await renderApp();
  await allowed.press('Etkileşimler');
  await allowed.press('HTTP dene');
  allowed.expectText('"status":200');
  allowed.expectText('Parçalı bulutlu');
  await allowed.dispose();

  // An administrator who does not grant the host: every request is blocked.
  const blocked = await renderApp({ permissions: BASE_PERMISSIONS.filter((permission) => permission !== 'http:api.example.com') });
  await blocked.press('Etkileşimler');
  await blocked.press('HTTP dene');
  blocked.expectText(/HTTP: hata (http_blocked|permission_denied)/);
  await blocked.dispose();
});

test('re-consent: the 1.1.0 test version adds exactly one permission to 1.0.0', async () => {
  const source = readManifest('olan-app.json');
  const next = readManifest('fixtures/versions/1.1.0/olan-app.json');
  // The fixture is the source manifest apart from the version and the one new permission.
  assert.equal(source.version, '1.0.0');
  assert.equal(next.version, '1.1.0');
  const added = next.permissions.filter((permission) => !source.permissions.includes(permission));
  assert.deepEqual(added, ['users:read']);
  assert.deepEqual(next.permissions.filter((permission) => permission !== 'users:read'), source.permissions);
  assert.deepEqual({ ...next, version: source.version, permissions: source.permissions }, source);

  // The packages leave out the deletions (README). The person consented to the 1.0.0 package;
  // after the update Olan asks only for what is new (`missing`: effective permissions that were
  // neither consented nor declined).
  const DELETES = ['tasks:delete', 'projects:delete'];
  const package100 = source.permissions.filter((permission) => !DELETES.includes(permission));
  const package110 = next.permissions.filter((permission) => !DELETES.includes(permission));
  assert.deepEqual(package100, BASE_PERMISSIONS);
  const consented = package100;
  const missing = package110.filter((permission) => !consented.includes(permission));
  assert.deepEqual(missing, ['users:read']);

  // Until they answer, the app runs with the consented permissions only, and keeps working.
  const app = await renderApp({ permissions: consented });
  assert.equal(app.host.permissions.includes('users:read'), false);
  await app.press('Etkileşimler');
  await app.press('HTTP dene');
  app.expectText('"status":200');
  await app.dispose();
});

test('the long list has 500 rows on its own screen', async () => {
  const app = await renderApp();
  await app.press('Uzun liste');
  const [list] = app.find('List');
  assert.equal((list?.props.items as unknown[]).length, 500);
  await app.press('Satır 450');
  assert.deepEqual(app.navigation().at(-1), { action: 'push', screen: 'detail', params: { from: 'Uzun liste', key: 'row-450' } });
  await app.dispose();
});

test('data screen reads projects, chats and settings, and updates a task', async () => {
  const app = await renderApp({ settings: { teamName: 'Kuzey ekibi' } });
  await app.press('Veri');
  app.expectText('Saha kurulumu');
  app.expectText('Ofis taşınması');
  app.expectText('Ayşe Yılmaz');
  app.expectText('Kuzey ekibi');
  app.expectText('marmara');
  assert.equal(app.calls('settings.get').length >= 1, true);
  assert.equal(app.calls('chat.conversations')[0]?.ok, true);

  await app.press('Saha kurulumu');
  app.expectText('3 açık görev');
  await app.press('Elektrik tesisatı');
  await app.press('Tamamlandı');
  const [update] = app.calls('projects.updateTask');
  assert.deepEqual(update?.params, { projectId: 'p-saha', taskId: 's3', status: 'completed', revision: 1 });
  assert.equal(update?.ok, true);
  app.expectText('Sürüm: 2');

  await app.press('İptal');
  assert.equal(app.calls('ui.confirm').length, 1);
  assert.equal(app.host.data.projects[0]!.tasks[2]!.status, 'cancelled');
  await app.dispose();
});

test('data screen without chat:read shows the error', async () => {
  const app = await renderApp({ permissions: ['projects:read'] });
  await app.press('Veri');
  app.expectText(/Sohbetler yüklenemedi: permission_denied/);
  await app.dispose();
});

test('project.widget shows the open task count, a chart and a menu', async () => {
  const app = await renderApp({ surface: 'project.widget', params: { projectId: 'p-saha' } });
  app.expectText('Saha özeti');
  app.expectText('3 açık görev');
  const [chart] = app.find('Chart');
  assert.deepEqual((chart?.props.series as { points: unknown[] }[])[0]?.points, [
    { x: 'Yapılacak', y: 2 },
    { x: 'Sürüyor', y: 1 },
    { x: 'Tamamlandı', y: 1 },
    { x: 'İptal', y: 1 },
  ]);
  await app.press('Özeti paylaş');
  assert.deepEqual(app.host.shares, [{ text: '3 açık görev' }]);
  await assert.rejects(app.press('Sayacı sıfırla'), /disabled/);
  await app.press('Yenile');
  assert.equal(app.calls('projects.tasks').length, 2);
  await app.dispose();
});

test('Veritabanı lists notes with a count, inserts, marks done and deletes its own note', async () => {
  const app = await renderApp({ ui: { confirm: true } });
  await app.press('Veritabanı');
  app.expectText('Pano etiketlerini yenile');
  app.expectText('Topraklama raporunu yükle');
  app.expectText('2 not');

  await app.submit('Not ekle');
  app.expectText('Not başlığı zorunlu');
  assert.equal(app.calls('db.insert').length, 0);

  await app.fill('Not başlığı', 'Kablo etiketleri');
  await app.submit('Not ekle');
  assert.deepEqual(app.calls('db.insert')[0]?.params, { collection: 'notes', data: { title: 'Kablo etiketleri', done: false } });
  app.expectText('Eklendi: Kablo etiketleri (sürüm 1)');
  app.expectText('3 not');
  assert.equal(app.host.data.db.notes!.length, 3);

  // Newest first: the new note's menu comes first.
  await app.press('Tamamlandı işaretle');
  const [update] = app.calls('db.update');
  assert.equal(update?.ok, true);
  assert.deepEqual((update?.params as { patch: unknown }).patch, { done: true });
  app.expectText('Tamamlandı: Kablo etiketleri (sürüm 2)');

  await app.press('Sil');
  assert.deepEqual(app.calls('ui.confirm').at(-1)?.params, { title: 'Not silinsin mi?', message: 'Kablo etiketleri', confirmLabel: 'Sil', cancelLabel: 'Vazgeç', destructive: true });
  assert.equal(app.calls('db.delete')[0]?.ok, true);
  app.expectText('Silindi: Kablo etiketleri');
  app.expectText('2 not');

  // The next note was created by someone else; rules.delete = owner → forbidden_record, shown and toasted.
  await app.press('Sil');
  app.expectText(/Silme: forbidden_record: /);
  assert.match(app.toasts().at(-1)?.text ?? '', /^forbidden_record: /);
  assert.equal(app.toasts().at(-1)?.tone, 'danger');
  assert.equal(app.host.data.db.notes!.length, 2);
  await app.dispose();
});

test('Veritabanı without the db permission shows permission_denied', async () => {
  const app = await renderApp({ permissions: ['projects:read', 'storage'] });
  await app.press('Veritabanı');
  app.expectText('Notlar yüklenemedi');
  app.expectText(/permission_denied/);
  await app.dispose();
});

test('Kayıtlar creates a task, deletes it, and the default work package is protected', async () => {
  const app = await renderApp({ ui: { confirm: true } });
  await app.press('Veri');
  app.expectText('Oluşturduğum görev: yok');

  await app.press('Görev oluştur');
  const [create] = app.calls('projects.createTask');
  assert.equal(create?.ok, true);
  assert.equal((create?.params as { projectId: string }).projectId, 'p-saha');
  assert.match((create?.params as { title: string }).title, /^Saha Kiti görevi /);
  app.expectText(/Görev oluştur: Saha Kiti görevi .* · oluşturan uygulama com\.olan\.mobile\.acceptance/);
  const created = app.host.data.projects[0]!.tasks.at(-1)!;
  assert.equal(created.createdByApp, 'com.olan.mobile.acceptance');
  assert.equal(created.listId, 'p-saha-l0');
  assert.deepEqual(app.host.data.storage.createdTask, { projectId: 'p-saha', taskId: created.id, title: created.title });
  app.expectText(`Oluşturduğum görev: ${created.title}`);

  await app.press('Oluşturduğum görevi sil');
  assert.deepEqual(app.calls('projects.deleteTask')[0]?.params, { projectId: 'p-saha', taskId: created.id, revision: 1 });
  assert.equal(app.calls('projects.deleteTask')[0]?.ok, true);
  assert.ok(!app.host.data.projects[0]!.tasks.some((task) => task.id === created.id));
  app.expectText(`Oluşturduğum görevi sil: Silindi: ${created.title}`);
  app.expectText('Oluşturduğum görev: yok');

  await app.press('Varsayılan iş paketini sil');
  const [denied] = app.calls('projects.deleteList');
  assert.deepEqual(denied?.params, { projectId: 'p-saha', listId: 'p-saha-l0', revision: 1 });
  assert.equal(denied?.ok, false);
  app.expectText(/Varsayılan iş paketini sil: forbidden_record: /);
  assert.match(app.toasts().at(-1)?.text ?? '', /^forbidden_record: /);
  assert.equal(app.toasts().at(-1)?.tone, 'danger');
  assert.ok(app.host.data.projects[0]!.lists.some((list) => list.id === 'p-saha-l0'));

  await app.press('Boş iş paketini sil');
  assert.equal(app.calls('projects.deleteList')[1]?.ok, true);
  app.expectText('Boş iş paketini sil: Kaldırıldı: Boş iş paketi');
  assert.ok(!app.host.data.projects[0]!.lists.some((list) => list.id === 'p-saha-l1'));
  await app.dispose();
});

test('without tasks:delete and projects:delete (the 1.0.0 and 1.1.0 packages) deletes fail with permission_denied', async () => {
  const app = await renderApp({ ui: { confirm: true }, permissions: BASE_PERMISSIONS });
  await app.press('Veri');
  await app.press('Görev oluştur');
  assert.equal(app.calls('projects.createTask')[0]?.ok, true);
  await app.press('Oluşturduğum görevi sil');
  app.expectText(/Oluşturduğum görevi sil: permission_denied: /);
  assert.deepEqual(app.toasts().at(-1)?.tone, 'danger');
  assert.match(app.toasts().at(-1)?.text ?? '', /^permission_denied: /);
  await app.press('Varsayılan iş paketini sil');
  app.expectText(/Varsayılan iş paketini sil: permission_denied: /);
  await app.dispose();
});

test('Kayıtlar writes to the surface params.projectId when the host passes one', async () => {
  const app = await renderApp({ params: { projectId: 'p-ofis' }, ui: { confirm: true } });
  await app.press('Veri');
  app.expectText('Ofis taşınması projesinde yazma ve silme');
  await app.press('Görev oluştur');
  const [create] = app.calls('projects.createTask');
  assert.equal(create?.ok, true);
  assert.equal((create?.params as { projectId: string }).projectId, 'p-ofis');
  assert.equal(app.host.data.storage.createdTask && (app.host.data.storage.createdTask as { projectId: string }).projectId, 'p-ofis');
  await app.dispose();
});

test('Kayıtlar uses the first listed project and never a fixed id (server ids are UUIDs)', async () => {
  const projectId = '3f1b6c2e-8a4d-4e7f-9b21-5c6d7e8f9a01';
  const app = await renderApp({
    ui: { confirm: true },
    fixtures: { projects: [{ id: projectId, name: 'Gerçek proje', tasks: [] }, { id: '3f1b6c2e-8a4d-4e7f-9b21-5c6d7e8f9a02', name: 'İkinci proje', tasks: [] }] },
  });
  await app.press('Veri');
  app.expectText('Gerçek proje projesinde yazma ve silme');
  await app.press('Görev oluştur');
  const [create] = app.calls('projects.createTask');
  assert.equal(create?.ok, true);
  assert.equal((create?.params as { projectId: string }).projectId, projectId);
  await app.press('Oluşturduğum görevi sil');
  assert.deepEqual((app.calls('projects.deleteTask')[0]?.params as { projectId: string }).projectId, projectId);
  await app.dispose();
});

test('Kayıtlar without any project says so instead of calling createTask', async () => {
  const app = await renderApp({ fixtures: { projects: [] } });
  await app.press('Veri');
  app.expectText('Proje yok');
  await app.press('Görev oluştur');
  app.expectText('Görev oluştur: Proje yok');
  assert.equal(app.calls('projects.createTask').length, 0);
  await app.dispose();
});
