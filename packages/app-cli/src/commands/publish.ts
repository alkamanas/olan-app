import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { CliError, fail, issue, type Issue } from '../errors';
import { devKeyAdvice, ensureDevKey } from '../dev-key';
import { requireProjectDir } from '../project';
import { packApp } from './pack';
import { publishToMarketplace } from './publish-marketplace';

export interface PublishResult {
  server: string;
  endpoint: string;
  file: string;
  app: unknown;
  version: unknown;
  /** The server's verdict on the uploaded version (`trusted`, `unsigned`, `untrusted_key`), or null when it did not say. */
  trust: VersionTrust | null;
}

interface VersionTrust {
  status: 'trusted' | 'unsigned' | 'untrusted_key';
  keyName: string | null;
  keyFingerprint: string | null;
}

interface WellKnown {
  catalogUrl?: string;
  /** Origin of Olan's web app (Olan 1.5+). */
  webOrigin?: string;
  apps?: { enabled?: boolean; maxPackageBytes?: number; trustedKeyFingerprints?: string[] };
}

/** `<server>/.well-known/olan` (contract §6), or null when the server does not publish it. */
export async function discover(server: string, fetchImpl: typeof fetch = fetch): Promise<WellKnown | null> {
  try {
    const response = await fetchImpl(`${server}/.well-known/olan`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return (await response.json()) as WellKnown;
  } catch {
    return null;
  }
}

export function packagesEndpoint(server: string, wellKnown: WellKnown | null): string {
  const catalog = wellKnown?.catalogUrl?.replace(/\/+$/, '');
  return catalog ? `${catalog}/packages` : `${server}/api/v2/apps/catalog/packages`;
}

/** A failed upload answer as issues: package issues one by one, else `<prefix>.<error>` with a hint. */
export function serverIssues(status: number, body: Record<string, unknown> | null, prefix = 'publish', extraHints: Record<string, string> = {}): Issue[] {
  const code = typeof body?.error === 'string' ? body.error : `http_${status}`;
  if (code === 'package_invalid' && Array.isArray(body?.issues)) {
    return (body.issues as { code?: string; path?: string; message?: string; hint?: string }[]).map((item) =>
      issue(item.code ?? 'package.invalid', item.message ?? 'The server rejected the package', { file: item.path?.split('#')[0] || undefined, hint: item.hint }),
    );
  }
  const hints: Record<string, string> = {
    unauthorized: 'The token is missing or expired; sign in again (`olan auth login`) and run `olan app publish --org`.',
    forbidden: 'Only organization admins can upload to the catalog.',
    admin_required: 'Only organization admins can upload to the catalog.',
    version_exists: 'This version is already in the catalog; bump "version" in olan-app.json.',
    app_kind_conflict: 'An app with this id exists as a web link; choose another id.',
    app_route_forbidden: 'App tokens cannot publish; use your own sign-in token.',
    package_unsigned: 'Unsigned packages do not install. Sign with `olan-app pack --dev-sign` for a local Olan; production needs Olan Marketplace signing.',
    package_untrusted_key: 'The signing key is not on the server\'s OLAN_APPS_TRUSTED_KEYS list.',
    ...extraHints,
  };
  const message = typeof body?.message === 'string' ? `: ${body.message}` : '';
  return [issue(`${prefix}.${code}`, `The server answered ${status} ${code}${message}`, { hint: hints[code] ?? (status === 401 ? hints.unauthorized : undefined) })];
}

/**
 * `olan-app publish --org`: packs (unless `--file`) and uploads the `.olanapp` to the
 * organization catalog of `--server` (multipart field `package`, bearer token; tenant admins).
 */
export async function publishApp(
  projectDir: string,
  options: { server: string; token: string; file?: string; fetchImpl?: typeof fetch; signKey?: string },
): Promise<PublishResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const server = options.server.replace(/\/+$/, '');
  const file = options.file ? resolve(projectDir, options.file) : resolve(projectDir, (await packApp(projectDir, { signKey: options.signKey })).file);
  if (!existsSync(file)) fail('publish.file_missing', `${file} does not exist`, { hint: 'Run `olan-app pack` first or drop --file.' });
  const wellKnown = await discover(server, fetchImpl);
  if (wellKnown?.apps && wellKnown.apps.enabled === false) fail('publish.apps_disabled', `Olan Apps are disabled on ${server}`);
  const endpoint = packagesEndpoint(server, wellKnown);
  const form = new FormData();
  form.append('package', new Blob([readFileSync(file)], { type: 'application/zip' }), basename(file));
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' }, body: form });
  } catch (error) {
    fail('publish.network', `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, { hint: 'Check --server (the Olan API address, e.g. https://api.olan.app).' });
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok) throw new CliError(serverIssues(response.status, body));
  const version = (body?.version ?? null) as { trust?: VersionTrust | null } | null;
  return { server, endpoint, file: basename(file), app: body?.app ?? null, version, trust: version?.trust ?? null };
}

/** Warnings for an upload the server accepted but will not install (decision 2026-10-17). */
export function trustWarnings(trust: VersionTrust | null): Issue[] {
  if (!trust || trust.status === 'trusted') return [];
  if (trust.status === 'unsigned') {
    return [issue('publish.package_unsigned', 'Uploaded, but the version is unsigned: it is listed in the catalog and cannot be installed', {
      hint: 'For a local Olan sign with `olan-app publish --org --dev-sign` (and trust the key, see `olan-app keygen --dev`); production installs need Olan Marketplace signing.',
    })];
  }
  return [issue('publish.package_untrusted_key', `Uploaded, but key ${trust.keyFingerprint ?? ''} is not trusted by this server: the version cannot be installed`, {
    hint: 'Add the key to the server\'s OLAN_APPS_TRUSTED_KEYS (development servers only) or sign with a key it trusts.',
  })];
}

export const publishCommand: Command = {
  name: 'publish',
  summary: 'Submit the app to Olan Marketplace (--marketplace) or upload it to a development server catalog (--org)',
  usage: [
    'olan-app publish --marketplace [url] [--developer <slug>] [--channel stable|beta] [--percent N]',
    '                 [--visibility public|org|organization:<serverId>/<organizationId>] [--file <pkg.olanapp>]',
    '                 [--test-report <report.json>] [--age-rating 4+|9+|13+] [--no-wait]',
    'olan-app publish --org [--server <url>] [--token <token>] [--file <pkg.olanapp>] [--dev-sign]',
  ].join('\n'),
  options: [
    '--marketplace [url]  Submit to Olan Marketplace for checks and review (production; needs `olan-app login --marketplace`',
    '                  or OLAN_MARKETPLACE_SESSION). URL default: OLAN_MARKETPLACE_URL, the session\'s,',
    '                  OLAN_SERVER\'s /.well-known/olan marketplaceUrl, https://marketplace.olan.app',
    '--developer <slug> Developer account for a new app (default: your only account)',
    '--channel <name>  Release to stable or beta when approved; --percent N stages the rollout (1-100)',
    '--visibility <v>  public (default), org (your organization on your Olan server, from the session) or',
    '                  organization:<serverId>/<organizationId> (new apps only)',
    '--test-report <f> Attach a signed report from `olan-app test --report <f>` (made after packing, same package)',
    '--age-rating <r>  Set the app\'s age rating (4+, 9+ or 13+; required before release) after uploading;',
    '                  same as `olan-app app set --marketplace <appId> --age-rating <r>`',
    '--no-wait         Do not wait for the automatic checks (default: wait, exit 1 on checks_failed)',
    '--org             Upload to the organization catalog of the signed-in account (development and offline',
    '                  servers; it installs only if signed with a key the server trusts; production: --marketplace)',
    '--dev-sign        Pack and sign with your local development key (see `olan-app keygen --dev`)',
    '--server <url>    Olan API address (default: OLAN_SERVER, then OLAN_API_URL)',
    '--token <token>   Access token (default: OLAN_TOKEN; `olan app publish` sets it)',
    '--file <file>     Upload an existing package instead of packing',
  ],
  spec: {
    booleans: ['org', 'dev-sign', 'wait'],
    strings: ['server', 'token', 'file', 'developer', 'channel', 'percent', 'visibility', 'test-report', 'age-rating'],
    optionalUrls: ['marketplace'],
  },
  async run(args, context) {
    const marketplace = args.flags.marketplace !== undefined && args.flags.marketplace !== false;
    if (marketplace && booleanFlag(args, 'org')) fail('publish.target_conflict', 'Choose one target: --marketplace or --org');
    if (marketplace) return publishToMarketplace(args, context);
    if (!booleanFlag(args, 'org')) {
      fail('publish.target_required', 'Choose where to publish: --marketplace (Olan Marketplace) or --org (a development server\'s catalog)', {
        hint: 'Production apps go through `olan-app publish --marketplace` (sign in first: `olan-app login --marketplace`).',
      });
    }
    for (const name of ['developer', 'channel', 'percent', 'visibility', 'test-report', 'age-rating']) {
      if (stringFlag(args, name) !== undefined) fail('publish.marketplace_option', `--${name} applies to --marketplace only`);
    }
    const projectDir = requireProjectDir(context.cwd);
    const server = stringFlag(args, 'server') ?? context.env.OLAN_SERVER ?? context.env.OLAN_API_URL;
    if (!server) fail('publish.server_required', 'No server: pass --server <url> or set OLAN_SERVER', { hint: '`olan app publish --org` passes the signed-in server automatically.' });
    const token = stringFlag(args, 'token') ?? context.env.OLAN_TOKEN;
    if (!token) fail('publish.token_required', 'No access token: pass --token or set OLAN_TOKEN', { hint: 'Run `olan app publish --org` with the Olan CLI signed in; it sets OLAN_TOKEN for you.' });
    const devSign = booleanFlag(args, 'dev-sign');
    if (devSign && stringFlag(args, 'file')) fail('publish.dev_sign_file', '--dev-sign packs and signs; it cannot be combined with --file');
    const devKey = devSign ? ensureDevKey(context.env) : null;
    const result = await publishApp(projectDir, { server, token, file: stringFlag(args, 'file'), signKey: devKey?.path });
    const trusted = result.trust?.status === 'trusted';
    return {
      result,
      warnings: trustWarnings(result.trust),
      human: [
        `Uploaded ${result.file} to ${result.endpoint}`,
        ...(trusted ? [`  Signed with trusted key ${result.trust!.keyName}: administrators can install it.`] : []),
        ...(devKey && !trusted ? devKeyAdvice(devKey) : []),
      ],
    };
  },
};
