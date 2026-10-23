// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonValue } from '@olan-app/schema';

import { runCli } from '../src/cli';
import { startDevServer } from '../src/commands/dev';
import { runTests } from '../src/commands/test';
import { createTestIssuer, renderApp, signRemoteRequest, type TestIssuer } from '../src/testing';
import { createOlanServer, fromNodeRequest, sendNodeResponse, type RemoteRoutes } from '../../app-sdk/src/server/index.ts';
import { manifest, tempProject, type TempProject } from './helpers';

/*
 * Server-test helpers (createTestIssuer, signRemoteRequest), `olan-app requests send`,
 * `olan-app dev --remote live`, and the remote/upload behaviour of renderApp and the test runner.
 */

const APP_ID = 'com.example.test-app';
const routes: RemoteRoutes = {
  'GET /items': (ctx) => ({ body: { items: [{ id: 'i1' }], user: ctx.user as unknown as JsonValue, query: ctx.query, issuer: ctx.issuer } }),
  'POST /items': (ctx) => ({ status: 201, body: { created: ctx.body } }),
  'GET /missing': () => ({ status: 404, body: { error: 'item_not_found' } }),
};

describe('createTestIssuer and signRemoteRequest', () => {
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await createTestIssuer({ webOrigin: 'https://web.olan.test' });
  });
  afterAll(() => issuer.close());

  it('serves the full /.well-known/olan and a JWKS that verifies its signatures', async () => {
    const document = (await (await fetch(`${issuer.issuer}/.well-known/olan`)).json()) as Record<string, unknown> & { apps: Record<string, unknown> };
    expect(document).toMatchObject({ apiVersion: 1, issuer: issuer.issuer, webOrigin: 'https://web.olan.test', catalogUrl: `${issuer.issuer}/api/v2/apps/catalog` });
    expect(document.apps).toMatchObject({
      enabled: true,
      issuer: issuer.issuer,
      jwksUri: `${issuer.issuer}/api/v2/apps/jwks.json`,
      tokenEndpoint: `${issuer.issuer}/api/v2/apps/oauth/token`,
      returnUrlTemplate: 'https://web.olan.test/apps/return/{installationId}',
      appUrlTemplate: 'https://web.olan.test/apps/a/{appId}',
    });
    expect(document.apps.features).toEqual(expect.arrayContaining(['remote-requests', 'files', 'external-return', 'app-links']));
    expect(document).toEqual(issuer.wellKnown());
    const jwks = (await (await fetch(`${issuer.issuer}/api/v2/apps/jwks.json`)).json()) as { keys: { kid: string }[] };
    expect(jwks.keys[0]?.kid).toBe(issuer.keyId);

    const olan = createOlanServer({ appId: APP_ID, issuers: [issuer.issuer] });
    expect(await olan.appReturnUrl({ issuer: issuer.issuer, installationId: 'inst-1' })).toBe('https://web.olan.test/apps/return/inst-1');
  });

  it('signs envelopes handleRequest accepts, without a private key on the app server', async () => {
    const olan = createOlanServer({ appId: APP_ID, issuers: [issuer.issuer] });
    const signed = signRemoteRequest(issuer, { appId: APP_ID, request: { method: 'GET', path: '/items', query: { page: 2, tag: ['a', 'b'], on: true } } });
    expect(signed.envelope).toMatchObject({ issuer: issuer.issuer, installationId: 'mock-installation', appId: APP_ID, request: { method: 'GET', path: '/items', query: { page: '2', tag: ['a', 'b'], on: 'true' }, headers: {}, body: null, timeoutMs: 30000 } });
    expect(signed.headers['webhook-id']).toBe(signed.envelope.id);
    expect(signed.envelope.id).toMatch(/^req_/);
    const response = await olan.handleRequest({ headers: signed.headers, body: signed.body }, routes);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { status: number; body: { user: { id: string; organizationId: string }; issuer: string } };
    expect(answer.status).toBe(200);
    expect(answer.body.user).toEqual({ id: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-0000000000a1', locale: 'tr', timeZone: 'Europe/Istanbul' });
    expect(answer.body.issuer).toBe(issuer.issuer);
    // The same request again is a replay.
    expect((await olan.handleRequest({ headers: signed.headers, body: signed.body }, routes)).status).toBe(409);
  });

  it('forges bad signatures, stale timestamps, unknown keys and issuers, and mismatched ids', async () => {
    const olan = createOlanServer({ appId: APP_ID, issuers: [issuer.issuer] });
    const attempt = async (options: Parameters<typeof signRemoteRequest>[2], user?: null) => {
      const signed = signRemoteRequest(issuer, { appId: APP_ID, ...(user === null ? { user } : {}), request: { method: 'GET', path: '/items' } }, options);
      const response = await olan.handleRequest({ headers: signed.headers, body: signed.body }, routes);
      return { status: response.status, body: (await response.json()) as { error?: string; status?: number; body?: { user: unknown } } };
    };
    expect(await attempt({ badSignature: true })).toMatchObject({ status: 401, body: { error: 'invalid_signature' } });
    expect(await attempt({ timestamp: Math.floor(Date.now() / 1000) - 600 })).toMatchObject({ status: 401, body: { error: 'timestamp_out_of_range' } });
    expect(await attempt({ keyId: 'unknown-kid' })).toMatchObject({ status: 401, body: { error: 'unknown_key' } });
    expect(await attempt({ issuer: 'https://evil.example' })).toMatchObject({ status: 401, body: { error: 'issuer_not_allowed' } });
    expect(await attempt({ webhookId: 'req_other' })).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(await attempt({}, null)).toMatchObject({ status: 200, body: { status: 200, body: { user: null } } });
    expect(() => signRemoteRequest(issuer, { appId: APP_ID, request: { method: 'GET', path: '/items?x=1' } })).toThrow(/signRemoteRequest: invalid_params/);
  });
});

/** A Node app server that accepts any local issuer (the CLI picks a free issuer port in tests). */
async function appServer(): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  const olan = createOlanServer({ appId: APP_ID, issuers: (issuer) => issuer.startsWith('http://127.0.0.1:') });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/olan/requests') return sendNodeResponse(response, await olan.handleRequest(await fromNodeRequest(request), routes));
      if (request.url === '/broken/requests') return sendNodeResponse(response, new Response('nope', { status: 200 }));
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

describe('olan-app requests send and dev --remote live', () => {
  let project: TempProject;
  let server: Awaited<ReturnType<typeof appServer>>;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    server = await appServer();
    project = tempProject('requests-send', {
      'olan-app.json': manifest({ sdk: '^1.5.0', permissions: ['profile:read'], remote: { url: `${server.url}/olan`, jwksUrl: `${server.url}/jwks.json`, requests: true } }),
      'src/app.tsx': `import { Screen, Text, defineApp } from '@olan-app/sdk';\nexport default defineApp({ app: () => <Screen title="R"><Text text="r" /></Screen> });\n`,
    });
    env = { OLAN_APP_DEV_KEY: join(project.dir, 'home', 'dev.key.json') };
  });
  afterAll(async () => {
    await server.close();
    project.remove();
  });

  const run = async (argv: string[]) => {
    let stdout = '';
    const code = await runCli([...argv, '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    return { code, out: JSON.parse(stdout) as { ok: boolean; result?: any; errors?: { code: string; hint?: string }[] } };
  };

  it('signs a request with the development issuer and reports the wrapper and what the app gets', async () => {
    const sent = await run(['requests', 'send', 'GET', '/items?tag=a&tag=b', '--issuer-port', '0', '--role', 'admin']);
    expect(sent.code).toBe(0);
    expect(sent.out.result).toMatchObject({ method: 'GET', path: '/items', httpStatus: 200, answer: { status: 200 }, app: { ok: true } });
    expect(sent.out.result.answer.body.query).toEqual({ tag: ['a', 'b'] });
    // profile:read in the manifest: the envelope carries the profile fields.
    expect(sent.out.result.answer.body.user).toMatchObject({ email: 'utku@example.com', displayName: 'Utku', role: 'admin' });
    expect(sent.out.result.envelope.issuer).toBe(sent.out.result.issuer);

    const posted = await run(['requests', 'send', 'post', '/items', '--body', '{"title":"Yeni"}', '--no-profile', '--issuer-port', '0']);
    expect(posted.out.result).toMatchObject({ answer: { status: 201, body: { created: { title: 'Yeni' } } }, app: { ok: true } });

    const missing = await run(['requests', 'send', 'GET', '/missing', '--issuer-port', '0']);
    expect(missing.code).toBe(0);
    expect(missing.out.result.app).toMatchObject({ ok: false, error: { code: 'remote_rejected', details: { status: 404, body: { error: 'item_not_found' } } } });

    const broken = await run(['requests', 'send', 'GET', '/items', '--to', `${server.url}/broken`, '--issuer-port', '0']);
    expect(broken.code).toBe(1);
    expect(broken.out.errors?.[0]?.code).toBe('requests.delivery_failed');
    expect(broken.out.result.app.error.details.reason).toBe('invalid_response');

    const invalid = await run(['requests', 'send', 'GET', '/items', '--body', '{}', '--issuer-port', '0']);
    expect(invalid.out.errors?.[0]?.code).toBe('remote.request_invalid');
    expect((await run(['requests', 'get', 'GET', '/items'])).out.errors?.[0]?.code).toBe('cli.usage');
    // Git Bash rewrites a leading /items into a Windows path before the CLI sees it.
    const msys = await run(['requests', 'send', 'GET', 'C:/Program Files/Git/items']);
    expect(msys.out.errors?.[0]).toMatchObject({ code: 'cli.invalid_option', hint: expect.stringContaining('MSYS_NO_PATHCONV=1') });
  });

  it('dev --remote live forwards olan.remote.request to remote.url, signed by the development issuer', async () => {
    const dev = await startDevServer({ projectDir: project.dir, port: 0, remote: 'live', issuerPort: 0, env });
    try {
      expect(dev.remoteIssuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const rpc = async (params: unknown) =>
        (await (await fetch(`${dev.url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'remote.request', params }) })).json()) as {
          ok: boolean;
          result?: { status: number; body: { issuer: string } };
          error?: { code: string; details: { status: number } };
        };
      const listed = await rpc({ method: 'GET', path: '/items' });
      expect(listed).toMatchObject({ ok: true, result: { status: 200 } });
      expect(listed.result!.body.issuer).toBe(dev.remoteIssuer);
      expect(await rpc({ method: 'GET', path: '/missing' })).toMatchObject({ ok: false, error: { code: 'remote_rejected', details: { status: 404 } } });
    } finally {
      await dev.close();
    }
  }, 60_000);
});

const UPLOAD_APP = `
import { Button, ProgressBar, Screen, Text, defineApp, olan, useQuery, type UploadTask } from '@olan-app/sdk';
import { useRef, useState } from 'react';
function Home() {
  const items = useQuery(() => olan.remote.request({ method: 'GET', path: '/items' }), []);
  const [state, setState] = useState('');
  const [running, setRunning] = useState(false);
  const task = useRef<UploadTask | null>(null);
  return (
    <Screen title="Yükleme">
      <Text text={items.error ? 'Hata ' + (items.error as { code: string }).code : 'Durum ' + String(items.data?.status ?? '')} />
      <Text text={state} />
      {running ? <ProgressBar label="Yükleniyor" /> : null}
      {running ? <Button label="İptal" onPress={() => void task.current?.cancel()} /> : null}
      <Button label="Yükle" onPress={async () => {
        const [file] = await olan.files.pick();
        setRunning(true);
        task.current = olan.files.upload(file!, { url: 'http://127.0.0.1:4100/olan/uploads/u1' });
        try { await task.current; setState('bitti'); } catch (error) { setState('iptal ' + (error as { code: string }).code); } finally { setRunning(false); }
      }} />
    </Screen>
  );
}
export default defineApp({ app: Home });
`;

describe('renderApp with remote requests and uploads', () => {
  const project = tempProject('render-remote', {
    'olan-app.json': manifest({ sdk: '^1.5.0', permissions: ['files:pick'], remote: { url: 'http://127.0.0.1:4100/olan', jwksUrl: 'http://127.0.0.1:4100/jwks.json', requests: true } }),
    'fixtures/remote.json': JSON.stringify({ 'GET /items': { body: [] } }),
    'src/app.tsx': UPLOAD_APP,
  });
  afterAll(() => project.remove());

  it('keeps the implied remote permission with an explicit list; remote: false takes it away', async () => {
    const listed = await renderApp({ root: project.dir, permissions: ['files:pick'] });
    listed.expectText('Durum 200');
    expect(listed.host.permissions).toContain('remote');
    await listed.dispose();
    const none = await renderApp({ root: project.dir, permissions: [] });
    none.expectText('Durum 200');
    await none.dispose();
    const blocked = await renderApp({ root: project.dir, remote: false });
    blocked.expectText('Hata permission_denied');
    expect(blocked.host.permissions).not.toContain('remote');
    await blocked.dispose();
  });

  it('cancels an upload when the press is not awaited, and names the pending upload when an action cannot settle', async () => {
    const app = await renderApp({ root: project.dir, upload: () => new Promise(() => {}), ui: { files: ['kampanya.jpg'] } });
    const pressing = app.press('Yükle');
    await app.waitFor((view) => view.find('ProgressBar').length > 0);
    await app.press('İptal');
    await pressing;
    app.expectText('iptal cancelled');
    expect(app.host.uploads[0]?.status).toBe('cancelled');
    await app.dispose();

    const stuck = await renderApp({ root: project.dir, upload: () => new Promise(() => {}), ui: { files: ['kampanya.jpg'] }, timeoutMs: 300 });
    await expect(stuck.press('Yükle')).rejects.toThrow(/files\.upload is still pending .*const pressing = app\.press/s);
    await stuck.dispose();
  });
});

describe('olan-app test: a process that crashes after its tests passed', () => {
  it('is reported as a crash, not as a failed test', async () => {
    const project = tempProject('test-crash', {
      'olan-app.json': manifest({ permissions: [] }),
      'src/app.tsx': `import { Screen, defineApp } from '@olan-app/sdk';\nexport default defineApp({ app: () => <Screen title="C" /> });\n`,
      'tests/crash.test.ts': `import { after, test } from 'node:test';\ntest('passes', () => {});\nafter(() => { setTimeout(() => process.reallyExit(5), 10); });\n`,
      'tests/ok.test.ts': `import { test } from 'node:test';\ntest('also passes', () => {});\n`,
      'tests/fails.test.ts': `import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n`,
    });
    try {
      const summary = await runTests(project.dir);
      expect(summary).toMatchObject({ passed: 2, failed: 1 });
      expect(summary.failures.map((failure) => failure.name)).toEqual(['fails']);
      expect(summary.crashes).toEqual([{ file: 'tests/crash.test.ts', exitCode: 5, signal: null, message: expect.stringContaining('crashed after its tests passed') }]);

      let stdout = '';
      project.write('tests/fails.test.ts', `import { test } from 'node:test';\ntest('fixed', () => {});\n`);
      const code = await runCli(['test', '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env: {} });
      expect(code).toBe(0);
      const out = JSON.parse(stdout) as { warnings?: { code: string; file: string }[] };
      expect(out.warnings).toEqual([expect.objectContaining({ code: 'test.process_crashed', file: 'tests/crash.test.ts' })]);
    } finally {
      project.remove();
    }
  }, 60_000);
});
