import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { JsonValue } from '@olan-app/schema';

import { integerFlag, stringFlag, type ParsedArgs } from '../args';
import type { Command } from '../command';
import { CliError, fail, issue } from '../errors';
import { requireManifest, requireProjectDir } from '../project';
import { DEV_ISSUER_PORT, callDevTool, sendDevEvent, sendDevRequest } from '../remote-dev';

/** `--data '{"a":1}'` or `--data @fixtures/event.json`. */
export function jsonArgument(value: string | undefined, name: string, cwd: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  let text = value;
  if (value.startsWith('@')) {
    const path = resolve(cwd, value.slice(1));
    if (!existsSync(path)) fail('cli.invalid_option', `--${name}: ${value.slice(1)} does not exist`);
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    fail('cli.invalid_option', `--${name} must be JSON (or @file.json): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function subcommand(args: ParsedArgs, expected: string, usage: string): string {
  const [action, target, ...extra] = args.positionals;
  if (action !== expected || !target || extra.length > 0) fail('cli.usage', `Usage: ${usage}`);
  return target;
}

export const eventsCommand: Command = {
  name: 'events',
  summary: "Send a signed event to the app's own server (dev key, local JWKS), like Olan's webhooks",
  usage: 'olan-app events send <type> [--to <url>] [--data <json|@file>] [--installation <id>] [--attempt <n>] [--id <evt_…>] [--issuer-port <port>]',
  options: [
    '--to <url>          App server base URL (default: olan-app.json remote.url); posts to <url>/events',
    '--data <json|@file> Event data (default: built from fixtures/*.json)',
    '--installation <id> olan-installation-id (default 00000000-0000-4000-8000-0000000000a1)',
    '--attempt <n>       olan-delivery-attempt (default 1); --id reuses a webhook-id like a redelivery',
    `--issuer-port <n>   Port of the local issuer (default ${DEV_ISSUER_PORT}): the app server must allow`,
    `                    the issuer http://127.0.0.1:${DEV_ISSUER_PORT} (createOlanServer({ issuers }))`,
  ],
  spec: { strings: ['to', 'data', 'installation', 'attempt', 'id', 'issuer-port'] },
  async run(args, context) {
    const type = subcommand(args, 'send', this.usage);
    const dir = requireProjectDir(context.cwd);
    const manifest = requireManifest(dir);
    const result = await sendDevEvent(dir, manifest, {
      type,
      to: stringFlag(args, 'to'),
      data: jsonArgument(stringFlag(args, 'data'), 'data', context.cwd),
      installationId: stringFlag(args, 'installation'),
      attempt: integerFlag(args, 'attempt', 1, 1, 100),
      id: stringFlag(args, 'id'),
      issuerPort: integerFlag(args, 'issuer-port', DEV_ISSUER_PORT, 0, 65535),
      env: context.env,
    });
    const summary = { eventId: result.event.id, type, url: result.delivery.url, issuer: result.issuer, keyId: result.keyId, status: result.delivery.status, durationMs: result.delivery.durationMs, response: result.delivery.json ?? result.delivery.body };
    if (!result.delivery.ok) {
      throw new CliError(
        issue('events.delivery_failed', `${result.delivery.url} answered ${result.delivery.status}; Olan would retry (410 stops retries)`, {
          hint: result.delivery.status === 401 ? `Did the app server allow the issuer ${result.issuer}? Response: ${result.delivery.body.slice(0, 200)}` : `Response: ${result.delivery.body.slice(0, 200)}`,
        }),
        { ...summary, warnings: result.warnings },
      );
    }
    return {
      result: { ...summary, event: result.event },
      warnings: result.warnings,
      human: [`${type} ${String(result.event.id)} → ${result.delivery.url}: ${result.delivery.status} in ${result.delivery.durationMs} ms (issuer ${result.issuer}, key ${result.keyId})`],
    };
  },
};

/** `/items?status=a&status=b` → path `/items`, query `{ status: ['a', 'b'] }` (olan.remote.request takes no `?` in the path). */
export function splitRequestPath(target: string): { path: string; query: Record<string, string | string[]> } {
  const mark = target.indexOf('?');
  if (mark === -1) return { path: target, query: {} };
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(target.slice(mark + 1))) {
    const current = query[key];
    query[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return { path: target.slice(0, mark), query };
}

const stringRecord = (value: JsonValue | undefined, name: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    fail('cli.invalid_option', `--${name} must be a JSON object of strings`);
  }
  return value as Record<string, string>;
};

export const requestsCommand: Command = {
  name: 'requests',
  summary: "Send a signed olan.remote.request to the app's own server (remote.url/requests), like Olan does",
  usage:
    'olan-app requests send <METHOD> <path[?query]> [--body <json|@file>] [--query <json>] [--headers <json>] [--user <id>] [--profile | --no-profile] [--role admin|member] [--timeout <ms>] [--to <url>] [--installation <id>] [--issuer-port <port>]',
  options: [
    '<METHOD> <path>      GET, POST, PUT, PATCH or DELETE and the app\'s path, e.g. GET "/items?status=ready"',
    '--body <json|@file>  JSON body (not with GET/DELETE)',
    '--query <json>       Query object ({"status":["a","b"]}); merged over the ?query of the path',
    '--headers <json>     Allowed request headers (accept, accept-language, if-match, if-none-match, idempotency-key)',
    '--user <id>          user.id (default the mock user 00000000-0000-4000-8000-000000000001)',
    '--profile            Add email, displayName and role as with profile:read (default: when the manifest has',
    '                     profile:read; --no-profile leaves them out). --role admin|member (default member)',
    '--timeout <ms>       request.timeoutMs (1000–60000, default 30000)',
    '--to <url>           App server base URL (default: olan-app.json remote.url); posts to <url>/requests',
    `--issuer-port <n>    Port of the local issuer (default ${DEV_ISSUER_PORT}): the app server must allow`,
    `                     the issuer http://127.0.0.1:${DEV_ISSUER_PORT} (createOlanServer({ issuers }))`,
  ],
  spec: { strings: ['body', 'query', 'headers', 'user', 'role', 'timeout', 'to', 'installation', 'issuer-port'], booleans: ['profile'] },
  async run(args, context) {
    const [action, method, target, ...extra] = args.positionals;
    if (action !== 'send' || !method || !target || extra.length > 0) fail('cli.usage', `Usage: ${this.usage}`);
    if (/^[A-Za-z]:[\\/]/.test(target)) {
      // Git Bash (MSYS) turns a leading "/items" into "C:/Program Files/Git/items" before node sees it.
      fail('cli.invalid_option', `The path arrived as "${target}": the shell rewrote it into a Windows path`, {
        hint: 'In Git Bash run `MSYS_NO_PATHCONV=1 npx olan-app requests send …` or write the path as //items; PowerShell and cmd pass /items unchanged.',
      });
    }
    const dir = requireProjectDir(context.cwd);
    const manifest = requireManifest(dir);
    const split = splitRequestPath(target);
    const queryFlag = jsonArgument(stringFlag(args, 'query'), 'query', context.cwd);
    if (queryFlag !== undefined && (typeof queryFlag !== 'object' || queryFlag === null || Array.isArray(queryFlag))) fail('cli.invalid_option', '--query must be a JSON object');
    const query = { ...split.query, ...((queryFlag ?? {}) as Record<string, string | string[]>) };
    const role = stringFlag(args, 'role');
    if (role !== undefined && role !== 'admin' && role !== 'member') fail('cli.invalid_option', '--role must be admin or member');
    const timeout = stringFlag(args, 'timeout');
    const result = await sendDevRequest(dir, manifest, {
      method,
      path: split.path,
      ...(Object.keys(query).length ? { query } : {}),
      body: jsonArgument(stringFlag(args, 'body'), 'body', context.cwd),
      headers: stringRecord(jsonArgument(stringFlag(args, 'headers'), 'headers', context.cwd), 'headers'),
      ...(timeout !== undefined ? { timeoutMs: integerFlag(args, 'timeout', 30_000, 1, 600_000) } : {}),
      to: stringFlag(args, 'to'),
      userId: stringFlag(args, 'user'),
      ...(typeof args.flags.profile === 'boolean' ? { profile: args.flags.profile } : {}),
      ...(role ? { role } : {}),
      installationId: stringFlag(args, 'installation'),
      issuerPort: integerFlag(args, 'issuer-port', DEV_ISSUER_PORT, 0, 65535),
      env: context.env,
    });
    const { forwarded, envelope } = result;
    const summary = {
      requestId: envelope.id,
      method: envelope.request.method,
      path: envelope.request.path,
      url: forwarded.url,
      issuer: result.issuer,
      keyId: result.keyId,
      httpStatus: forwarded.httpStatus,
      durationMs: forwarded.durationMs,
      answer: forwarded.ok ? forwarded.answer : null,
      app: result.outcome,
    };
    if (!forwarded.ok) {
      throw new CliError(
        issue('requests.delivery_failed', `${forwarded.message}: the app sees remote_unavailable (reason ${forwarded.reason})`, {
          hint:
            forwarded.httpStatus === 401
              ? `The app server refused the signature: does it list the issuer ${result.issuer} in createOlanServer({ issuers })? Response: ${forwarded.body.slice(0, 200)}`
              : forwarded.reason === 'network'
                ? 'Start the app server first and check remote.url (or --to).'
                : forwarded.reason === 'invalid_response'
                  ? `Answer HTTP 200 with { "status", "headers"?, "body"? } (handleRequest does). Response: ${forwarded.body.slice(0, 200)}`
                  : `Response: ${forwarded.body.slice(0, 200)}`,
        }),
        { ...summary, warnings: result.warnings },
      );
    }
    const outcome = result.outcome;
    return {
      result: { ...summary, envelope },
      warnings: result.warnings,
      human: [
        `${envelope.request.method} ${envelope.request.path} → ${forwarded.url}: status ${forwarded.answer.status} in ${forwarded.durationMs} ms (issuer ${result.issuer}, key ${result.keyId})`,
        outcome.ok ? '  the app gets the response' : `  the app gets RemoteError ${outcome.error.code} (${outcome.error.message})`,
        JSON.stringify(forwarded.answer, null, 2),
      ],
    };
  },
};

export const toolsCommand: Command = {
  name: 'tools',
  summary: "Call an assistant tool (ai.tools) on the app's own server with a signed request",
  usage: 'olan-app tools call <name> [--input <json|@file>] [--to <url>] [--user <id>] [--channel assistant|mcp] [--issuer-port <port>]',
  options: [
    '--input <json|@file> Tool input (default {}); checked against the tool\'s "input" schema',
    '--to <url>           App server base URL (default: remote.url); posts to <url>/ai-tools/<name>',
    '--user <id>          user.id of the call (default the mock user 00000000-0000-4000-8000-000000000001)',
    '--channel <c>        assistant (default) or mcp',
    `--issuer-port <n>    Port of the local issuer (default ${DEV_ISSUER_PORT}); the embedded token is a dev placeholder`,
  ],
  spec: { strings: ['input', 'to', 'user', 'channel', 'issuer-port', 'installation'] },
  async run(args, context) {
    const name = subcommand(args, 'call', this.usage);
    const dir = requireProjectDir(context.cwd);
    const manifest = requireManifest(dir);
    const input = jsonArgument(stringFlag(args, 'input'), 'input', context.cwd) ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('cli.invalid_option', '--input must be a JSON object');
    const channel = stringFlag(args, 'channel') ?? 'assistant';
    if (channel !== 'assistant' && channel !== 'mcp') fail('cli.invalid_option', '--channel must be assistant or mcp');
    const result = await callDevTool(manifest, {
      name,
      input: input as Record<string, JsonValue>,
      to: stringFlag(args, 'to'),
      userId: stringFlag(args, 'user'),
      channel,
      installationId: stringFlag(args, 'installation'),
      issuerPort: integerFlag(args, 'issuer-port', DEV_ISSUER_PORT, 0, 65535),
      env: context.env,
    });
    const response = result.response as { ok?: boolean; summary?: string; error?: { code: string; message: string } };
    return {
      result: { callId: result.request.id, tool: name, url: result.delivery.url, status: result.delivery.status, durationMs: result.delivery.durationMs, response: result.response },
      human: [
        `${name} → ${result.delivery.url}: ${response.ok ? 'ok' : `error ${response.error?.code}: ${response.error?.message}`} in ${result.delivery.durationMs} ms`,
        ...(response.summary ? [`  summary: ${response.summary}`] : []),
        JSON.stringify(result.response, null, 2),
      ],
    };
  },
};
