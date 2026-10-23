// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { DEFAULT_MARKETPLACE_URL, resolveMarketplaceUrl } from '../src/marketplace';
import { manifest, tempProject, type TempProject } from './helpers';

/*
 * `olan-app login|publish|status --marketplace` against an in-process fake Olan server (identity
 * token, contract §15) and a fake marketplace (developer API, contract §22). The real marketplace
 * is exercised in marketplace.pg.test.ts.
 */

const APP = `
import { Screen, Text, defineApp } from '@olan-app/sdk';
function Home() { return <Screen title="Pazar"><Text text="Merhaba" /></Screen>; }
export default defineApp({ app: Home });
`;

const OLAN_TOKEN = 'olan-access-token-not-for-output';
const SESSION_TOKEN = 'olan_dev_SECRET-session-token-never-printed';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL29sYW4udGVzdCJ9.c2lnbmF0dXJl';

type State = 'checking' | 'checks_failed' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  contentType?: string;
  body: Buffer;
}

function submission(appId: string, version: string, state: State, extra: Record<string, unknown> = {}) {
  const nextAction = { checking: 'wait', in_review: 'wait', checks_failed: 'fix_and_resubmit', rejected: 'fix_and_resubmit', approved: 'release', withdrawn: 'resubmit' }[state];
  return { id: `sub-${version}`, appId, version, state, reviewLevel: 'light', checks: null, rejection: null, release: null, testReport: null, notes: [], nextAction, submittedAt: '2026-10-18T10:00:00.000Z', decidedAt: null, ...extra };
}

const FAILED_FINDING = { check: 'permissions', code: 'permissions.unused', severity: 'error', message: 'storage is declared but never used', path: 'olan-app.json#/permissions/1', rule: '2.1', hint: 'Remove it from permissions.' };

async function readAll(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('marketplace commands (fake marketplace)', () => {
  let olan: Server;
  let market: Server;
  let olanUrl = '';
  let marketUrl = '';
  let project: TempProject;
  let home: TempProject;
  let packageFile = '';
  const requests: Recorded[] = [];
  /** Apps the fake knows, with their versions (newest first). */
  const apps = new Map<string, string[]>();
  /** States the status route answers, one per call (the last one repeats). */
  let statusStates: State[] = [];
  let uploadState: State = 'checking';
  let uploadError: { status: number; body: unknown } | null = null;
  let developers = [{ slug: 'acme', role: 'owner' }];
  /** PKCE challenge of the last browser sign-in (fake /oauth/authorize). */
  let oauthChallenge = '';
  /** Everything the CLI printed in this file: the session token must never appear. */
  let allOutput = '';

  beforeAll(async () => {
    olan = createServer((request, response) => {
      void (async () => {
        const body = await readAll(request);
        const url = new URL(request.url ?? '/', olanUrl);
        // `/.well-known/olan` names the marketplace this server uses (the default for --marketplace).
        if (url.pathname === '/.well-known/olan') return send(response, 200, { apiVersion: 1, marketplaceUrl: marketUrl });
        // Browser sign-in: OpenID configuration, authorize (redirects to the CLI's loopback) and token.
        if (url.pathname === '/.well-known/openid-configuration') {
          return send(response, 200, { issuer: olanUrl, authorization_endpoint: `${olanUrl}/oauth/authorize`, token_endpoint: `${olanUrl}/oauth/token`, code_challenge_methods_supported: ['S256'] });
        }
        if (url.pathname === '/oauth/authorize') {
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          if (url.searchParams.get('client_id') !== 'olan-app-cli' || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) return send(response, 400, { error: 'invalid_client' });
          oauthChallenge = url.searchParams.get('code_challenge') ?? '';
          const callback = new URL(redirectUri);
          callback.searchParams.set('code', 'browser-code');
          callback.searchParams.set('state', url.searchParams.get('state') ?? '');
          response.writeHead(302, { location: callback.toString() });
          return response.end();
        }
        if (url.pathname === '/oauth/token' && request.method === 'POST') {
          const form = new URLSearchParams(body.toString('utf8'));
          const verified = form.get('code') === 'browser-code' && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === oauthChallenge;
          return verified ? send(response, 200, { access_token: OLAN_TOKEN, token_type: 'Bearer' }) : send(response, 400, { error: 'invalid_grant' });
        }
        if (request.method === 'POST' && request.url === '/api/v2/apps/marketplace/identity-token') {
          if (request.headers.authorization !== `Bearer ${OLAN_TOKEN}`) return send(response, 401, { error: 'unauthorized', message: 'Sign in' });
          return send(response, 200, { idToken: ID_TOKEN, expiresIn: 300, serverId: '7d1b6b0e-6a43-4c1c-9d55-1f0a3f6f7c11' });
        }
        send(response, 404, { error: 'not_found' });
      })();
    });
    market = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://fake');
        const body = await readAll(request);
        requests.push({ method: request.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization, contentType: request.headers['content-type'], body });
        if (request.method === 'POST' && url.pathname === '/api/v1/auth/session') {
          const input = JSON.parse(body.toString('utf8')) as { idToken?: string; client?: string };
          if (input.idToken !== ID_TOKEN || input.client !== 'cli') return send(response, 401, { error: 'identity_invalid', message: 'bad token' });
          return send(response, 201, { token: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', user: { userRef: 'https://olan.test#u1', email: 'ayse@example.com', name: 'Ayşe', organizationId: 'org-1' }, developers });
        }
        if (request.headers.authorization !== `Bearer ${SESSION_TOKEN}`) return send(response, 401, { error: 'developer_sign_in_required', message: 'Sign in with your Olan account (POST /api/v1/auth/session).' });
        if (request.method === 'GET' && url.pathname === '/api/v1/developer/me') {
          return send(response, 200, { user: { userRef: 'https://olan.test#u1', email: 'ayse@example.com', name: 'Ayşe' }, developers, agreement: { currentVersion: '2026-10' }, invites: [] });
        }
        if (request.method === 'POST' && url.pathname === '/api/v1/developer/accounts') {
          const input = JSON.parse(body.toString('utf8')) as { slug: string; name: string; kind: string; agreementVersion: string };
          if (input.agreementVersion !== '2026-10') return send(response, 409, { error: 'agreement_required', message: 'Accept the current developer agreement (2026-10).' });
          if (developers.some((entry) => entry.slug === input.slug)) return send(response, 409, { error: 'developer_exists', message: `The developer name "${input.slug}" is taken.` });
          developers = [...developers, { slug: input.slug, role: 'owner' }];
          return send(response, 201, { developer: { slug: input.slug, name: input.name, kind: input.kind, agreement: { currentVersion: '2026-10', accepted: true } } });
        }
        const appMatch = /^\/api\/v1\/developer\/apps\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'GET' && appMatch) {
          const versions = apps.get(appMatch[1]!);
          if (!versions) return send(response, 404, { error: 'app_not_found', message: `${appMatch[1]} does not exist.` });
          return send(response, 200, { app: { id: appMatch[1], versions: versions.map((version) => ({ version })) } });
        }
        const versionMatch = /^\/api\/v1\/developer\/apps\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
        if (request.method === 'GET' && versionMatch) {
          const state = statusStates.length > 1 ? statusStates.shift()! : statusStates[0] ?? 'in_review';
          const failed = state === 'checks_failed' || state === 'rejected';
          return send(response, 200, {
            version: { version: versionMatch[2], reviewState: 'pending', channel: null, releaseState: null },
            submission: submission(versionMatch[1]!, versionMatch[2]!, state, failed
              ? { rejection: { rule: '2.1', code: state === 'rejected' ? 'guideline.2.1' : 'permissions.unused', notes: state === 'rejected' ? 'Crashes on open' : null, findings: [FAILED_FINDING] } }
              : {}),
          });
        }
        const uploadNew = request.method === 'POST' && url.pathname === '/api/v1/developer/packages';
        const uploadExisting = request.method === 'POST' && /^\/api\/v1\/developer\/apps\/([^/]+)\/versions$/.exec(url.pathname);
        if (uploadNew || uploadExisting) {
          if (uploadError) return send(response, uploadError.status, uploadError.body);
          const appId = 'com.example.test-app';
          const version = '0.1.0';
          const createdApp = !apps.has(appId);
          apps.set(appId, [version, ...(apps.get(appId) ?? [])]);
          return send(response, 202, {
            app: { id: appId, developer: 'acme', visibility: 'public' },
            version: { id: 'v1', appId, version, reviewState: 'pending' },
            createdApp,
            submission: submission(appId, version, uploadState),
          });
        }
        send(response, 404, { error: 'not_found', message: 'No such route.' });
      })();
    });
    await new Promise<void>((resolve) => olan.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => market.listen(0, '127.0.0.1', resolve));
    olanUrl = `http://127.0.0.1:${(olan.address() as AddressInfo).port}`;
    marketUrl = `http://127.0.0.1:${(market.address() as AddressInfo).port}`;
    project = tempProject('marketplace', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
    home = tempProject('marketplace-home');
  });
  afterAll(async () => {
    expect(allOutput).not.toContain(SESSION_TOKEN);
    expect(allOutput).not.toContain(OLAN_TOKEN);
    project?.remove();
    home?.remove();
    await new Promise<void>((resolve) => olan.close(() => resolve()));
    await new Promise<void>((resolve) => market.close(() => resolve()));
  });
  beforeEach(() => {
    statusStates = ['in_review'];
    uploadState = 'checking';
    uploadError = null;
    developers = [{ slug: 'acme', role: 'owner' }];
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: home.dir, USERPROFILE: home.dir, OLAN_MARKETPLACE_POLL_MS: '5', ...extra });

  const run = async (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(argv, { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), cwd: project.dir, env: env(extraEnv) });
    allOutput += stdout + stderr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    const json = (): any => JSON.parse(stdout);
    return { code, stdout, stderr, json };
  };

  it('explains how to sign in when there is no session', async () => {
    const human = await run(['publish', '--marketplace', marketUrl]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('marketplace.session_missing');
    expect(human.stderr).toContain('olan-app login --marketplace');
    const json = await run(['status', '--marketplace', marketUrl, 'com.example.test-app', '--json']);
    expect(json.code).toBe(1);
    expect(json.json()).toEqual({ error: 'session_missing', message: `You are not signed in to ${marketUrl}`, hint: expect.stringContaining('olan-app login --marketplace') });
  });

  it('login exchanges the Olan identity token for a developer session saved with mode 0600', async () => {
    const denied = await run(['login', '--marketplace', marketUrl, '--server', olanUrl, '--token', 'wrong']);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('marketplace.identity_token_failed');
    expect(denied.stderr).toContain('olan auth login');

    const out = await run(['login', '--marketplace', marketUrl, '--json'], { OLAN_SERVER: olanUrl, OLAN_TOKEN });
    expect(out.code).toBe(0);
    const file = join(home.dir, '.olan', 'marketplace.json');
    expect(out.json()).toEqual({
      url: marketUrl,
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { userRef: 'https://olan.test#u1', email: 'ayse@example.com', name: 'Ayşe', organizationId: 'org-1' },
      developers: [{ slug: 'acme', role: 'owner' }],
      sessionFile: file,
    });
    const exchange = requests.find((entry) => entry.path === '/api/v1/auth/session')!;
    expect(JSON.parse(exchange.body.toString('utf8'))).toEqual({ idToken: ID_TOKEN, client: 'cli' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      url: marketUrl, token: SESSION_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', userRef: 'https://olan.test#u1', organizationId: 'org-1',
      // The server's marketplace id from the identity-token answer (`publish --visibility org`).
      serverId: '7d1b6b0e-6a43-4c1c-9d55-1f0a3f6f7c11',
    });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const human = await run(['login', '--marketplace', marketUrl], { OLAN_SERVER: olanUrl, OLAN_TOKEN });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Signed in to');
    expect(human.stdout).toContain('acme (owner)');
  });

  it('login without a token signs in through the browser and finds the marketplace in the server\'s /.well-known/olan', async () => {
    let stdout = '';
    let stderr = '';
    let browser: Promise<{ status: number; text: string }> | undefined;
    const code = await runCli(['login', '--marketplace', '--server', olanUrl, '--no-browser', '--json'], {
      stdout: (text) => void (stdout += text),
      stderr: (text) => {
        stderr += text;
        // The "browser": opens the printed address and follows the redirect to the CLI's loopback.
        const address = /(http:\/\/\S+\/oauth\/authorize\?\S+)/.exec(text)?.[1];
        if (address && !browser) browser = fetch(address).then(async (response) => ({ status: response.status, text: await response.text() }));
      },
      cwd: project.dir,
      env: env(),
    });
    allOutput += stdout + stderr;
    expect(code).toBe(0);
    expect(stderr).toContain('Open this address in a browser on this computer');
    expect(await browser).toMatchObject({ status: 200, text: expect.stringContaining('Signed in') });
    expect(JSON.parse(stdout)).toMatchObject({ url: marketUrl, developers: [{ slug: 'acme', role: 'owner' }] });
    expect(JSON.parse(readFileSync(join(home.dir, '.olan', 'marketplace.json'), 'utf8'))).toMatchObject({ url: marketUrl, token: SESSION_TOKEN, server: olanUrl });

    const noServer = await run(['login', '--marketplace', marketUrl]);
    expect(noServer.code).toBe(1);
    expect(noServer.stderr).toContain('marketplace.server_required');
  });

  it('resolves the marketplace: flag, OLAN_MARKETPLACE_URL, session, the server\'s /.well-known/olan, production', async () => {
    expect(await resolveMarketplaceUrl('https://flag.example/', { OLAN_MARKETPLACE_URL: 'https://env.example', OLAN_SERVER: olanUrl })).toBe('https://flag.example');
    expect(await resolveMarketplaceUrl(true, { OLAN_MARKETPLACE_URL: 'https://env.example', OLAN_SERVER: olanUrl })).toBe('https://env.example');
    expect(await resolveMarketplaceUrl(true, { OLAN_SERVER: olanUrl }, { session: { url: 'https://session.example' } })).toBe('https://session.example');
    expect(await resolveMarketplaceUrl(true, { OLAN_SERVER: olanUrl })).toBe(marketUrl);
    expect(await resolveMarketplaceUrl(true, { OLAN_API_URL: olanUrl })).toBe(marketUrl);
    expect(await resolveMarketplaceUrl(true, {}, { server: 'http://127.0.0.1:1' })).toBe(DEFAULT_MARKETPLACE_URL);
    expect(await resolveMarketplaceUrl(true, {})).toBe(DEFAULT_MARKETPLACE_URL);
  });

  it('developer list and create; publish without an account names `developer create`', async () => {
    developers = [];
    const none = await run(['developer', 'list', '--marketplace']);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('olan-app developer create');

    const publish = await run(['publish', '--marketplace']);
    expect(publish.code).toBe(1);
    expect(publish.stderr).toContain('marketplace.developer_account_missing');
    expect(publish.stderr).toContain('olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement');

    const unaccepted = await run(['developer', 'create', '--marketplace', '--slug', 'ayse', '--name', 'Ayşe Yılmaz', '--kind', 'person']);
    expect(unaccepted.code).toBe(1);
    expect(unaccepted.stderr).toContain('marketplace.agreement_required');
    expect(unaccepted.stderr).toContain('version 2026-10');
    expect(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/v1/developer/accounts')).toBe(false);

    const badSlug = await run(['developer', 'create', '--marketplace', '--slug', 'Ayşe', '--name', 'x', '--accept-agreement', '--json']);
    expect(badSlug.code).toBe(1);
    expect(badSlug.json()).toMatchObject({ error: 'invalid_option' });

    const created = await run(['developer', 'create', '--marketplace', '--slug', 'ayse', '--name', 'Ayşe Yılmaz', '--kind', 'person', '--accept-agreement', '--json']);
    expect(created.code).toBe(0);
    expect(created.json()).toEqual({ developer: { slug: 'ayse', name: 'Ayşe Yılmaz', kind: 'person', agreement: { currentVersion: '2026-10', accepted: true } } });
    const post = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/developer/accounts').at(-1)!;
    expect(JSON.parse(post.body.toString('utf8'))).toEqual({ slug: 'ayse', name: 'Ayşe Yılmaz', kind: 'person', agreementVersion: '2026-10' });

    const taken = await run(['developer', 'create', '--marketplace', '--slug', 'ayse', '--name', 'Again', '--accept-agreement', '--json']);
    expect(taken.code).toBe(1);
    expect(taken.json()).toEqual({ error: 'developer_exists', message: 'The developer name "ayse" is taken.' });

    const listed = await run(['developer', 'list', '--marketplace', '--json']);
    expect(listed.json()).toMatchObject({ developers: [{ slug: 'ayse', role: 'owner' }], agreement: { currentVersion: '2026-10' } });
  });

  it('publishes a new app: packs, picks the only developer account, waits for the checks and prints the response', async () => {
    statusStates = ['checking', 'in_review'];
    const out = await run(['publish', '--marketplace', '--json']);
    expect(out.code).toBe(0);
    const upload = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/developer/packages').at(-1)!;
    expect(upload.query).toEqual({ developer: 'acme' });
    expect(upload.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.body.toString('latin1')).toContain('name="package"; filename="com.example.test-app-0.1.0.olanapp"');
    // The marketplace answer, with the submission as the last poll saw it.
    expect(out.json()).toEqual({
      app: { id: 'com.example.test-app', developer: 'acme', visibility: 'public' },
      version: { id: 'v1', appId: 'com.example.test-app', version: '0.1.0', reviewState: 'pending' },
      createdApp: true,
      submission: submission('com.example.test-app', '0.1.0', 'in_review'),
    });
    packageFile = join(project.dir, 'dist', 'com.example.test-app-0.1.0.olanapp');
    expect(existsSync(packageFile)).toBe(true);
  });

  it('publishes the next version of an existing app with a staged release', async () => {
    const out = await run(['publish', '--marketplace', '--file', packageFile, '--channel', 'beta', '--percent', '10', '--no-wait']);
    expect(out.code).toBe(0);
    const upload = requests.filter((entry) => entry.method === 'POST').at(-1)!;
    expect(upload.path).toBe('/api/v1/developer/apps/com.example.test-app/versions');
    expect(upload.query).toEqual({ channel: 'beta', percent: '10' });
    expect(out.stdout).toContain('Submitted com.example.test-app 0.1.0');
    expect(out.stdout).toContain('State: checking');
    expect(out.stdout).toContain('olan-app status --marketplace com.example.test-app 0.1.0');
  });

  it('--visibility org: a new app for the organization on this server (server id from the login)', async () => {
    apps.delete('com.example.test-app');
    try {
      const out = await run(['publish', '--marketplace', '--file', packageFile, '--visibility', 'org', '--no-wait']);
      expect(out.code, out.stderr).toBe(0);
      const upload = requests.filter((entry) => entry.method === 'POST').at(-1)!;
      expect(upload.path).toBe('/api/v1/developer/packages');
      expect(upload.query).toEqual({ developer: 'acme', visibility: 'organization:7d1b6b0e-6a43-4c1c-9d55-1f0a3f6f7c11/org-1' });
    } finally {
      apps.set('com.example.test-app', ['0.1.0']);
    }
  });

  it('exits 1 with the findings when the automatic checks fail', async () => {
    statusStates = ['checking', 'checks_failed'];
    const json = await run(['publish', '--marketplace', '--file', packageFile, '--json']);
    expect(json.code).toBe(1);
    expect(json.json()).toMatchObject({ createdApp: false, submission: { state: 'checks_failed', nextAction: 'fix_and_resubmit', rejection: { findings: [FAILED_FINDING] } } });

    statusStates = ['checks_failed'];
    const human = await run(['publish', '--marketplace', '--file', packageFile]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('marketplace.checks_failed');
    expect(human.stderr).toContain('olan-app.json permissions.unused: storage is declared but never used');
  });

  it('maps marketplace errors to hints and prints the error body unchanged with --json', async () => {
    uploadError = { status: 409, body: { error: 'version_not_increasing', message: '0.1.0 is not above 0.2.0.' } };
    const human = await run(['publish', '--marketplace', '--file', packageFile]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('marketplace.version_not_increasing: 0.1.0 is not above 0.2.0.');
    expect(human.stderr).toContain('raise "version" in olan-app.json');

    uploadError = { status: 400, body: { error: 'package_invalid', message: 'The package did not pass validation.', issues: [{ code: 'package.digest_mismatch', path: 'dist/app.js', message: 'digest differs' }] } };
    const json = await run(['publish', '--marketplace', '--file', packageFile, '--json']);
    expect(json.code).toBe(1);
    expect(json.json()).toEqual(uploadError.body);

    uploadError = { status: 409, body: { error: 'app_owned_by_other_developer', message: 'x belongs to another developer.' } };
    expect((await run(['publish', '--marketplace', '--file', packageFile])).stderr).toContain('--developer <slug>');
  });

  it('status: exit codes follow the submission state, the newest version by default', async () => {
    for (const [state, code] of [['approved', 0], ['in_review', 0], ['checking', 0], ['checks_failed', 1], ['rejected', 1], ['withdrawn', 1]] as const) {
      statusStates = [state];
      const out = await run(['status', '--marketplace', marketUrl, 'com.example.test-app', '--json']);
      expect(out.code, state).toBe(code);
      expect(out.json().submission.state).toBe(state);
    }
    expect(requests.filter((entry) => entry.method === 'GET').at(-1)!.path).toBe('/api/v1/developer/apps/com.example.test-app/versions/0.1.0');

    statusStates = ['rejected'];
    const human = await run(['status', '--marketplace', 'com.example.test-app', '0.1.0']);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('marketplace.rejected');
    expect(human.stderr).toContain('guideline 2.1 (guideline.2.1): Crashes on open');
    expect(human.stderr).toContain('State: rejected');
    expect(human.stderr).toContain('Next: fix the findings and publish again');

    statusStates = ['checking', 'in_review', 'approved'];
    const waited = await run(['status', '--marketplace', 'com.example.test-app', '0.1.0', '--wait-decision']);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain('State: approved');
    expect(waited.stdout).toContain(`Next: release it: \`olan-app release --marketplace ${marketUrl} com.example.test-app 0.1.0\``);
  });

  it('OLAN_MARKETPLACE_SESSION replaces the file; expired and revoked sessions point to login', async () => {
    statusStates = ['approved'];
    const fromEnv = await run(['status', '--marketplace', marketUrl, 'com.example.test-app'], { HOME: join(home.dir, 'nowhere'), USERPROFILE: join(home.dir, 'nowhere'), OLAN_MARKETPLACE_SESSION: SESSION_TOKEN });
    expect(fromEnv.code).toBe(0);

    const revoked = await run(['status', '--marketplace', marketUrl, 'com.example.test-app'], { OLAN_MARKETPLACE_SESSION: 'olan_dev_revoked' });
    expect(revoked.code).toBe(1);
    expect(revoked.stderr).toContain('marketplace.developer_sign_in_required');
    expect(revoked.stderr).toContain('olan-app login --marketplace');

    const file = join(home.dir, '.olan', 'marketplace.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...saved, expiresAt: '2020-01-01T00:00:00.000Z' }));
    const expired = await run(['status', '--marketplace', 'com.example.test-app']);
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain('marketplace.session_expired');
    const other = await run(['status', '--marketplace', 'https://marketplace.example.com', 'com.example.test-app'], { OLAN_MARKETPLACE_SESSION: JSON.stringify({ ...saved, url: marketUrl }) });
    expect(other.stderr).toContain('marketplace.session_other_marketplace');
    writeFileSync(file, JSON.stringify(saved));
  });

  it('publish without a target points production users to --marketplace', async () => {
    const out = await run(['publish', '--json']);
    expect(out.json().errors[0]).toMatchObject({ code: 'publish.target_required', hint: expect.stringContaining('publish --marketplace') });
    expect((await run(['publish', '--help'])).stdout).toContain('--marketplace [url]');
  });
});
