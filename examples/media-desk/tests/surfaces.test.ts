import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_USER_ID, MOCK_INSTALLATION_ID, remote, renderApp, RequestError, type MockUpload } from '@olan-app/cli/testing';

import { createMediaStore, createRoutes, type MediaStore } from '../remote-server/routes.ts';
import type { MediaItem } from '../src/model.ts';

/*
 * The app against the mock Olan host, with the real route table of `remote-server/routes.ts` as the
 * app server (`renderApp({ remote })`): what the app sends is what the server gets.
 */

const PUBLIC_URL = 'http://127.0.0.1:4419';
const RETURN_URL = `https://olan.test/apps/return/${MOCK_INSTALLATION_ID}`;
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

function item(id: string, patch: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    title: `Medya ${id}`,
    caption: '',
    channels: ['instagram'],
    publishNow: false,
    status: 'ready',
    fileName: `${id}.jpg`,
    type: 'image/jpeg',
    size: 2048,
    mediaUrl: `${PUBLIC_URL}/olan/media/${id}`,
    ownerId: DEFAULT_USER_ID,
    ownerName: 'Utku',
    views: 100,
    spend: 50,
    engagement: 0.02,
    createdAt: '2026-10-15T09:00:00.000Z',
    ...patch,
  };
}

function server(items: MediaItem[] = []) {
  const store = createMediaStore();
  for (const entry of items) store.add(MOCK_INSTALLATION_ID, entry);
  const routes = createRoutes({ store, publicUrl: PUBLIC_URL, returnUrl: () => RETURN_URL });
  return { store, routes };
}

/** The upload target as the real server handles it: one-time token, then `processing`. */
function uploadTarget(store: MediaStore) {
  return (upload: MockUpload) => {
    const url = new URL(upload.url);
    const itemId = url.pathname.split('/').pop()!;
    const found = store.takeUploadToken(itemId, url.searchParams.get('token') ?? '');
    if (!found) return { status: 403, body: { error: 'invalid_upload_token' } };
    const saved = store.saveUpload(found.installationId, itemId, { name: decodeURIComponent(upload.headers['x-olan-file-name']!), type: upload.file.type, bytes: new TextEncoder().encode(upload.file.content) });
    return { status: 201, headers: { etag: '"v1"', location: `${PUBLIC_URL}/olan/media/${itemId}` }, body: { item: saved } as never };
  };
}

const waitFor = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('lists the media of the app server in a sortable table with images and avatars', async () => {
  const { routes } = server([item('m1', { title: 'Ekim kampanyası', views: 5400, spend: 1250.5, engagement: 0.034 }), item('m2', { title: 'Taslak', status: 'awaiting_upload' })]);
  const app = await renderApp({ surface: 'app', remote: remote(routes), profileRole: 'admin' });
  app.expectText('Ekim kampanyası');
  app.expectText('Yükleme bekleniyor');
  const table = app.find('Table')[0]!;
  assert.deepEqual(table.props.defaultSort, { key: 'views', direction: 'desc' });
  const columns = table.props.columns as unknown as { key: string; format?: string; currency?: string; sortable?: boolean }[];
  assert.deepEqual(columns.map((column) => [column.key, column.format ?? null, column.sortable ?? false]), [
    ['title', null, true], ['status', null, false], ['views', 'number', true], ['spend', 'currency', true], ['engagement', 'percent', true],
  ]);
  assert.equal(columns[3]!.currency, 'TRY');
  // Only ready media get a card with the image (src on the remote.url origin).
  const images = app.find('Image');
  assert.deepEqual(images.map((node) => [node.props.src, node.props.alt]), [[`${PUBLIC_URL}/olan/media/m1`, 'Ekim kampanyası']]);
  assert.equal(app.find('Avatar')[0]?.props.name, 'Utku');
  // The tab badge counts what is not ready yet.
  const tabs = app.find('Tabs')[0]!.props.items as unknown as { key: string; badge?: number }[];
  assert.equal(tabs[0]!.badge, 1);

  // profile:read is granted: the signed envelope carries the person's name, email and role.
  const [first] = app.host.remoteRequests;
  assert.equal(first?.envelope.request.method, 'GET');
  assert.equal(first?.envelope.request.path, '/items');
  assert.equal(first?.envelope.user?.displayName, 'Utku');
  assert.equal(first?.envelope.user?.email, 'utku@example.com');
  assert.equal(first?.envelope.user?.role, 'admin');
  assert.equal(first?.answer?.status, 200);
  await app.dispose();
});

test('without profile:read the server gets only the person id', async () => {
  const { routes } = server();
  const app = await renderApp({ surface: 'app', remote: remote(routes), permissions: ['remote', 'files:pick'] });
  app.expectText('Henüz medya yok');
  const user = app.host.remoteRequests[0]!.envelope.user!;
  assert.equal(user.id, DEFAULT_USER_ID);
  assert.equal('email' in user, false);
  assert.equal('displayName' in user, false);
  assert.equal('role' in user, false);
  await app.dispose();
});

test('refreshes quietly every 10 s while something is processing, then stops', async () => {
  const { store, routes } = server([item('m1', { status: 'processing', title: 'Tanıtım videosu' })]);
  const app = await renderApp({ surface: 'app', remote: remote(routes) });
  app.expectText('İşleniyor');
  assert.deepEqual(app.host.timers().map((timer) => timer.intervalMs), [10_000]);
  store.finishProcessing(MOCK_INSTALLATION_ID, 'm1');
  await app.fireTimers();
  app.expectText('Hazır');
  assert.equal(app.calls('remote.request').length, 2);
  assert.equal(app.host.timers().length, 0);
  await app.dispose();
});

test('picks a file, creates the item and uploads it straight to the app server', async () => {
  const { store, routes } = server();
  const app = await renderApp({ surface: 'app', remote: remote(routes), upload: uploadTarget(store), ui: { files: ['kampanya.jpg'] } });
  await app.press('Yükle');
  await app.press('Dosya seç');
  app.expectText('kampanya.jpg (240 KB)');
  assert.deepEqual(app.calls('files.pick')[0]!.params, { accept: ['image/*', 'video/*'], multiple: true, maxFiles: 5, maxBytes: 104857600 });
  await app.fill('Başlık', 'Ekim kampanyası');
  await app.select('Kanallar', ['instagram', 'tiktok']);
  await app.select('Kanallar', 'youtube'); // a string toggles one option
  await app.toggle('Hemen yayınla');
  assert.equal(app.find('TextField')[0]!.props.maxLength, 80);
  assert.equal(app.find('Switch')[0]!.props.value, true);
  await app.press('Yüklemeyi başlat');

  const create = app.host.remoteRequests.find((entry) => entry.envelope.request.method === 'POST')!;
  assert.equal(create.envelope.request.path, '/items');
  assert.deepEqual(create.envelope.request.body, {
    title: 'Ekim kampanyası', caption: '', channels: ['instagram', 'tiktok', 'youtube'], publishNow: true, fileName: 'kampanya.jpg', type: 'image/jpeg', size: 245760,
  });
  assert.equal(create.answer?.status, 201);
  const [upload] = app.host.uploads;
  assert.equal(upload?.method, 'PUT');
  assert.match(upload!.url, /^http:\/\/127\.0\.0\.1:4419\/olan\/uploads\/m_[a-z0-9]+\?token=/);
  assert.equal(upload?.headers['x-olan-file-name'], 'kampanya.jpg');
  assert.equal(upload?.headers['content-type'], 'image/jpeg');
  assert.equal(upload?.status, 'done');
  assert.deepEqual(app.toasts().at(-1), { text: 'Medya yüklendi', tone: 'success' });
  // Back on the Medya tab, the new item is being processed.
  app.expectText('Ekim kampanyası');
  app.expectText('İşleniyor');
  assert.equal(store.items(MOCK_INSTALLATION_ID)[0]?.status, 'processing');
  await app.dispose();
});

test('shows upload progress and cancels the upload, removing the waiting item', async () => {
  const { store, routes } = server();
  let release: (() => void) | undefined;
  const app = await renderApp({
    surface: 'app',
    remote: remote(routes),
    ui: { files: ['tanitim.mp4'] },
    // A slow target: reports half the bytes, then waits (the cancel ends it).
    upload: (upload) => {
      app.host.emit?.({ type: 'upload-progress', uploadId: upload.uploadId, loaded: upload.file.size / 2, total: upload.file.size });
      return new Promise((resolve) => {
        release = () => resolve({ status: 201 });
      });
    },
  });
  await app.press('Yükle');
  await app.press('Dosya seç');
  const started = app.press('Yüklemeyi başlat');
  await waitFor(() => app.text().includes('tanitim.mp4 · %50'), 'the progress bar');
  assert.equal(app.find('ProgressBar')[0]!.props.value, 0.5);
  await app.press('İptal');
  await started;
  assert.equal(app.host.uploads[0]?.status, 'cancelled');
  assert.deepEqual(app.toasts().at(-1), { text: 'Yükleme iptal edildi', tone: 'warning' });
  assert.deepEqual(app.host.remoteRequests.map((entry) => `${entry.envelope.request.method} ${entry.envelope.request.path.replace(/m_[a-z0-9]+/, ':id')}`), ['GET /items', 'POST /items', 'DELETE /items/:id']);
  assert.equal(store.items(MOCK_INSTALLATION_ID).length, 0);
  release?.();
  await app.dispose();
});

test('shows the server\'s validation issues next to the fields', async () => {
  const { routes } = server();
  const app = await renderApp({ surface: 'app', remote: remote(routes), ui: { files: ['kampanya.jpg'] } });
  await app.press('Yükle');
  await app.press('Dosya seç');
  await app.fill('Başlık', ' ');
  await app.select('Kanallar', []);
  await app.press('Yüklemeyi başlat');
  const failed = app.calls('remote.request').at(-1)!;
  assert.equal(failed.error?.code, 'remote_rejected');
  assert.equal((failed.error?.details as { status?: number }).status, 422);
  assert.equal(app.find('TextField')[0]!.props.error, 'Başlık gerekli');
  app.expectText('En az bir kanal seçin');
  assert.equal(app.host.uploads.length, 0);
  await app.dispose();
});

test('an unavailable server shows a banner; "Yeniden dene" recovers', async () => {
  const { routes } = server([item('m1', { title: 'Geri geldi' })]);
  const app = await renderApp({
    surface: 'app',
    remote: remote({ 'GET /items': () => { throw new Error('database down'); } }),
  });
  // A thrown error answers 500 internal_error → remote_unavailable (reason http_status).
  assert.equal(app.calls('remote.request')[0]!.error?.code, 'remote_unavailable');
  app.expectText('Medya yüklenemedi');
  app.expectText('Medya sunucusuna şu anda ulaşılamıyor');
  app.remote(routes);
  await app.press('Yeniden dene');
  app.expectText('Geri geldi');
  await app.dispose();
});

test('the permanent address opens an item; the owner opens and deletes it', async () => {
  const { store, routes } = server([item('m1', { title: 'Ekim kampanyası', views: 5400 })]);
  const app = await renderApp({ surface: 'app', remote: remote(routes), navigation: { screen: 'item', params: { id: 'm1' } } });
  assert.equal(app.find('Screen')[0]!.props.title, 'Ekim kampanyası');
  assert.equal(app.find('Image')[0]!.props.src, `${PUBLIC_URL}/olan/media/m1`);
  assert.equal(app.find('Stat')[0]!.props.value, 5400);
  await app.press('Sunucuda aç');
  assert.deepEqual(app.host.opened, [{ url: `${PUBLIC_URL}/olan/media/m1`, external: false, expectReturn: false }]);
  await app.press('Sil');
  assert.deepEqual(app.toasts().at(-1), { text: 'Silindi', tone: 'success' });
  assert.equal(store.items(MOCK_INSTALLATION_ID).length, 0);
  // Back goes to the first screen (the address put the item over it).
  app.expectText('Henüz medya yok');
  await app.dispose();
});

test('a member cannot delete someone else\'s media (403 from the server); unknown items show a banner', async () => {
  const { routes } = server([item('m1', { ownerId: OTHER_USER, ownerName: 'Ayşe' })]);
  const app = await renderApp({ surface: 'app', remote: remote(routes), navigation: { screen: 'item', params: { id: 'm1' } } });
  await app.press('Sil');
  assert.deepEqual(app.toasts().at(-1), { text: 'Yalnız yükleyen ya da yönetici silebilir', tone: 'danger' });
  await app.dispose();

  const admin = await renderApp({ surface: 'app', remote: remote(routes), profileRole: 'admin', navigation: { screen: 'item', params: { id: 'm1' } } });
  await admin.press('Sil');
  assert.deepEqual(admin.toasts().at(-1), { text: 'Silindi', tone: 'success' });
  await admin.dispose();

  const missing = await renderApp({ surface: 'app', remote: remote(routes), navigation: { screen: 'item', params: { id: 'nope' } } });
  missing.expectText('Medya bulunamadı');
  assert.equal(missing.find('Banner')[0]!.props.tone, 'warning');
  await missing.dispose();
});

test('analytics: Stat formats and a stacked currency area chart', async () => {
  const { routes } = server([item('m1', { views: 1000, spend: 700, engagement: 0.03 })]);
  const app = await renderApp({ surface: 'app', remote: remote(routes) });
  await app.press('Analiz');
  const stats = app.find('Stat').map((node) => [node.props.label, node.props.format ?? 'number', node.props.currency ?? null, node.props.deltaGood ?? 'up']);
  assert.deepEqual(stats, [['Görüntülenme', 'number', null, 'up'], ['Harcama', 'currency', 'TRY', 'down'], ['Etkileşim oranı', 'percent', null, 'up']]);
  const [area, line] = app.find('Chart');
  assert.equal(area!.props.kind, 'area');
  assert.equal(area!.props.stacked, true);
  assert.equal(area!.props.valueFormat, 'currency');
  assert.equal(area!.props.currency, 'TRY');
  assert.equal(line!.props.valueFormat, 'percent');
  await app.dispose();
});

test('connects an account through the system browser and the return address', async () => {
  const { store, routes } = server();
  const app = await renderApp({
    surface: 'app',
    remote: remote(routes),
    // The external page sends the person back to the return address with the server's state.
    ui: {
      openExternal: (params: { url: string }) => {
        const url = new URL(params.url);
        assert.equal(url.searchParams.get('return'), RETURN_URL);
        return { returned: true, params: { state: url.searchParams.get('state')!, connection: 'connected', account: '@medya-masasi' } };
      },
    },
  });
  await app.press('Bağlantı');
  app.expectText('Utku');
  await app.press('Hesap bağla');
  assert.equal(app.host.opened[0]?.external, true);
  assert.equal(app.host.opened[0]?.expectReturn, true);
  assert.match(app.host.opened[0]!.url, /^http:\/\/127\.0\.0\.1:4419\/oauth\/authorize\?state=/);
  app.expectText('@medya-masasi bağlandı');
  app.expectText('Bağlı: @medya-masasi');
  assert.equal(store.connections.get(MOCK_INSTALLATION_ID)?.account, '@medya-masasi');
  await app.dispose();
});

test('connecting without profile:read explains the missing permission (profile_required)', async () => {
  const { store, routes } = server();
  const app = await renderApp({ surface: 'app', remote: remote(routes), permissions: ['remote', 'files:pick'] });
  await app.press('Bağlantı');
  await app.press('Hesap bağla');
  app.expectText(/"Profilinizi görme" izni gerekiyor/);
  assert.equal(app.host.opened.length, 0);
  assert.equal(store.data.pending.size, 0);
  await app.dispose();
});

test('a flow that does not come back leaves nothing connected', async () => {
  const { store, routes } = server();
  const app = await renderApp({ surface: 'app', remote: remote(routes), ui: { openExternal: { returned: false } } });
  await app.press('Bağlantı');
  await app.press('Hesap bağla');
  app.expectText('Bağlantı tamamlanmadı');
  assert.equal(store.connections.size, 0);
  await app.dispose();
});

test('a return without a waiting flow opens the app with params.return and completes it', async () => {
  const { store, routes } = server();
  store.data.pending.set('st-1', { state: 'st-1', installationId: MOCK_INSTALLATION_ID, userId: DEFAULT_USER_ID, returnUrl: RETURN_URL, createdAt: Date.now() });
  const app = await renderApp({ surface: 'app', remote: remote(routes), params: { return: { state: 'st-1', connection: 'connected', account: '@geri-donus' } } });
  app.expectText('@geri-donus bağlandı');
  assert.equal(store.connections.get(MOCK_INSTALLATION_ID)?.account, '@geri-donus');
  // The same state is refused the second time.
  const again = await renderApp({ surface: 'app', remote: remote(routes), params: { return: { state: 'st-1', connection: 'connected' } } });
  again.expectText('Bağlantı isteği geçersiz ya da süresi doldu');
  await app.dispose();
  await again.dispose();
});

test('route errors: RequestError statuses reach the app as remote_rejected', async () => {
  const app = await renderApp({
    surface: 'app',
    remote: remote({ 'GET /items': () => { throw new RequestError(409, { error: 'conflict', message: 'Çakışma' }); } }),
  });
  const failed = app.calls('remote.request')[0]!;
  assert.equal(failed.error?.code, 'remote_rejected');
  assert.deepEqual(failed.error?.details, { status: 409, body: { error: 'conflict', message: 'Çakışma' } });
  app.expectText('Çakışma');
  await app.dispose();
});
