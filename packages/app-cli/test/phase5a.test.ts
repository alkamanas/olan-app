// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';

import { validateApp } from '../src/commands/validate';
import { RequestError, remote, renderApp, type MockRemoteHandler } from '../src/testing';
// The server package's own class, from its sources (the mock server above uses its dist bundle).
import { RequestError as ServerRequestError } from '../../app-sdk/src/server/index.ts';
import { manifest, tempProject } from './helpers';

const APP = `
import {
  defineApp, Screen, Stack, Text, Button, Tabs, Switch, MultiSelect, Stat, Banner, Image, Avatar, ProgressBar,
  useQuery, useNavigation, olan, isRemoteError, type FileHandle,
} from '@olan-app/sdk';
import { useState } from 'react';

function Content() {
  const nav = useNavigation();
  const [tab, setTab] = useState<string | number>('posts');
  const [on, setOn] = useState(true);
  const [channels, setChannels] = useState<string[]>(['ig']);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [bannerOpen, setBannerOpen] = useState(true);
  const brands = useQuery(() => olan.remote.request({ method: 'GET', path: '/brands', query: { page: 1 } }), [], { refetchIntervalMs: 10_000 });
  if (nav.screen === 'composer') return <Screen title="Oluştur"><Text text={'Marka ' + String((nav.params as { brand?: string }).brand)} /></Screen>;
  const names = (brands.data?.body as { name: string }[] | undefined)?.map((brand) => brand.name).join(', ') ?? '';
  return (
    <Screen title="İçerik">
      <Tabs items={[{ key: 'posts', label: 'Gönderiler' }, { key: 'ads', label: 'Reklamlar' }]} value={tab} onChange={({ key }) => setTab(key)} />
      <Text text={'Sekme ' + String(tab)} />
      <Text text={'Markalar: ' + names} />
      {brands.error ? <Text text={'Hata ' + (isRemoteError(brands.error) ? brands.error.code + ' ' + brands.error.status : 'other')} /> : null}
      <Switch label="Kanal açık" value={on} onChange={({ value }) => setOn(value)} />
      <Text text={on ? 'Açık' : 'Kapalı'} />
      <MultiSelect label="Kanallar" value={channels} options={[{ value: 'ig', label: 'Instagram' }, { value: 'tt', label: 'TikTok' }]} onChange={({ value }) => setChannels(value)} />
      <Text text={'Seçili ' + channels.join('+')} />
      <Stat label="Harcama" value={1250} format="currency" currency="TRY" delta={-0.1} deltaGood="down" caption="Son 30 gün" />
      {bannerOpen ? <Banner tone="warning" text="Bağlantının süresi doldu" onDismiss={() => setBannerOpen(false)} action={{ label: 'Yeniden bağla', onPress: async () => {
        const result = await olan.ui.openExternal('https://markanera.com/connect', { expectReturn: true });
        setStatus(result.returned ? 'döndü ' + result.params.marketing : 'dönmedi');
      } }} /> : null}
      <Image src="https://markanera.com/m/1.jpg" alt="Görsel" aspectRatio={1} />
      <Avatar name="Markanera" />
      {progress !== undefined ? <ProgressBar value={progress} label="Yükleniyor" /> : null}
      <Button label="Yükle" onPress={async () => {
        const files: FileHandle[] = await olan.files.pick({ accept: ['image/*'], multiple: true });
        for (const file of files) {
          const result = await olan.files.upload(file, { url: 'https://markanera.com/api/v1/uploads/t1', onProgress: ({ loaded, total }) => setProgress(loaded / total) });
          setStatus('yüklendi ' + file.name + ' ' + result.status);
        }
      }} />
      <Button label="Gönder" onPress={async () => {
        try {
          const created = await olan.remote.request({ method: 'POST', path: '/brands/b1/posts', body: { text: 'Merhaba' }, timeoutMs: 60_000 });
          setStatus('oluşturuldu ' + created.status);
        } catch (error) {
          setStatus(isRemoteError(error) ? 'reddedildi ' + error.status + ' ' + JSON.stringify(error.details) : 'hata');
        }
      }} />
      <Button label="Markanera'da aç" onPress={() => olan.ui.openUrl('https://markanera.com')} />
      <Text text={'Durum ' + status} />
    </Screen>
  );
}

export default defineApp({ app: Content });
`;

const MANIFEST = manifest({
  id: 'com.markanera.content',
  sdk: '^1.5.0',
  permissions: ['profile:read', 'files:pick'],
  remote: { url: 'https://markanera.com/olan', jwksUrl: 'https://markanera.com/olan/jwks.json', requests: true },
});

const ROUTES: MockRemoteHandler = {
  'GET /brands': (context) => ({ body: [{ name: 'Olan' }, { name: context.user?.displayName ?? 'anon' }] }),
  'POST /brands/:brandId/posts': (context) => {
    if (!context.body || typeof context.body !== 'object') throw new RequestError(422, { issues: ['text'] });
    return { status: 201, body: { brand: context.params.brandId } };
  },
};

describe('Phase 5a in renderApp', () => {
  const project = tempProject('phase5a', { 'olan-app.json': MANIFEST, 'src/app.tsx': APP });
  afterAll(() => project.remove());

  it('routes remote.request to the test server with the profile fields', async () => {
    const app = await renderApp({ root: project.dir, remote: remote(ROUTES), profileRole: 'admin' });
    app.expectText('Markalar: Olan, Utku');
    const [request] = app.host.remoteRequests;
    expect(request!.envelope).toMatchObject({
      appId: 'com.markanera.content',
      user: { id: app.host.userId, email: 'utku@example.com', displayName: 'Utku', role: 'admin', locale: 'tr', timeZone: 'Europe/Istanbul' },
      request: { method: 'GET', path: '/brands', query: { page: '1' }, timeoutMs: 30_000 },
      token: { expiresIn: 300 },
    });
    expect(request!.envelope.id.startsWith('req_')).toBe(true);
    await app.press('Gönder');
    app.expectText('Durum oluşturuldu 201');
    // A 4xx reaches the app as RemoteError remote_rejected with the body.
    app.remote({ 'POST /brands/:brandId/posts': () => { throw new RequestError(409, { error: 'conflict' }); } });
    await app.press('Gönder');
    app.expectText('Durum reddedildi 409 {"error":"conflict"}');
    await app.dispose();
  });

  it('answers a RequestError from another copy of @olan-app/sdk/server with its status', async () => {
    // An app's tests import the server package, while olan-app runs its own bundled copy: the
    // classes differ, so the mock server must not rely on instanceof.
    expect(ServerRequestError).not.toBe(RequestError);
    const app = await renderApp({ root: project.dir, remote: { ...ROUTES, 'POST /brands/:brandId/posts': () => { throw new ServerRequestError(422, { error: 'invalid_post' }); } } });
    await app.press('Gönder');
    app.expectText('Durum reddedildi 422 {"error":"invalid_post"}');
    await app.dispose();
  });

  it('leaves out profile fields without profile:read and reports a missing server', async () => {
    const app = await renderApp({ root: project.dir, permissions: ['remote', 'files:pick'], remote: ROUTES });
    expect(app.host.remoteRequests[0]!.envelope.user).not.toHaveProperty('email');
    app.expectText('Markalar: Olan, anon');
    await app.dispose();
    const offline = await renderApp({ root: project.dir });
    offline.expectText('Hata remote_unavailable 0');
    expect(offline.calls('remote.request')[0]!.error).toMatchObject({ code: 'remote_unavailable', details: { status: 0, reason: 'network' } });
    await offline.dispose();
  });

  it('serves fixtures/remote.json', async () => {
    const withFixtures = tempProject('phase5a-fixtures', { 'olan-app.json': MANIFEST, 'src/app.tsx': APP, 'fixtures/remote.json': JSON.stringify({ 'GET /brands': { body: [{ name: 'Fixture' }] } }) });
    try {
      const app = await renderApp({ root: withFixtures.dir });
      app.expectText('Markalar: Fixture');
      await app.dispose();
    } finally {
      withFixtures.remove();
    }
  });

  it('drives the new components', async () => {
    const app = await renderApp({ root: project.dir, remote: ROUTES });
    await app.press('Reklamlar');
    app.expectText('Sekme ads');
    await app.toggle('Kanal açık');
    app.expectText('Kapalı');
    await app.select('Kanallar', 'tt');
    app.expectText('Seçili ig+tt');
    await app.select('Kanallar', ['tt']);
    app.expectText('Seçili tt');
    app.expectText('Harcama');
    app.expectText('Son 30 gün');
    expect(app.find('Image')[0]!.props).toMatchObject({ alt: 'Görsel', aspectRatio: 1 });
    await expect(app.dismiss('Başka uyarı')).rejects.toThrow(/no Banner with that title or text/);
    await app.dismiss('bağlantının süresi doldu');
    app.expectNoText('Bağlantının süresi doldu');
    await expect(app.dismiss()).rejects.toThrow(/no Banner on screen/);
    await app.dispose();
  });

  it('picks and uploads files with progress, and opens external flows', async () => {
    const app = await renderApp({ root: project.dir, remote: ROUTES, upload: () => ({ status: 201, headers: { ETag: '"u1"', 'X-Other': 'x' }, body: { id: 'm1' } }), ui: { openExternal: { returned: true, params: { marketing: 'connected', state: 's1' } } } });
    await app.press('Yükle');
    app.expectText('Durum yüklendi kampanya.jpg 201');
    expect(app.host.uploads).toHaveLength(1);
    expect(app.host.uploads[0]).toMatchObject({ method: 'PUT', url: 'https://markanera.com/api/v1/uploads/t1', status: 'done', headers: { 'content-type': 'image/jpeg', 'x-olan-file-name': 'kampanya.jpg' } });
    expect(app.calls('files.upload')[0]!.result).toEqual({ status: 201, headers: { etag: '"u1"' }, body: { id: 'm1' } });
    expect(app.find('ProgressBar')[0]!.props.value).toBe(1);
    await app.press('Yeniden bağla');
    app.expectText('Durum döndü connected');
    await app.press("Markanera'da aç");
    expect(app.host.opened).toEqual([
      { url: 'https://markanera.com/connect', external: true, expectReturn: true },
      { url: 'https://markanera.com', external: false, expectReturn: false },
    ]);
    await app.dispose();
  });

  it('blocks uploads to other origins', async () => {
    const app = await renderApp({ root: project.dir, remote: ROUTES });
    const picked = await app.host.handle('files.pick', {});
    const fileId = (picked as { ok: true; result: { id: string }[] }).result[0]!.id;
    const outcome = await app.host.handle('files.upload', { uploadId: 'upl_x', fileId, url: 'https://evil.example/u' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'http_blocked' } });
    await app.dispose();
  });

  it('refetches on host timer ticks and opens on an app-address screen', async () => {
    let calls = 0;
    const app = await renderApp({ root: project.dir, remote: { 'GET /brands': () => ({ body: [{ name: `v${++calls}` }] }) } });
    app.expectText('Markalar: v1');
    expect(app.host.timers()).toEqual([{ timerId: expect.stringMatching(/^tmr_/), intervalMs: 10_000 }]);
    await app.fireTimers();
    app.expectText('Markalar: v2');
    await app.dispose();
    const deep = await renderApp({ root: project.dir, remote: ROUTES, navigation: { screen: 'composer', params: { brand: 'b1' } } });
    deep.expectText('Marka b1');
    await deep.back();
    deep.expectText('Markalar:');
    await deep.dispose();
  });

  it('passes validate --strict', async () => {
    const result = await validateApp(project.dir, { strict: true });
    const codes = [...result.errors, ...result.warnings].map((item) => item.code);
    expect(result.errors).toEqual([]);
    expect(codes).toContain('fixtures.remote_missing');
  });

  it('reports remote.request without remote.requests', async () => {
    const noRequests = tempProject('phase5a-norequests', {
      'olan-app.json': manifest({ sdk: '^1.5.0', permissions: ['files:pick'], remote: { url: 'https://markanera.com/olan', jwksUrl: 'https://markanera.com/olan/jwks.json' } }),
      'src/app.tsx': APP,
    });
    try {
      const result = await validateApp(noRequests.dir, { strict: true });
      expect(result.errors.filter((item) => item.code === 'permission.missing').map((item) => item.message).join('\n')).toMatch(/remote\.request/);
    } finally {
      noRequests.remove();
    }
  });
});
