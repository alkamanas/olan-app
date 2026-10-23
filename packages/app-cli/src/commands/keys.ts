import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

import { stringFlag, type ParsedArgs } from '../args';
import type { Command, CommandContext, CommandOutput } from '../command';
import { devKeyPath, ensureDevKey } from '../dev-key';
import { CliError, fail } from '../errors';
import { marketplaceFail, marketplaceRequest, pickDeveloper, requireMarketplaceFlag, requireSession } from '../marketplace';
import { readSigningKey } from './pack';
import { serverIssues } from './publish';

/*
 * Two kinds of developer key registration, both for the local development key (`olan-app keygen
 * --dev`, `~/.olan/olan-app-dev.key.json`); only its public half ever leaves the computer:
 *
 * - On the signed-in Olan server (decision 2026-10-18, `register|list|revoke` without --marketplace,
 *   the server and token of `olan-app try` / `publish --org`): the key then signs the developer's own
 *   development installations in their organization (`olan-app try`, Studio "Bu kurumda dene"), and
 *   nothing else: never catalog uploads or marketplace packages. Revoking stops the installations it
 *   signed until they are tried again with another registered key; a revoked key cannot come back.
 * - On the marketplace (decision 2026-10-17, contract §27, `--marketplace`): a test report signed with
 *   a key the developer account registered shows as `verified` to reviewers, any other key as
 *   `unregistered_key`.
 */

interface KeyView {
  name: string;
  publicKey: string;
  fingerprint: string;
  addedBy?: string;
  createdAt?: string;
}

/** A key registered on an Olan server (`GET /api/v2/apps/developer/keys`). */
export interface ServerKeyView {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  revokedAt: string | null;
}

/** The Olan server's developer key routes (decision 2026-10-18). */
export const SERVER_KEYS_PATH = '/api/v2/apps/developer/keys';

const USAGE = [
  'olan-app keys register [--server <url>] [--token <token>] [--name <name>]',
  '       olan-app keys list [--server <url>] [--token <token>]',
  '       olan-app keys revoke <id> [--server <url>] [--token <token>]',
  '       olan-app keys register --marketplace [url] [--developer <slug>] [--name <name>]',
  '       olan-app keys list --marketplace [url] [--developer <slug>]',
  '       olan-app keys remove --marketplace [url] [--developer <slug>] <fingerprint>',
].join('\n');

const SERVER_HINTS: Record<string, string> = {
  developer_access_disabled: 'Developer keys need the developer capability on this server (Admin → Geliştiriciler).',
  forbidden: 'Developer keys need the developer capability on this server (Admin → Geliştiriciler).',
  app_route_forbidden: 'App tokens cannot manage developer keys; use your own sign-in token.',
  cli_route_forbidden: 'This server does not accept CLI tokens for developer keys yet; use the access token of your Olan sign-in.',
  not_found: 'This server has no developer key routes (it needs a newer Olan); a local Olan can trust the key with OLAN_APPS_TRUSTED_KEYS instead (`olan-app keygen --dev`).',
  key_exists: 'This key is already registered with your account. A revoked key cannot be registered again: create a new one with `olan-app keygen --dev --force`.',
  key_not_found: '`olan-app keys list` shows your keys and their ids.',
  too_many_keys: 'Revoke keys you no longer use (`olan-app keys revoke <id>`).',
};

/** The public key name the account shows: --name, else this computer's name. */
function keyName(value: string | undefined, onEmpty: () => never = () => marketplaceFail('invalid_option', '--name must not be empty')): string {
  const name = (value ?? `olan-app on ${hostname()}`).trim().slice(0, 64);
  if (!name) onEmpty();
  return name;
}

export const keysCommand: Command = {
  name: 'keys',
  summary: 'Register your development key on your Olan server (development installations) or a marketplace developer account (--marketplace)',
  usage: USAGE,
  options: [
    'register             Register the public half of ~/.olan/olan-app-dev.key.json (created on first use;',
    '                     OLAN_APP_DEV_KEY overrides). On the Olan server it signs your own development',
    '                     installations in your organization (`olan-app try`, Studio "Bu kurumda dene");',
    '                     with --marketplace, reports from `olan-app test --report` show as verified',
    'list                 Your keys on the Olan server (or the marketplace developer account)',
    'revoke <id>          Olan server: revoke a key for good; development installations it signed stop',
    'remove <fingerprint> --marketplace: remove a key (account owners and admins)',
    '--server <url>       Olan API address (default: OLAN_SERVER, then OLAN_API_URL; the same as `olan-app try`)',
    '--token <token>      Access token (default: OLAN_TOKEN, the same token `olan-app try` uses)',
    '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, the session\'s, https://marketplace.olan.app)',
    '--developer <slug>   --marketplace: developer account (default: your only account)',
    '--name <name>        Name shown with the key (default: "olan-app on <computer name>")',
    '',
    '--json prints the server or marketplace answer unchanged.',
  ],
  spec: { optionalUrls: ['marketplace'], strings: ['developer', 'name', 'server', 'token'] },
  async run(args, context) {
    // Without --marketplace: the signed-in Olan server (decision 2026-10-18).
    if (args.flags.marketplace === undefined || args.flags.marketplace === false) return serverKeys(args, context);
    const [action, fingerprint, extra] = args.positionals;
    if (action !== 'register' && action !== 'list' && action !== 'remove') {
      marketplaceFail('action_required', 'Choose an action: olan-app keys register|list|remove', 'olan-app keys register --marketplace --developer <slug>');
    }
    if ((action === 'remove' && (!fingerprint || extra !== undefined)) || (action !== 'remove' && fingerprint !== undefined)) {
      marketplaceFail('invalid_option', action === 'remove' ? 'keys remove needs one <fingerprint> (`olan-app keys list` shows them)' : `keys ${action} takes no arguments`);
    }
    if (action !== 'register' && stringFlag(args, 'name') !== undefined) marketplaceFail('invalid_option', '--name applies to keys register only');
    const flag = requireMarketplaceFlag(args.flags.marketplace, USAGE);
    const { url, session } = await requireSession(flag, context.env);
    const developer = await pickDeveloper(url, session.token, stringFlag(args, 'developer'), (slug) => `olan-app keys ${action} --marketplace --developer ${slug}`, context.log);
    const base = `/api/v1/developer/accounts/${encodeURIComponent(developer)}/keys`;

    if (action === 'list') {
      const listed = await marketplaceRequest<{ keys: KeyView[] }>(url, base, { token: session.token });
      const local = localPublicKey(context.env);
      return {
        result: listed,
        raw: true,
        human: [
          `Developer keys of ${developer} on ${url}:`,
          ...(listed.keys.length
            ? listed.keys.map((key) => `  ${key.fingerprint}  ${key.name}${key.createdAt ? ` (added ${key.createdAt.slice(0, 10)})` : ''}${key.publicKey === local ? '  ← this computer' : ''}`)
            : ['  none: register this computer\'s key with `olan-app keys register --marketplace`']),
        ],
      };
    }
    if (action === 'remove') {
      await marketplaceRequest(url, `${base}/${encodeURIComponent(fingerprint!)}`, { method: 'DELETE', token: session.token });
      return { result: { removed: { developer, fingerprint } }, raw: true, human: [`Removed key ${fingerprint} from ${developer} on ${url}`] };
    }

    const devKey = ensureDevKey(context.env);
    const added = await marketplaceRequest<{ key: KeyView }>(url, base, { method: 'POST', token: session.token, json: { name: keyName(stringFlag(args, 'name')), publicKey: devKey.key.publicKey } });
    return {
      result: added,
      raw: true,
      human: [
        `Registered key ${added.key.fingerprint} ("${added.key.name}") with ${developer} on ${url}`,
        ...(devKey.created ? [`  Created the development key ${devKey.path} (keep it private; only its public half was sent)`] : []),
        '  Reports from `olan-app test --report <file>` signed with it show as verified to reviewers.',
      ],
    };
  },
};

/** `--server`/`OLAN_SERVER`/`OLAN_API_URL` and `--token`/`OLAN_TOKEN`, as for `olan-app try`. */
function serverAuth(args: ParsedArgs, env: NodeJS.ProcessEnv): { server: string; token: string } {
  const server = stringFlag(args, 'server') ?? env.OLAN_SERVER ?? env.OLAN_API_URL;
  if (!server) fail('keys.server_required', 'No server: pass --server <url> or set OLAN_SERVER', { hint: 'The Olan API address, e.g. http://localhost:4000 (the same server as `olan-app try`); add --marketplace for marketplace keys.' });
  const token = stringFlag(args, 'token') ?? env.OLAN_TOKEN;
  if (!token) fail('keys.token_required', 'No access token: pass --token or set OLAN_TOKEN', { hint: 'Use the access token of your Olan sign-in, as for `olan-app try`.' });
  return { server: server.replace(/\/+$/, ''), token };
}

/** One request to the Olan server's developer key routes; refusals become `keys.<error>` issues with hints. */
export async function serverKeysRequest<T>(
  server: string, token: string, path: string, init: { method?: string; json?: unknown } = {}, fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = `${server}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch (error) {
    fail('keys.network', `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`, { hint: 'Check --server (the Olan API address, e.g. http://localhost:4000).' });
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok) throw new CliError(serverIssues(response.status, body, 'keys', SERVER_HINTS));
  return body as T;
}

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : '');

/** `olan-app keys register|list|revoke` on the signed-in Olan server (decision 2026-10-18). */
async function serverKeys(args: ParsedArgs, context: CommandContext): Promise<CommandOutput> {
  const [action, id, extra] = args.positionals;
  if (action === 'remove') {
    fail('keys.invalid_option', 'keys remove is for marketplace keys (--marketplace); on your Olan server use `olan-app keys revoke <id>`');
  }
  if (action !== 'register' && action !== 'list' && action !== 'revoke') {
    fail('keys.action_required', 'Choose an action: olan-app keys register|list|revoke', { hint: 'Without --marketplace the keys live on your Olan server (OLAN_SERVER); add --marketplace for a marketplace developer account.' });
  }
  if ((action === 'revoke' && (!id || extra !== undefined)) || (action !== 'revoke' && id !== undefined)) {
    fail('keys.invalid_option', action === 'revoke' ? 'keys revoke needs one <id> (`olan-app keys list` shows them)' : `keys ${action} takes no arguments`);
  }
  if (action !== 'register' && stringFlag(args, 'name') !== undefined) fail('keys.invalid_option', '--name applies to keys register only');
  if (stringFlag(args, 'developer') !== undefined) fail('keys.invalid_option', '--developer applies to --marketplace only');
  const { server, token } = serverAuth(args, context.env);

  if (action === 'list') {
    const listed = await serverKeysRequest<{ keys: ServerKeyView[] }>(server, token, SERVER_KEYS_PATH);
    const local = localPublicKey(context.env);
    return {
      result: listed,
      raw: true,
      human: [
        `Your developer keys on ${server}:`,
        ...(listed.keys.length
          ? listed.keys.map((key) => `  ${key.fingerprint}  ${key.name}  id ${key.id}  (added ${day(key.createdAt)}${key.revokedAt ? `, revoked ${day(key.revokedAt)}` : ''})${key.publicKey === local ? '  ← this computer' : ''}`)
          : ['  none: register this computer\'s key with `olan-app keys register`']),
      ],
    };
  }
  if (action === 'revoke') {
    const revoked = await serverKeysRequest<{ key: ServerKeyView }>(server, token, `${SERVER_KEYS_PATH}/${encodeURIComponent(id!)}`, { method: 'DELETE' });
    return {
      result: revoked,
      raw: true,
      human: [
        `Revoked key ${revoked.key.fingerprint} ("${revoked.key.name}") on ${server}`,
        '  Development installations signed with it stop until you try them again with another registered key.',
      ],
    };
  }
  const devKey = ensureDevKey(context.env);
  const name = keyName(stringFlag(args, 'name'), () => fail('keys.invalid_option', '--name must not be empty'));
  const added = await serverKeysRequest<{ key: ServerKeyView }>(server, token, SERVER_KEYS_PATH, { method: 'POST', json: { name, publicKey: devKey.key.publicKey } });
  return {
    result: added,
    raw: true,
    human: [
      `Registered key ${added.key.fingerprint} ("${added.key.name}") on ${server}`,
      ...(devKey.created ? [`  Created the development key ${devKey.path} (keep it private; only its public half was sent)`] : []),
      '  It signs your own development installations in your organization there (`olan-app try`, Studio "Bu kurumda dene");',
      '  never catalog uploads or marketplace packages.',
    ],
  };
}

/** The local development key's public half when the key file exists (never creates one). */
function localPublicKey(env: NodeJS.ProcessEnv): string | null {
  const path = devKeyPath(env);
  if (!existsSync(path)) return null;
  try {
    return readSigningKey(path).key.publicKey;
  } catch {
    return null;
  }
}
