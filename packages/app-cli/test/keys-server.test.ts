// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { keyFingerprint } from '../src/dev-key';

/*
 * `olan-app keys register|list|revoke` without --marketplace (decision 2026-10-18): the local
 * development key on the signed-in Olan server, with the server and token of `olan-app try`.
 */

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

describe('olan-app keys on the Olan server (decision 2026-10-18)', () => {
  let server: Server;
  let base = '';
  let dir = '';
  let keyFile = '';
  const seen: Seen[] = [];
  const keys: Array<Record<string, unknown>> = [];
  let refuse: { status: number; body: unknown } | null = null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const body = await readJson(request);
        seen.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body });
        const send = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (refuse) return send(refuse.status, refuse.body);
        if (request.url === '/api/v2/apps/developer/keys' && request.method === 'GET') return send(200, { keys });
        if (request.url === '/api/v2/apps/developer/keys' && request.method === 'POST') {
          const { name, publicKey } = body as { name: string; publicKey: string };
          const key = { id: `key-${keys.length + 1}`, name, publicKey, fingerprint: keyFingerprint(publicKey), createdAt: '2026-10-18T10:00:00.000Z', revokedAt: null, revokedBy: null };
          keys.unshift(key);
          return send(201, { key });
        }
        const match = /^\/api\/v2\/apps\/developer\/keys\/([^/]+)$/.exec(request.url!);
        if (match && request.method === 'DELETE') {
          const key = keys.find((entry) => entry.id === decodeURIComponent(match[1]!));
          if (!key) return send(404, { error: 'key_not_found' });
          key.revokedAt = '2026-10-18T11:00:00.000Z';
          return send(200, { key });
        }
        return send(404, { error: 'not_found' });
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'olan-app-keys-'));
    keyFile = join(dir, 'dev.key.json');
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const run = async (argv: string[], env: NodeJS.ProcessEnv = { OLAN_SERVER: base, OLAN_TOKEN: 'secret-token' }) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['keys', ...argv], {
      stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), cwd: dir, env: { OLAN_APP_DEV_KEY: keyFile, ...env },
    });
    return { code, stdout, stderr };
  };

  it('registers the development key (created on first use) with the try server and token', async () => {
    const registered = await run(['register', '--name', 'Laptop', '--json']);
    expect(registered.code, registered.stderr).toBe(0);
    const publicKey = (JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKey: string }).publicKey;
    expect(JSON.parse(registered.stdout)).toMatchObject({ key: { id: 'key-1', name: 'Laptop', publicKey, fingerprint: keyFingerprint(publicKey) } });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/v2/apps/developer/keys', authorization: 'Bearer secret-token', body: { name: 'Laptop', publicKey } });
    // --server / --token override the environment.
    const flagged = await run(['register', '--server', `${base}/`, '--token', 'flag-token', '--name', 'Second'], {});
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.stdout).toContain('Registered key');
    expect(seen.at(-1)).toMatchObject({ authorization: 'Bearer flag-token' });
  });

  it('lists the keys, marks this computer\'s and revokes one by id', async () => {
    const listed = await run(['list']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('key-1');
    expect(listed.stdout).toContain('← this computer');
    const revoked = await run(['revoke', 'key-1', '--json']);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ key: { id: 'key-1', revokedAt: '2026-10-18T11:00:00.000Z' } });
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v2/apps/developer/keys/key-1' });
    expect((await run(['list'])).stdout).toContain('revoked 2026-10-18');
  });

  it('maps refusals to keys.* issues with hints and checks its arguments', async () => {
    refuse = { status: 409, body: { error: 'key_exists', message: 'This key is already registered' } };
    try {
      const exists = await run(['register', '--json']);
      expect(exists.code).toBe(1);
      expect(JSON.parse(exists.stdout).errors[0]).toMatchObject({ code: 'keys.key_exists', hint: expect.stringContaining('keygen --dev --force') });
      refuse = { status: 403, body: { error: 'developer_access_disabled' } };
      expect(JSON.parse((await run(['list', '--json'])).stdout).errors[0]).toMatchObject({ code: 'keys.developer_access_disabled', hint: expect.stringContaining('developer') });
    } finally {
      refuse = null;
    }
    expect(JSON.parse((await run(['revoke', '--json'])).stdout).errors[0].code).toBe('keys.invalid_option');
    expect(JSON.parse((await run(['remove', 'fp', '--json'])).stdout).errors[0].message).toContain('keys revoke');
    expect(JSON.parse((await run(['list', '--developer', 'acme', '--json'])).stdout).errors[0].code).toBe('keys.invalid_option');
    expect(JSON.parse((await run(['list', '--json'], { OLAN_TOKEN: 't' })).stdout).errors[0].code).toBe('keys.server_required');
    expect(JSON.parse((await run(['list', '--json'], { OLAN_SERVER: base })).stdout).errors[0].code).toBe('keys.token_required');
  });
});
