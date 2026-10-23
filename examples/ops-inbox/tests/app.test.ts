import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// renderApp runs the real backend (server/index.ts) for olan.backend.call, on the same mock host:
// fixtures/db.json (one task, one push), fixtures/settings.json (both secrets set) and
// fixtures/http.json (the operations API).

const NOW = '2026-10-17T09:00:00.000Z';

test('shows the inbox the backend summarises', async () => {
  const app = await renderApp({ now: NOW });
  app.expectText('1 görev');
  app.expectText('1 push');
  app.expectText('0 özet');
  app.expectText('Sunucu sertifikasını yenile');
  app.expectText('visetra/olan: main dalına 3 commit');
  app.expectText('Operasyon API anahtarı ayarlı');
  const call = app.calls('backend.call')[0];
  assert.deepEqual(call?.params, { name: 'summary', args: null });
  assert.equal(call?.ok, true);
  await app.dispose();
});

test('"Özet oluştur" asks the backend for a digest', async () => {
  const app = await renderApp({ now: NOW });
  await app.press('Özet oluştur');
  await app.waitForText('1 özet');
  assert.deepEqual(app.toasts().at(-1), { text: 'Özet yazıldı: 1 görev, 1 push', tone: 'success' });
  const digest = app.host.data.db.records?.find((row) => row.data.kind === 'digest');
  assert.equal(digest?.data.title, 'Özet: 1 yeni görev, 1 push');
  // The backend posted the digest with the secret token (redacted in the records); the UI never saw it.
  const post = app.calls('http.fetch', { source: 'backend' })[0];
  assert.equal((post?.params as { headers?: Record<string, string> }).headers?.authorization, 'Bearer [secret]');
  assert.ok(app.backendLogs().some((line) => line.message.startsWith('digest written')));
  await app.dispose();
});

test('the UI never receives the secret settings', async () => {
  const app = await renderApp({ now: NOW });
  assert.deepEqual(await app.host.handle('settings.get', {}), { ok: true, result: { apiToken: null, githubSecret: null } });
  const secrets = await app.host.handle('secrets.get', { name: 'apiToken' });
  assert.equal(secrets.ok ? 'ok' : secrets.error.code, 'unknown_method');
  const allCalls = JSON.stringify(app.calls());
  assert.ok(!allCalls.includes('ops-fixture-token') && !allCalls.includes('gh-fixture-secret'));
  await app.dispose();
});

test('says so when the backend is unavailable', async () => {
  const app = await renderApp({ now: NOW, backend: false });
  app.expectText('Backend yanıt vermedi');
  // The Studio preview answers the same way: it has no installation to run the backend for.
  app.expectText(/Backend burada çalışmıyor\. Studio önizlemesinin kurulumu olmadığı için/);
  app.expectText(/uygulamayı kurun ya da olan-app dev kullanın/);
  await app.dispose();
});
