import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { marketplaceFail } from './marketplace';

/*
 * Browser sign-in to an Olan server for `olan-app login --marketplace` (no --token / OLAN_TOKEN):
 * OAuth 2.0 authorization code with PKCE and a loopback redirect (RFC 8252). The endpoints come
 * from the server's `/.well-known/openid-configuration`; the client is the public `olan-app-cli`
 * client, which may redirect to `http://127.0.0.1:<any port>/callback`. The access token is only
 * used to ask the server for a marketplace identity token; it is never printed or stored.
 */

export const APP_CLI_CLIENT_ID = 'olan-app-cli';
/** How long the CLI waits for the browser to come back. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SCOPE = 'openid email profile';

interface OpenIdConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
}

export interface BrowserSignInOptions {
  /** Olan API address (normalized, no trailing slash). */
  server: string;
  /** Lines the person must see even with `--json` (the sign-in address). */
  notify(line: string): void;
  /** Open the system browser (false: print the address only, `--no-browser`). */
  openBrowser: boolean;
  /** Opens a URL in the browser; replaced in tests. */
  open?: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reads the server's OpenID configuration (authorization and token endpoints). */
export async function discoverOpenId(server: string, fetchImpl: typeof fetch = fetch): Promise<OpenIdConfiguration> {
  const endpoint = `${server}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    marketplaceFail('server_unreachable', `Could not reach ${server}: ${error instanceof Error ? error.message : String(error)}`, 'Check --server (the Olan API address, e.g. https://api.example.com).');
  }
  let body: Partial<OpenIdConfiguration> | null = null;
  try {
    body = (await response.json()) as Partial<OpenIdConfiguration>;
  } catch {
    body = null;
  }
  if (!response.ok || !isHttpUrl(body?.authorization_endpoint) || !isHttpUrl(body?.token_endpoint)) {
    marketplaceFail('sign_in_unsupported', `${server} does not offer browser sign-in (no OpenID configuration at ${endpoint})`, 'Check --server, or sign in with an Olan access token: OLAN_TOKEN / --token, or `olan app login --marketplace`.');
  }
  if (Array.isArray(body.code_challenge_methods_supported) && !body.code_challenge_methods_supported.includes('S256')) {
    marketplaceFail('sign_in_unsupported', `${server} does not support PKCE (S256)`, 'Sign in with OLAN_TOKEN / --token instead.');
  }
  return body as OpenIdConfiguration;
}

/** Opens `url` in the system browser without a shell (the address contains `&`). Best effort. */
export function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The address is printed as well.
  }
}

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

interface CallbackResult {
  code?: string;
  error?: string;
}

/** Listens on 127.0.0.1:<random port> for `/callback?code=…&state=…`. */
async function startLoopback(state: string): Promise<{ server: Server; redirectUri: string; result: Promise<CallbackResult> }> {
  let settle!: (value: CallbackResult) => void;
  const result = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" };
    // A callback for another sign-in attempt (or a forged one) is refused and the wait continues.
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, headers);
      response.end(PAGE('Olan', 'This sign-in link does not belong to the running olan-app login. Start it again from the terminal.'));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      response.writeHead(400, headers);
      response.end(PAGE('Olan', 'Sign-in was not completed. You can close this tab and return to the terminal.'));
      settle({ error: error ?? 'missing_code' });
      return;
    }
    response.writeHead(200, headers);
    response.end(PAGE('Olan', 'Giriş yapıldı. Bu sekmeyi kapatıp terminale dönebilirsiniz.<br>Signed in. You can close this tab and return to the terminal.'));
    settle({ code });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, redirectUri: `http://127.0.0.1:${port}/callback`, result };
}

/**
 * Signs in through the browser and returns an Olan access token for `server`
 * (authorization code + PKCE, loopback redirect).
 */
export async function browserSignIn(options: BrowserSignInOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = await discoverOpenId(options.server, fetchImpl);
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));
  const loopback = await startLoopback(state);
  let timer: NodeJS.Timeout | undefined;
  try {
    const authorize = new URL(config.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: APP_CLI_CLIENT_ID,
      redirect_uri: loopback.redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const address = authorize.toString();
    options.notify(options.openBrowser
      ? `Opening your browser to sign in to ${options.server}. If it does not open, visit:\n  ${address}`
      : `Open this address in a browser on this computer to sign in to ${options.server}:\n  ${address}`);
    if (options.openBrowser) (options.open ?? openInBrowser)(address);

    const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const timeout = new Promise<CallbackResult>((resolve) => {
      timer = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs);
      timer.unref();
    });
    const callback = await Promise.race([loopback.result, timeout]);
    if (callback.error === 'timeout') {
      marketplaceFail('sign_in_timeout', `No sign-in arrived within ${Math.round(timeoutMs / 1000)} seconds`, 'Run `olan-app login --marketplace` again and finish signing in in the browser.');
    }
    if (!callback.code) {
      marketplaceFail('sign_in_denied', `The browser sign-in ended without a code (${callback.error})`, 'Run `olan-app login --marketplace` again; sign in with the account that has developer access.');
    }

    let response: Response;
    try {
      response = await fetchImpl(config.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.code, client_id: APP_CLI_CLIENT_ID, redirect_uri: loopback.redirectUri, code_verifier: verifier }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      marketplaceFail('server_unreachable', `Could not reach ${config.token_endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token) {
      // Only the error code: the body may carry tokens.
      const code = typeof body?.error === 'string' ? body.error : `http_${response.status}`;
      marketplaceFail('sign_in_failed', `${options.server} did not accept the sign-in (${code})`, code === 'invalid_client' ? 'This Olan server does not know the olan-app CLI yet (update it), or sign in with OLAN_TOKEN / --token.' : 'Run `olan-app login --marketplace` again.');
    }
    return body.access_token;
  } finally {
    if (timer) clearTimeout(timer);
    loopback.server.closeAllConnections();
    loopback.server.close();
  }
}
