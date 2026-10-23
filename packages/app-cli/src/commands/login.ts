import { stringFlag } from '../args';
import type { Command } from '../command';
import { issue, type Issue } from '../errors';
import { marketplaceFail, marketplaceRequest, normalizeUrl, resolveMarketplaceUrl, saveSession, serverFromEnv } from '../marketplace';
import { browserSignIn } from '../oauth-login';

interface IdentityTokenResponse {
  idToken: string;
  expiresIn?: number;
  /** The server's marketplace registration id, when it is registered (for `--visibility org`). */
  serverId?: string | null;
}

interface SessionResponse {
  token: string;
  expiresAt: string;
  user: { userRef: string; email: string | null; name: string | null; organizationId: string | null };
  developers: { slug: string; role: string }[];
}

export interface LoginResult {
  url: string;
  expiresAt: string;
  user: SessionResponse['user'];
  developers: SessionResponse['developers'];
  sessionFile: string;
}

const SERVER_HINTS: Record<number, string> = {
  401: 'The Olan access token is missing or expired: drop --token / OLAN_TOKEN to sign in in the browser, or run `olan auth login`, then `olan app login --marketplace`.',
  403: 'Marketplace sign-in needs the developer grant on your Olan server (ask an administrator: Yönetim → Kullanıcılar).',
  404: 'This Olan server does not issue marketplace identity tokens yet; update it or sign in through olan.app.',
};

/**
 * Gets a 5-minute identity token from the Olan server (`POST /api/v2/apps/marketplace/identity-token`,
 * contract §15) with an Olan access token: OLAN_TOKEN / --token (set by `olan app`), else one from
 * the browser sign-in.
 */
export async function fetchIdentityToken(server: string, token: string, fetchImpl: typeof fetch = fetch): Promise<IdentityTokenResponse> {
  const endpoint = `${server}/api/v2/apps/marketplace/identity-token`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    marketplaceFail('server_unreachable', `Could not reach ${server}: ${error instanceof Error ? error.message : String(error)}`, 'Check --server (the Olan API address, e.g. https://api.olan.app).');
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok || typeof body?.idToken !== 'string') {
    const code = typeof body?.error === 'string' ? body.error : `http_${response.status}`;
    marketplaceFail('identity_token_failed', `${server} did not issue a marketplace identity token (${response.status} ${code})`, SERVER_HINTS[response.status]);
  }
  return body as unknown as IdentityTokenResponse;
}

export const loginCommand: Command = {
  name: 'login',
  summary: 'Sign in to Olan Marketplace with your Olan account (saves a developer session)',
  usage: 'olan-app login --marketplace [url] --server <olan api url> [--no-browser] [--token <olan token>]',
  options: [
    '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, then the server\'s /.well-known/olan',
    '                     marketplaceUrl, then https://marketplace.olan.app)',
    '--server <url>       Olan API to sign in with (default: OLAN_SERVER, then OLAN_API_URL; `olan app` sets it)',
    '--token <token>      Olan access token (default: OLAN_TOKEN; `olan app` sets it). Without one the CLI',
    '                     signs you in in the browser (OAuth with PKCE, redirect to http://127.0.0.1:<port>)',
    '--no-browser         Print the sign-in address instead of opening the browser (open it on this computer)',
    '',
    'Saves ~/.olan/marketplace.json (mode 0600; 30 days). OLAN_MARKETPLACE_SESSION replaces the file (CI).',
    'No token is ever printed.',
  ],
  spec: { optionalUrls: ['marketplace'], strings: ['server', 'token'], booleans: ['browser'] },
  async run(args, context) {
    const flag = args.flags.marketplace;
    if (flag === undefined || flag === false) {
      marketplaceFail('target_required', 'Choose where to sign in: --marketplace [url]', 'Run `olan-app login --marketplace`.');
    }
    const serverValue = stringFlag(args, 'server') ?? serverFromEnv(context.env);
    if (!serverValue) {
      marketplaceFail('server_required', 'No Olan server: pass --server <url> or set OLAN_SERVER', 'Pass the Olan API address you sign in to, e.g. `olan-app login --marketplace --server https://api.example.com`.');
    }
    const server = normalizeUrl(serverValue);
    if (!/^https?:\/\/[^/]+/i.test(server)) marketplaceFail('invalid_url', `${serverValue} is not an http(s) URL`, 'Pass --server <Olan API address>.');
    const url = await resolveMarketplaceUrl(flag, context.env, { server });
    const tokenFlag = stringFlag(args, 'token');
    if (tokenFlag !== undefined && !tokenFlag.trim()) marketplaceFail('token_required', '--token is empty', 'Drop --token to sign in in the browser, or pass an Olan access token (CI: OLAN_TOKEN).');
    const olanToken = tokenFlag?.trim() || context.env.OLAN_TOKEN?.trim() || await browserSignIn({
      server,
      notify: context.notify ?? context.log,
      openBrowser: args.flags.browser !== false,
    });

    context.log(`Getting an identity token from ${server}…`);
    const identity = await fetchIdentityToken(server, olanToken);
    const session = await marketplaceRequest<SessionResponse>(url, '/api/v1/auth/session', { method: 'POST', json: { idToken: identity.idToken, client: 'cli' } });
    if (typeof session?.token !== 'string' || typeof session.expiresAt !== 'string') marketplaceFail('session_invalid', `${url} did not return a session`);
    const sessionFile = saveSession(context.env, {
      url,
      token: session.token,
      expiresAt: session.expiresAt,
      userRef: session.user.userRef,
      email: session.user.email,
      organizationId: session.user.organizationId,
      serverId: identity.serverId ?? null,
      server,
    });
    const result: LoginResult = { url, expiresAt: session.expiresAt, user: session.user, developers: session.developers, sessionFile };
    const warnings: Issue[] = context.env.OLAN_MARKETPLACE_SESSION?.trim()
      ? [issue('marketplace.session_env_override', 'OLAN_MARKETPLACE_SESSION is set and replaces the saved session; unset it to use this sign-in')]
      : [];
    return {
      result,
      raw: true,
      warnings,
      human: [
        `Signed in to ${url} as ${session.user.email ?? session.user.name ?? session.user.userRef} until ${session.expiresAt}`,
        session.developers.length
          ? `  Developer accounts: ${session.developers.map((entry) => `${entry.slug} (${entry.role})`).join(', ')}`
          : '  No developer account yet: create one with `olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement`.',
        `  Session saved to ${sessionFile}`,
      ],
    };
  },
};
