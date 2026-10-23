// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { manifest, tempProject, type TempProject } from './helpers';

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Yayın"><Text text="Merhaba" /></Screen>; }
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

describe('publish --org', () => {
  let server: Server;
  let base = '';
  const uploads: Upload[] = [];
  let answer: { status: number; body: unknown } = { status: 201, body: { app: { id: 'a1' }, version: { id: 'v1', version: '0.1.0' } } };
  let project: TempProject;

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/.well-known/olan') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ apiVersion: 1, apps: { enabled: true }, catalogUrl: `${base}/api/v2/apps/catalog` }));
          return;
        }
        if (request.method === 'POST' && request.url === '/api/v2/apps/catalog/packages') {
          uploads.push({ authorization: request.headers.authorization, contentType: request.headers['content-type'], body: await readAll(request) });
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer.body));
          return;
        }
        response.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    project = tempProject('publish', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
  });
  afterAll(async () => {
    project?.remove();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const publish = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    let stdout = '';
    const code = await runCli(['publish', ...argv, '--json'], { stdout: (text) => void (stdout += text), stderr: () => undefined, cwd: project.dir, env });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    return { code, out: JSON.parse(stdout) as { ok: boolean; result?: any; errors?: { code: string; hint?: string; file?: string }[] } };
  };

  it('packs and uploads the package as multipart with the bearer token', async () => {
    const { code, out } = await publish(['--org', '--server', `${base}/`], { OLAN_TOKEN: 'secret-token' });
    expect(code).toBe(0);
    expect(out.result).toMatchObject({ server: base, endpoint: `${base}/api/v2/apps/catalog/packages`, file: 'com.example.test-app-0.1.0.olanapp', app: { id: 'a1' } });
    const upload = uploads.at(-1)!;
    expect(upload.authorization).toBe('Bearer secret-token');
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = upload.body.toString('latin1');
    expect(text).toContain('name="package"; filename="com.example.test-app-0.1.0.olanapp"');
    expect(text).toContain('PK\u0003\u0004');
  });

  it('maps server errors to publish.* and package issues', async () => {
    answer = { status: 409, body: { error: 'version_exists' } };
    const exists = await publish(['--org', '--server', base, '--token', 't']);
    expect(exists.code).toBe(1);
    expect(exists.out.errors).toMatchObject([{ code: 'publish.version_exists', hint: expect.stringContaining('bump "version"') }]);

    answer = { status: 400, body: { error: 'package_invalid', issues: [{ code: 'package.signature_invalid', path: 'signature.json', message: 'bad signature' }] } };
    const invalid = await publish(['--org', '--server', base, '--token', 't']);
    expect(invalid.out.errors).toEqual([{ code: 'package.signature_invalid', message: 'bad signature', file: 'signature.json' }]);
  });

  it('needs --org, a server and a token', async () => {
    expect((await publish([])).out.errors?.[0]?.code).toBe('publish.target_required');
    expect((await publish(['--org'], { OLAN_TOKEN: 't' })).out.errors?.[0]?.code).toBe('publish.server_required');
    expect((await publish(['--org', '--server', base])).out.errors?.[0]?.code).toBe('publish.token_required');
    expect((await publish(['--org'], { OLAN_SERVER: base })).out.errors?.[0]?.code).toBe('publish.token_required');
  });
});
