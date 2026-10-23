// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { verifyPackageSignature } from '../src/commands/pack';
import { manifest, tempProject, type TempProject } from './helpers';

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Dene"><Text text="Merhaba" /></Screen>; }
export default defineApp({ app: Home });
`;

interface Upload {
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

async function readAll(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The `package` part of a multipart body. */
function packagePart(upload: Upload): { filename: string; bytes: Buffer } {
  const boundary = /boundary=(.+)$/.exec(upload.contentType ?? '')![1]!;
  const parts = upload.body.toString('latin1').split(`--${boundary}`);
  const part = parts.find((item) => item.includes('name="package"'))!;
  const [head, ...rest] = part.split('\r\n\r\n');
  const content = rest.join('\r\n\r\n').replace(/\r\n$/, '');
  return { filename: /filename="([^"]+)"/.exec(head!)![1]!, bytes: Buffer.from(content, 'latin1') };
}

describe('olan-app try (Decision 7)', () => {
  let server: Server;
  let base = '';
  const uploads: Upload[] = [];
  let wellKnown: Record<string, unknown> = {};
  let answer: { status: number; body: unknown } = { status: 201, body: {} };
  /** Answers used once each, before `answer`. */
  const queued: { status: number; body: unknown }[] = [];
  let project: TempProject;
  let keyFile = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/.well-known/olan') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(wellKnown));
          return;
        }
        if (request.method === 'POST' && request.url === '/api/v2/apps/developer/try') {
          uploads.push({ authorization: request.headers.authorization, contentType: request.headers['content-type'], body: await readAll(request) });
          const next = queued.shift() ?? answer;
          response.writeHead(next.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(next.body));
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    project = tempProject('try', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    keyFile = join(project.dir, '.keys', 'dev.key.json');
  });
  afterAll(async () => {
    project?.remove();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    let stdout = '';
    const code = await runCli(['try', ...argv, '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env: { OLAN_APP_DEV_KEY: keyFile, ...env } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    return { code, out: JSON.parse(stdout) as { ok: boolean; result?: any; errors?: { code: string; message: string; hint?: string }[] } };
  };

  it('packs, dev-signs and uploads with the publish --org server and token, then prints the app address', async () => {
    wellKnown = { apiVersion: 1, apps: { enabled: true }, webOrigin: 'http://localhost:3000/' };
    answer = { status: 201, body: { installationId: 'inst-9', appId: 'com.example.test-app', version: '0.1.0' } };
    const { code, out } = await run(['--server', `${base}/`], { OLAN_TOKEN: 'secret-token' });
    expect(code).toBe(0);
    expect(out.result).toMatchObject({
      server: base,
      endpoint: `${base}/api/v2/apps/developer/try`,
      file: 'com.example.test-app-0.1.0.olanapp',
      installationId: 'inst-9',
      appId: 'com.example.test-app',
      version: '0.1.0',
      appUrl: 'http://localhost:3000/apps/inst-9',
    });
    const upload = uploads.at(-1)!;
    expect(upload.authorization).toBe('Bearer secret-token');
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const part = packagePart(upload);
    expect(part.filename).toBe('com.example.test-app-0.1.0.olanapp');
    // The uploaded package is signed with the development key.
    const files = unzipSync(new Uint8Array(part.bytes));
    const digest = JSON.parse(strFromU8(files['digest.json']!)) as { package: string };
    const signature = JSON.parse(strFromU8(files['signature.json']!)) as { algorithm: 'ed25519'; publicKey: string; signature: string; signedAt: string };
    expect(verifyPackageSignature(digest.package, signature)).toBe(true);
    expect(signature.publicKey).toBe((JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKey: string }).publicKey);
    expect(out.result.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads OLAN_SERVER / OLAN_TOKEN and has no app address without webOrigin', async () => {
    wellKnown = { apiVersion: 1, apps: { enabled: true } };
    answer = { status: 200, body: { installationId: 'inst-10', appId: 'com.example.test-app', version: '0.1.0' } };
    const { code, out } = await run([], { OLAN_SERVER: base, OLAN_TOKEN: 't' });
    expect(code).toBe(0);
    expect(out.result).toMatchObject({ installationId: 'inst-10', appUrl: null });
  });

  it('re-packs and re-signs under the server-named -dev.N on 409 version_exists and retries once', async () => {
    wellKnown = { apiVersion: 1, apps: { enabled: true } };
    const before = uploads.length;
    const onDisk = readFileSync(join(project.dir, 'olan-app.json'), 'utf8');
    queued.push({ status: 409, body: { error: 'version_exists', appId: 'com.example.test-app', version: '0.1.0', nextVersion: '0.1.0-dev.2' } });
    answer = { status: 200, body: { installationId: 'inst-11', appId: 'com.example.test-app', version: '0.1.0-dev.2' } };
    const { code, out } = await run(['--server', base, '--token', 't']);
    expect(code).toBe(0);
    expect(out.result).toMatchObject({ installationId: 'inst-11', version: '0.1.0-dev.2', file: 'com.example.test-app-0.1.0-dev.2.olanapp' });
    expect(uploads.length - before).toBe(2);
    const part = packagePart(uploads.at(-1)!);
    expect(part.filename).toBe('com.example.test-app-0.1.0-dev.2.olanapp');
    const files = unzipSync(new Uint8Array(part.bytes));
    expect((JSON.parse(strFromU8(files['olan-app.json']!)) as { version: string }).version).toBe('0.1.0-dev.2');
    const digest = JSON.parse(strFromU8(files['digest.json']!)) as { package: string };
    expect(verifyPackageSignature(digest.package, JSON.parse(strFromU8(files['signature.json']!)) as { algorithm: 'ed25519'; publicKey: string; signature: string; signedAt: string })).toBe(true);
    // The project's own manifest keeps its version.
    expect(readFileSync(join(project.dir, 'olan-app.json'), 'utf8')).toBe(onDisk);

    // Only once: a second conflict (or an older server without nextVersion) is reported with the hint.
    queued.push({ status: 409, body: { error: 'version_exists', nextVersion: '0.1.0-dev.3' } });
    answer = { status: 409, body: { error: 'version_exists', nextVersion: '0.1.0-dev.4' } };
    const twice = await run(['--server', base, '--token', 't']);
    expect(twice.code).toBe(1);
    expect(twice.out.errors?.[0]).toMatchObject({ code: 'try.version_exists', hint: expect.stringContaining('bump "version"') });
  });

  it('maps server refusals to try.* with hints', async () => {
    wellKnown = { apiVersion: 1, apps: { enabled: true } };
    answer = { status: 403, body: { error: 'developer_required', message: 'Developer access is off' } };
    const denied = await run(['--server', base, '--token', 't']);
    expect(denied.code).toBe(1);
    expect(denied.out.errors).toMatchObject([{ code: 'try.developer_required', message: expect.stringContaining('Developer access is off'), hint: expect.stringContaining('developer') }]);
    answer = { status: 400, body: { error: 'package_invalid', issues: [{ code: 'package.signature_invalid', path: 'signature.json', message: 'bad signature' }] } };
    expect((await run(['--server', base, '--token', 't'])).out.errors).toEqual([{ code: 'package.signature_invalid', message: 'bad signature', file: 'signature.json' }]);
    answer = { status: 200, body: { ok: true } };
    expect((await run(['--server', base, '--token', 't'])).out.errors?.[0]?.code).toBe('try.invalid_response');
    wellKnown = { apiVersion: 1, apps: { enabled: false } };
    expect((await run(['--server', base, '--token', 't'])).out.errors?.[0]?.code).toBe('try.apps_disabled');
  });

  it('needs a server and a token', async () => {
    expect((await run([], { OLAN_TOKEN: 't' })).out.errors?.[0]?.code).toBe('try.server_required');
    expect((await run(['--server', base])).out.errors?.[0]?.code).toBe('try.token_required');
  });
});
