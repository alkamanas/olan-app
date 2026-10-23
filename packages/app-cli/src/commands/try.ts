import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { stringFlag } from '../args';
import type { Command } from '../command';
import { ensureDevKey } from '../dev-key';
import { CliError, fail } from '../errors';
import { requireProjectDir } from '../project';
import { packApp } from './pack';
import { discover, serverIssues } from './publish';

/** `POST <server>/api/v2/apps/developer/try`: a dev-signed package installed for the signed-in developer's organization. */
export const TRY_PATH = '/api/v2/apps/developer/try';

export interface TryResult {
  server: string;
  endpoint: string;
  file: string;
  installationId: string;
  appId: string;
  version: string;
  /** `<webOrigin>/apps/<installationId>`, or null when the server publishes no `webOrigin` (Olan before 1.5). */
  appUrl: string | null;
  keyFingerprint: string;
}

const TRY_HINTS: Record<string, string> = {
  developer_required: 'Trying an app needs the developer capability on this server (Admin → Geliştiriciler).',
  forbidden: 'Trying an app needs the developer capability on this server (Admin → Geliştiriciler).',
  not_found: 'This server has no developer try route (it needs Olan 1.5.1 or later); use `olan-app publish --org --dev-sign`.',
  version_exists: 'This version is already on the server with other content. `olan-app try` retries once under the `-dev.N` the server names (servers before this change name none); otherwise bump "version" in olan-app.json, e.g. to 1.2.0-dev.1.',
  package_untrusted_key: 'The server does not trust your development key: register it with `olan-app keys register` (or Studio → Geliştirici anahtarları). A revoked key stays revoked: create a new one with `olan-app keygen --dev --force` and register that. A local Olan can also trust it with the OLAN_APPS_TRUSTED_KEYS line `olan-app keygen --dev` prints.',
};

/**
 * `olan-app try`: packs the app (validate + build, like `pack`), signs it with the development key
 * and uploads it to `<server>/api/v2/apps/developer/try` (multipart field `package`, bearer token:
 * the same server and token as `publish --org`). The server installs it for the person's
 * organization and answers `{ installationId, appId, version }`. When the version is already in the
 * organization's catalog with other content, the server's `409 version_exists` names `nextVersion`
 * (`<version>-dev.N`): the CLI packs and signs once more under that version and retries once.
 */
export async function tryApp(
  projectDir: string,
  options: { server: string; token: string; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<TryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const server = options.server.replace(/\/+$/, '');
  const devKey = ensureDevKey(options.env);
  let packed = await packApp(projectDir, { signKey: devKey.path });
  const wellKnown = await discover(server, fetchImpl);
  if (wellKnown?.apps && wellKnown.apps.enabled === false) fail('try.apps_disabled', `Olan Apps are disabled on ${server}`);
  const endpoint = `${server}${TRY_PATH}`;
  const upload = async (packedFile: string): Promise<{ response: Response; body: Record<string, unknown> | null }> => {
    const file = resolve(projectDir, packedFile);
    const form = new FormData();
    form.append('package', new Blob([readFileSync(file)], { type: 'application/octet-stream' }), basename(file));
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' }, body: form });
    } catch (error) {
      fail('try.network', `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, { hint: 'Check --server (the Olan API address, e.g. http://localhost:4000).' });
    }
    try {
      return { response, body: (await response.json()) as Record<string, unknown> };
    } catch {
      return { response, body: null };
    }
  };
  let { response, body } = await upload(packed.file);
  // A changed build under a version the catalog already holds: the server names the next free
  // `<version>-dev.N`. The manifest is signed, so the CLI re-packs and re-signs under that version
  // (olan-app.json on disk stays as it is) and uploads once more.
  const nextVersion = response.status === 409 && body?.error === 'version_exists' && typeof body.nextVersion === 'string' ? body.nextVersion : null;
  if (nextVersion) {
    packed = await packApp(projectDir, { signKey: devKey.path, version: nextVersion, build: false, validate: false });
    ({ response, body } = await upload(packed.file));
  }
  const file = resolve(projectDir, packed.file);
  if (!response.ok) throw new CliError(serverIssues(response.status, body, 'try', TRY_HINTS));
  if (typeof body?.installationId !== 'string') fail('try.invalid_response', `${endpoint} answered ${response.status} without an installationId`);
  let appUrl: string | null = null;
  if (typeof wellKnown?.webOrigin === 'string') {
    try {
      appUrl = `${new URL(wellKnown.webOrigin).origin}/apps/${encodeURIComponent(body.installationId)}`;
    } catch {
      appUrl = null;
    }
  }
  return {
    server,
    endpoint,
    file: basename(file),
    installationId: body.installationId,
    appId: typeof body.appId === 'string' ? body.appId : '',
    version: typeof body.version === 'string' ? body.version : '',
    appUrl,
    keyFingerprint: devKey.fingerprint,
  };
}

export const tryCommand: Command = {
  name: 'try',
  summary: 'Pack, sign with your development key and install the app in your organization on a development server',
  usage: 'olan-app try [--server <url>] [--token <token>]',
  options: [
    '--server <url>  Olan API address (default: OLAN_SERVER, then OLAN_API_URL; the same as `publish --org`)',
    '--token <token> Access token (default: OLAN_TOKEN, the same token `publish --org` uses)',
    '                You need developer access, and your development key registered on the server',
    '                (`olan-app keys register`) or on its trusted key list (OLAN_APPS_TRUSTED_KEYS)',
  ],
  spec: { strings: ['server', 'token'] },
  async run(args, context) {
    const projectDir = requireProjectDir(context.cwd);
    const server = stringFlag(args, 'server') ?? context.env.OLAN_SERVER ?? context.env.OLAN_API_URL;
    if (!server) fail('try.server_required', 'No server: pass --server <url> or set OLAN_SERVER', { hint: 'The Olan API address, e.g. http://localhost:4000 (the same server as `olan-app publish --org`).' });
    const token = stringFlag(args, 'token') ?? context.env.OLAN_TOKEN;
    if (!token) fail('try.token_required', 'No access token: pass --token or set OLAN_TOKEN', { hint: 'Use the access token of your Olan sign-in, as for `olan-app publish --org`.' });
    const result = await tryApp(projectDir, { server, token, env: context.env });
    return {
      result,
      human: [
        `Installed ${result.appId || result.file} ${result.version} for your organization (installation ${result.installationId}, development key ${result.keyFingerprint})`,
        result.appUrl ? `Open: ${result.appUrl}` : 'Open it in Olan → Uygulamalar (this server publishes no webOrigin).',
      ],
    };
  },
};
