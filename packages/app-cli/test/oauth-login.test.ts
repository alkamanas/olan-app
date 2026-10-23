// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors';
import { APP_CLI_CLIENT_ID, browserSignIn, discoverOpenId } from '../src/oauth-login';

/*
 * Browser sign-in (authorization code + PKCE, loopback redirect) against a fake OpenID provider
 * that behaves like the Olan server's /oauth routes. The "browser" is a fetch that follows the
 * authorize redirect to the CLI's loopback callback.
 */

const ACCESS_TOKEN = 'olan-access-token-from-browser-sign-in';

async function readAll(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('browser sign-in (fake OpenID provider)', () => {
  let provider: Server;
  let base = '';
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let authorizeQuery: URLSearchParams | null = null;
  let tokenForm: URLSearchParams | null = null;
  /** What /oauth/authorize does: redirect with a code, with an error, or with a wrong state. */
  let authorizeMode: 'code' | 'denied' | 'wrong_state' = 'code';
  let tokenError: string | null = null;
  let discovery: Record<string, unknown> | null = null;

  beforeAll(async () => {
    provider = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', base);
        const body = await readAll(request);
        if (url.pathname === '/.well-known/openid-configuration') {
          return send(response, discovery ? 200 : 404, discovery ?? { error: 'not_found' });
        }
        if (url.pathname === '/oauth/authorize') {
          authorizeQuery = url.searchParams;
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          // The server's rule for the olan-app CLI: any port on 127.0.0.1, path /callback.
          if (url.searchParams.get('client_id') !== APP_CLI_CLIENT_ID || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) return send(response, 400, { error: 'invalid_client' });
          if (url.searchParams.get('code_challenge_method') !== 'S256') return send(response, 400, { error: 'invalid_request' });
          const callback = new URL(redirectUri);
          if (authorizeMode === 'denied') callback.searchParams.set('error', 'access_denied');
          else {
            const code = `code-${codes.size + 1}`;
            codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri });
            callback.searchParams.set('code', code);
          }
          callback.searchParams.set('state', authorizeMode === 'wrong_state' ? 'forged' : url.searchParams.get('state') ?? '');
          response.writeHead(302, { location: callback.toString() });
          return response.end();
        }
        if (url.pathname === '/oauth/token' && request.method === 'POST') {
          tokenForm = new URLSearchParams(body);
          if (tokenError) return send(response, 400, { error: tokenError, access_token_hint: ACCESS_TOKEN });
          const grant = codes.get(tokenForm.get('code') ?? '');
          const verifier = tokenForm.get('code_verifier') ?? '';
          if (!grant || grant.redirectUri !== tokenForm.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
            return send(response, 400, { error: 'invalid_grant' });
          }
          return send(response, 200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 900, id_token: 'id-token' });
        }
        send(response, 404, { error: 'not_found' });
      })();
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  beforeEach(() => {
    authorizeMode = 'code';
    tokenError = null;
    authorizeQuery = null;
    tokenForm = null;
    discovery = { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, code_challenge_methods_supported: ['S256'] };
  });

  /** Runs the sign-in; the "browser" opens the printed address (or the one passed to `open`). */
  async function signIn(openBrowser: boolean, timeoutMs = 10_000) {
    const printed: string[] = [];
    const pages: Promise<{ status: number; text: string }>[] = [];
    const visit = (address: string) => {
      pages.push(fetch(address).then(async (response) => ({ status: response.status, text: await response.text() })));
    };
    const result = browserSignIn({
      server: base,
      openBrowser,
      timeoutMs,
      notify: (line) => {
        printed.push(line);
        const address = /(http:\/\/\S+\/oauth\/authorize\?\S+)/.exec(line)?.[1];
        if (!openBrowser && address) visit(address);
      },
      open: visit,
    });
    return { result, printed, pages };
  }

  it('prints the address, receives the code on the loopback port and exchanges it with the PKCE verifier', async () => {
    const run = await signIn(false);
    await expect(run.result).resolves.toBe(ACCESS_TOKEN);
    expect(run.printed.join('\n')).toContain('Open this address in a browser on this computer');
    const page = await run.pages[0]!;
    expect(page.status).toBe(200);
    expect(page.text).toContain('Signed in');
    expect(authorizeQuery!.get('client_id')).toBe('olan-app-cli');
    expect(authorizeQuery!.get('response_type')).toBe('code');
    expect(authorizeQuery!.get('scope')).toBe('openid email profile');
    expect(authorizeQuery!.get('code_challenge_method')).toBe('S256');
    expect(authorizeQuery!.get('state')).toMatch(/^[\w-]{20,}$/);
    expect(tokenForm!.get('grant_type')).toBe('authorization_code');
    expect(tokenForm!.get('client_id')).toBe('olan-app-cli');
    expect(tokenForm!.get('redirect_uri')).toBe(authorizeQuery!.get('redirect_uri'));
    expect(tokenForm!.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
    // Never printed.
    expect(run.printed.join('\n')).not.toContain(ACCESS_TOKEN);
  });

  it('opens the browser with the same address unless --no-browser', async () => {
    const run = await signIn(true);
    await expect(run.result).resolves.toBe(ACCESS_TOKEN);
    expect(run.printed.join('\n')).toContain('Opening your browser');
    expect(run.pages).toHaveLength(1);
  });

  it('ignores a callback with another state and gives up after the timeout', async () => {
    authorizeMode = 'wrong_state';
    const run = await signIn(false, 300);
    await expect(run.result).rejects.toMatchObject({ issues: [{ code: 'marketplace.sign_in_timeout' }] });
    expect((await run.pages[0]!).status).toBe(400);
    expect(tokenForm).toBeNull();
  });

  it('reports a denied sign-in and a refused code exchange without the response body', async () => {
    authorizeMode = 'denied';
    const denied = await signIn(false);
    await expect(denied.result).rejects.toMatchObject({ issues: [{ code: 'marketplace.sign_in_denied' }] });

    authorizeMode = 'code';
    tokenError = 'invalid_client';
    const refused = await signIn(false);
    const error = await refused.result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).issues[0]).toMatchObject({ code: 'marketplace.sign_in_failed', hint: expect.stringContaining('OLAN_TOKEN') });
    expect(JSON.stringify((error as CliError).raw)).not.toContain(ACCESS_TOKEN);
  });

  it('needs an OpenID configuration with PKCE', async () => {
    discovery = null;
    await expect(discoverOpenId(base)).rejects.toMatchObject({ issues: [{ code: 'marketplace.sign_in_unsupported' }] });
    discovery = { authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, code_challenge_methods_supported: ['plain'] };
    await expect(discoverOpenId(base)).rejects.toMatchObject({ issues: [{ code: 'marketplace.sign_in_unsupported' }] });
    await expect(discoverOpenId('http://127.0.0.1:1')).rejects.toMatchObject({ issues: [{ code: 'marketplace.server_unreachable' }] });
  });
});
