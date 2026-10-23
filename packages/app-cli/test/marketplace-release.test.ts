// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { verifyTestReport, type TestReportDocument, type TestReportPayload } from '@olan-app/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { readPackageIdentity, verifyEd25519 } from '../src/test-report';
import { manifest, tempProject, type TempProject } from './helpers';

/*
 * Phase 4b/4c CLI (contract §22, §27): `release|rollout|halt|withdraw`, `keys`, `test --report` and
 * `publish --marketplace --test-report` against an in-process fake marketplace. The real marketplace
 * runs the same flow in marketplace.pg.test.ts.
 */

const SESSION_TOKEN = 'olan_dev_SECRET-release-session-never-printed';
const APP_ID = 'com.example.test-app';

const APP = `
import { Button, Screen, Text, defineApp, olan } from '@olan-app/sdk';
function Home() {
  return <Screen title="Pazar"><Text text="Merhaba" /><Button label="Selam" onPress={() => olan.ui.toast({ text: 'Selam' })} /></Screen>;
}
export default defineApp({ app: Home });
`;

const TESTS = `
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '@olan-app/cli/testing';

test('greets', async () => {
  const app = await renderApp();
  app.expectText('Merhaba');
  await app.dispose();
});

test('says hello on press', async () => {
  const app = await renderApp();
  await app.press('Selam');
  assert.deepEqual(app.toasts(), [{ text: 'Selam' }]);
  await app.dispose();
});

test.skip('later', () => {});
`;

interface Recorded {
  method: string;
  path: string;
  body: string;
  authorization?: string;
}

async function readAll(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('latin1');
}

function send(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function version(extra: Record<string, unknown> = {}) {
  return { id: 'v1', appId: APP_ID, version: '0.1.0', reviewState: 'approved', channel: null, releaseState: null, rollout: { percent: 100, haltedAt: null, updatedAt: null }, ...extra };
}

describe('release, rollout, halt, withdraw, keys and signed test reports (fake marketplace)', () => {
  let market: Server;
  let marketUrl = '';
  let project: TempProject;
  let home: TempProject;
  const requests: Recorded[] = [];
  let keys: { name: string; publicKey: string; fingerprint: string }[] = [];
  let developers = [{ slug: 'acme', role: 'owner' }];
  let rollout = 10;
  let live = false;
  let output = '';

  beforeAll(async () => {
    market = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://fake');
        const body = await readAll(request);
        requests.push({ method: request.method ?? '', path: url.pathname, body, authorization: request.headers.authorization });
        if (request.headers.authorization !== `Bearer ${SESSION_TOKEN}`) return send(response, 401, { error: 'developer_sign_in_required', message: 'Sign in.' });
        const json = () => JSON.parse(body || '{}') as Record<string, unknown>;
        if (request.method === 'GET' && url.pathname === '/api/v1/developer/me') return send(response, 200, { developers, agreement: { currentVersion: '2026-10' } });

        const action = /^\/api\/v1\/developer\/apps\/([^/]+)\/versions\/([^/]+)\/(release|rollout|rollout\/halt|withdraw|test-report)$/.exec(url.pathname);
        if (action && action[1] !== APP_ID) return send(response, 404, { error: 'app_not_found', message: `${action[1]} does not exist.` });
        if (action?.[3] === 'release' && request.method === 'POST') {
          const input = json() as { channel?: string; percent?: number };
          rollout = input.percent ?? 100;
          return send(response, 200, { version: version({ channel: input.channel ?? 'stable', releaseState: 'published', rollout: { percent: rollout, haltedAt: null, updatedAt: null } }) });
        }
        if (action?.[3] === 'rollout' && request.method === 'POST') {
          const percent = Number(json().percent);
          if (percent < rollout) return send(response, 409, { error: 'rollout_invalid', message: `A rollout only widens (now ${rollout}%); halt it to stop it.` });
          rollout = percent;
          return send(response, 200, { version: version({ channel: 'stable', releaseState: 'published', rollout: { percent, haltedAt: null, updatedAt: null } }) });
        }
        if (action?.[3] === 'rollout/halt' && request.method === 'POST') {
          return send(response, 200, { version: version({ channel: 'stable', releaseState: 'published', rollout: { percent: rollout, haltedAt: '2026-10-18T10:00:00.000Z', updatedAt: null } }) });
        }
        if (action?.[3] === 'withdraw' && request.method === 'POST') {
          return send(response, 200, { submission: { appId: APP_ID, version: action[2], state: 'withdrawn', nextAction: 'resubmit', notes: [] } });
        }
        if (action?.[3] === 'test-report' && request.method === 'PUT') {
          // The marketplace verifies against the stored package's digest; the fake trusts the payload's.
          const document = json() as unknown as TestReportDocument;
          const payload = JSON.parse(document.payload) as TestReportPayload;
          const verified = verifyTestReport(document, { appId: APP_ID, appVersion: '0.1.0', packageSha256: payload.packageSha256 }, verifyEd25519);
          if (!verified.ok) return send(response, 400, { error: verified.code, message: verified.message });
          const status = keys.some((key) => key.publicKey === verified.publicKey) ? 'verified' : 'unregistered_key';
          return send(response, 200, {
            submission: {
              appId: APP_ID, version: '0.1.0', state: 'checking', nextAction: 'wait', notes: [],
              testReport: { status, keyFingerprint: document.signature.keyId, summary: verified.payload.summary, failed: [] },
            },
          });
        }

        const keyRoute = /^\/api\/v1\/developer\/accounts\/([^/]+)\/keys(?:\/([^/]+))?$/.exec(url.pathname);
        if (keyRoute) {
          if (keyRoute[1] !== 'acme') return send(response, 404, { error: 'developer_not_found', message: 'No such developer.' });
          if (request.method === 'GET') return send(response, 200, { keys: keys.map((key) => ({ ...key, addedBy: 'u1', createdAt: '2026-10-18T10:00:00.000Z' })) });
          if (request.method === 'POST') {
            const input = json() as { name: string; publicKey: string };
            const key = { name: input.name, publicKey: input.publicKey, fingerprint: `fp-${keys.length + 1}` };
            keys = [...keys.filter((entry) => entry.publicKey !== input.publicKey), key];
            return send(response, 201, { key });
          }
          if (request.method === 'DELETE') {
            if (!keys.some((key) => key.fingerprint === keyRoute[2])) return send(response, 404, { error: 'not_found', message: 'No such key.' });
            keys = keys.filter((key) => key.fingerprint !== keyRoute[2]);
            return send(response, 204);
          }
        }

        if (request.method === 'PATCH' && url.pathname === `/api/v1/developer/apps/${APP_ID}`) {
          const input = json();
          if (live) return send(response, 202, { app: { id: APP_ID, ageRating: null }, pendingChange: { id: 'c1', kind: 'settings', state: 'pending', createdAt: '2026-10-18T10:00:00.000Z' } });
          return send(response, 200, { app: { id: APP_ID, category: 'productivity', ageRating: input.ageRating ?? null, platforms: ['web'], visibility: 'public', supportUrl: null, privacyPolicyUrl: null } });
        }
        if (request.method === 'GET' && url.pathname === `/api/v1/developer/apps/${APP_ID}`) return send(response, 200, { app: { id: APP_ID, versions: [{ version: '0.1.0' }] } });
        if (request.method === 'POST' && url.pathname === `/api/v1/developer/apps/${APP_ID}/versions`) {
          return send(response, 202, {
            app: { id: APP_ID, developer: 'acme' },
            version: { id: 'v1', appId: APP_ID, version: '0.1.0', reviewState: 'pending' },
            createdApp: false,
            submission: { appId: APP_ID, version: '0.1.0', state: 'checking', nextAction: 'wait', notes: [], testReport: null },
          });
        }
        send(response, 404, { error: 'not_found', message: 'No such route.' });
      })();
    });
    await new Promise<void>((resolve) => market.listen(0, '127.0.0.1', resolve));
    marketUrl = `http://127.0.0.1:${(market.address() as AddressInfo).port}`;
    project = tempProject('marketplace-release', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP, 'tests/app.test.ts': TESTS });
    home = tempProject('marketplace-release-home');
  });
  afterAll(async () => {
    expect(output).not.toContain(SESSION_TOKEN);
    project?.remove();
    home?.remove();
    await new Promise<void>((resolve) => market.close(() => resolve()));
  });
  beforeEach(() => {
    developers = [{ slug: 'acme', role: 'owner' }];
  });

  const run = async (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    let stdout = '';
    let stderr = '';
    const env = { HOME: home.dir, USERPROFILE: home.dir, OLAN_MARKETPLACE_SESSION: SESSION_TOKEN, OLAN_MARKETPLACE_URL: marketUrl, OLAN_MARKETPLACE_POLL_MS: '5', ...extraEnv };
    const code = await runCli(argv, { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), cwd: project.dir, env });
    output += stdout + stderr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    return { code, stdout, stderr, json: (): any => JSON.parse(stdout) };
  };
  const last = (path: string) => requests.filter((entry) => entry.path === path).at(-1)!;
  const versionPath = `/api/v1/developer/apps/${APP_ID}/versions/0.1.0`;

  it('release → rollout (only widens) → halt → resume, printing the marketplace answer with --json', async () => {
    const released = await run(['release', '--marketplace', APP_ID, '0.1.0', '--channel', 'beta', '--percent', '10', '--json']);
    expect(released.code).toBe(0);
    expect(JSON.parse(last(`${versionPath}/release`).body)).toEqual({ channel: 'beta', percent: 10 });
    expect(released.json()).toEqual({ version: version({ channel: 'beta', releaseState: 'published', rollout: { percent: 10, haltedAt: null, updatedAt: null } }) });

    const defaults = await run(['release', '--marketplace', marketUrl, APP_ID, '0.1.0', '--percent', '10']);
    expect(defaults.code).toBe(0);
    expect(JSON.parse(last(`${versionPath}/release`).body)).toEqual({ percent: 10 });
    expect(defaults.stdout).toContain('released to stable at 10%');
    expect(defaults.stdout).toContain(`olan-app rollout --marketplace ${APP_ID} 0.1.0 --percent 50`);

    const widened = await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--percent', '50']);
    expect(widened.code).toBe(0);
    expect(widened.stdout).toContain('at 50%');

    const narrowed = await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--percent', '10']);
    expect(narrowed.code).toBe(1);
    expect(narrowed.stderr).toContain('marketplace.rollout_invalid: A rollout only widens (now 50%)');
    expect(narrowed.stderr).toContain('10 → 50 → 100');
    const narrowedJson = await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--percent', '10', '--json']);
    expect(narrowedJson.json()).toEqual({ error: 'rollout_invalid', message: 'A rollout only widens (now 50%); halt it to stop it.' });

    const halted = await run(['halt', '--marketplace', APP_ID, '0.1.0', '--json']);
    expect(halted.code).toBe(0);
    expect(halted.json().version.rollout.haltedAt).toBe('2026-10-18T10:00:00.000Z');
    expect(last(`${versionPath}/rollout/halt`).method).toBe('POST');
    expect((await run(['halt', '--marketplace', APP_ID, '0.1.0'])).stdout).toContain('halted since 2026-10-18T10:00:00.000Z');

    const resumed = await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--percent', '100']);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('released to stable at 100%');
  });

  it('withdraw prints the withdrawn submission; usage mistakes fail before any request', async () => {
    const withdrawn = await run(['withdraw', '--marketplace', APP_ID, '0.1.0', '--json']);
    expect(withdrawn.code).toBe(0);
    expect(withdrawn.json()).toEqual({ submission: { appId: APP_ID, version: '0.1.0', state: 'withdrawn', nextAction: 'resubmit', notes: [] } });

    const before = requests.length;
    expect((await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--json'])).json()).toMatchObject({ error: 'invalid_option', message: expect.stringContaining('--percent') });
    expect((await run(['halt', '--marketplace', APP_ID, '0.1.0', '--percent', '50', '--json'])).json().errors[0].code).toBe('cli.unknown_option');
    expect((await run(['rollout', '--marketplace', APP_ID, '0.1.0', '--channel', 'beta', '--percent', '50', '--json'])).code).toBe(2);
    expect((await run(['release', '--marketplace', APP_ID, '0.1.0', '--percent', '0', '--json'])).json()).toMatchObject({ error: 'invalid_option' });
    expect((await run(['release', '--marketplace', APP_ID, '--json'])).json()).toMatchObject({ error: 'app_required' });
    expect((await run(['release', APP_ID, '0.1.0', '--json'])).json()).toMatchObject({ error: 'target_required' });
    expect(requests.length).toBe(before);

    const unknown = await run(['release', '--marketplace', 'com.example.other', '1.0.0']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('marketplace.app_not_found');
  });

  it('keys register, list and remove the development key\'s public half', async () => {
    const registered = await run(['keys', 'register', '--marketplace', '--name', 'Laptop', '--json']);
    expect(registered.code).toBe(0);
    const keyFile = JSON.parse(readFileSync(join(home.dir, '.olan', 'olan-app-dev.key.json'), 'utf8')) as { publicKey: string; privateKey: string };
    const sent = JSON.parse(last('/api/v1/developer/accounts/acme/keys').body) as Record<string, unknown>;
    expect(sent).toEqual({ name: 'Laptop', publicKey: keyFile.publicKey });
    expect(JSON.stringify(requests)).not.toContain(keyFile.privateKey);
    expect(registered.json()).toEqual({ key: { name: 'Laptop', publicKey: keyFile.publicKey, fingerprint: 'fp-1' } });

    const listed = await run(['keys', 'list', '--marketplace']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('fp-1  Laptop');
    expect(listed.stdout).toContain('this computer');

    developers = [{ slug: 'acme', role: 'owner' }, { slug: 'beta-labs', role: 'admin' }];
    const ambiguous = await run(['keys', 'list', '--marketplace', '--json']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json()).toMatchObject({ error: 'developer_required', hint: 'olan-app keys list --marketplace --developer acme' });

    const removed = await run(['keys', 'remove', '--marketplace', '--developer', 'acme', 'fp-1', '--json']);
    expect(removed.code).toBe(0);
    expect(removed.json()).toEqual({ removed: { developer: 'acme', fingerprint: 'fp-1' } });
    expect((await run(['keys', 'remove', '--marketplace', '--developer', 'acme', 'fp-1'])).stderr).toContain('marketplace.not_found');
  });

  it('test --report packs, runs the suite and signs a report verifyTestReport accepts; publish attaches it', async () => {
    const reportFile = join(project.dir, 'report.json');
    const tested = await run(['test', '--report', 'report.json', '--json']);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
    const result = tested.json().result;
    expect(result).toMatchObject({ passed: 2, failed: 0, skipped: 1, report: { file: 'report.json', appId: APP_ID, appVersion: '0.1.0', package: '.olan-app/report/com.example.test-app-0.1.0.olanapp' } });

    const document = JSON.parse(readFileSync(reportFile, 'utf8')) as TestReportDocument;
    const identity = readPackageIdentity(join(project.dir, '.olan-app', 'report', `${APP_ID}-0.1.0.olanapp`));
    expect(result.report.packageSha256).toBe(identity.packageSha256);
    const verified = verifyTestReport(document, identity, verifyEd25519);
    expect(verified.ok).toBe(true);
    const payload = JSON.parse(document.payload) as TestReportPayload;
    expect(payload).toMatchObject({ version: 1, appId: APP_ID, appVersion: '0.1.0', packageSha256: identity.packageSha256, tool: { cli: expect.stringMatching(/^olan-app \d/), runner: expect.stringMatching(/^node:test v\d/) }, summary: { passed: 2, failed: 0, skipped: 1 } });
    expect(payload.tests.map((test) => [test.file, test.name, test.status])).toEqual([
      ['tests/app.test.ts', 'greets', 'passed'],
      ['tests/app.test.ts', 'says hello on press', 'passed'],
      ['tests/app.test.ts', 'later', 'skipped'],
    ]);
    // Signed with the development key, over the payload text's UTF-8 bytes.
    const keyFile = JSON.parse(readFileSync(join(home.dir, '.olan', 'olan-app-dev.key.json'), 'utf8')) as { publicKey: string };
    expect(document.signature).toMatchObject({ algorithm: 'ed25519', publicKey: keyFile.publicKey });
    expect(verifyEd25519(new TextEncoder().encode(document.payload), document.signature.publicKey, document.signature.signature)).toBe(true);

    // The same sources pack to the same digest.package, so publish attaches it.
    keys = [];
    const published = await run(['publish', '--marketplace', '--test-report', 'report.json', '--no-wait', '--json']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    expect(JSON.parse(last(`${versionPath}/test-report`).body)).toEqual(document);
    expect(published.json()).toMatchObject({ createdApp: false, submission: { state: 'checking' }, testReport: { status: 'unregistered_key', summary: { passed: 2, failed: 0, skipped: 1 } } });

    await run(['keys', 'register', '--marketplace']);
    const human = await run(['publish', '--marketplace', '--test-report', 'report.json', '--no-wait']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Test report: verified; 2 passed, 0 failed, 1 skipped');

    // A changed report does not verify; a report for other sources is refused before uploading.
    const uploads = requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/versions')).length;
    writeFileSync(reportFile, JSON.stringify({ ...document, payload: document.payload.replace('"passed":2', '"passed":3') }));
    const tampered = await run(['publish', '--marketplace', '--test-report', 'report.json', '--json']);
    expect(tampered.code).toBe(1);
    expect(tampered.json()).toMatchObject({ error: 'test_report_signature_invalid' });
    writeFileSync(reportFile, JSON.stringify(document));
    project.write('src/app.tsx', APP.replace('Merhaba', 'Merhaba!'));
    const stale = await run(['publish', '--marketplace', '--test-report', 'report.json']);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('marketplace.test_report_mismatch');
    expect(stale.stderr).toContain('olan-app test --report');
    expect(requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/versions')).length).toBe(uploads);
    project.write('src/app.tsx', APP);
  }, 120_000);

  it('app set and publish --age-rating set the store settings; a live app\'s change is in review', async () => {
    live = false;
    const set = await run(['app', 'set', '--marketplace', APP_ID, '--age-rating', '9+', '--platforms', 'web', '--support-url', 'https://example.com/help']);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(last(`/api/v1/developer/apps/${APP_ID}`).body)).toEqual({ ageRating: '9+', platforms: ['web'], supportUrl: 'https://example.com/help' });
    expect(set.stdout).toContain('Age rating: 9+');

    live = true;
    const reviewed = await run(['app', 'set', '--marketplace', APP_ID, '--age-rating', '13+']);
    expect(reviewed.stdout).toContain('sent to review');
    expect(reviewed.stdout).toContain('change c1, in review');

    const before = requests.length;
    expect((await run(['app', 'set', '--marketplace', APP_ID, '--age-rating', '18+', '--json'])).json()).toMatchObject({ error: 'age_rating_not_allowed' });
    expect((await run(['app', 'set', '--marketplace', APP_ID, '--age-rating', '7+', '--json'])).json()).toMatchObject({ error: 'invalid_option' });
    expect((await run(['app', 'set', '--marketplace', APP_ID, '--json'])).json()).toMatchObject({ error: 'invalid_option' });
    expect((await run(['app', 'set', APP_ID, '--age-rating', '4+', '--json'])).json()).toMatchObject({ error: 'target_required' });
    expect((await run(['publish', '--marketplace', '--age-rating', '18+', '--json'])).json()).toMatchObject({ error: 'age_rating_not_allowed' });
    expect(requests.length).toBe(before);

    live = false;
    const published = await run(['publish', '--marketplace', '--age-rating', '4+', '--no-wait']);
    expect(published.code, published.stderr).toBe(0);
    expect(JSON.parse(last(`/api/v1/developer/apps/${APP_ID}`).body)).toEqual({ ageRating: '4+' });
    expect(published.stdout).toContain(`Store settings of ${APP_ID} saved`);
  }, 120_000);

  it('test --report says whether reviewers will see the report as verified', async () => {
    keys = [];
    const unregistered = await run(['test', '--report', 'report.json']);
    expect(unregistered.code, unregistered.stderr).toBe(0);
    expect(unregistered.stdout).toContain('once the key is registered: olan-app keys register --marketplace');
    await run(['keys', 'register', '--marketplace']);
    const registered = await run(['test', '--report', 'report.json']);
    expect(registered.stdout).toContain('The key is registered with acme: reviewers see the report as verified.');
    const signedOut = await run(['test', '--report', 'report.json'], { OLAN_MARKETPLACE_SESSION: '' });
    expect(signedOut.stdout).toContain('when this key is registered with your developer account');
  }, 120_000);

  it('test --report refuses a pattern; --package binds to an existing package', async () => {
    expect((await run(['test', 'app', '--report', 'r.json', '--json'])).json().errors[0].code).toBe('test.report_pattern');
    expect((await run(['test', '--package', 'x.olanapp', '--json'])).json().errors[0].code).toBe('test.package_without_report');
    const packed = await run(['pack', '--no-sign', '--json']);
    expect(packed.code).toBe(0);
    const bound = await run(['test', '--report', 'bound.json', '--package', `dist/${APP_ID}-0.1.0.olanapp`, '--json']);
    expect(bound.code).toBe(0);
    expect(bound.json().result.report).toMatchObject({ package: `dist/${APP_ID}-0.1.0.olanapp`, packageSha256: packed.json().result.sha256 });
  }, 120_000);
});
