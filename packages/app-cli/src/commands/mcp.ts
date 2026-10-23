import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EVENT_TYPES, SURFACES, type JsonValue } from '@olan-app/schema';

import type { Command } from '../command';
import { CliError, toIssue } from '../errors';
import { searchDocs } from '../docs-search';
import { requireProjectDir } from '../project';
import { renderApp, type RenderedApp } from '../testing';
import { DEV_ISSUER_PORT, callDevTool, sendDevEvent, sendDevRequest } from '../remote-dev';
import { splitRequestPath } from './remote';
import { requireManifest } from '../project';
import { CLI_VERSION } from '../version';
import { buildApp } from './build';
import { runTests } from './test';
import { validateApp } from './validate';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function json(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return json({ ok: true, result: await run() });
  } catch (error) {
    const result = error instanceof CliError ? error.result : undefined;
    return json({ ok: false, errors: toIssue(error), ...(result !== undefined ? { result } : {}) }, true);
  }
}

/**
 * Tools for Claude Code and Codex (`olan-app mcp`, stdio). They run in the app directory the
 * server was started in (or `dir`). `olan_app_render` keeps the rendered app as the current
 * session; `olan_app_dispatch` and `olan_app_logs` act on it.
 */
export function createMcpServer(baseDir: string, env: NodeJS.ProcessEnv = process.env): { server: McpServer; dispose(): Promise<void> } {
  const server = new McpServer({ name: 'olan-app', version: CLI_VERSION });
  let session: { app: RenderedApp; surface: string } | null = null;
  let lastBuild: unknown = null;
  let lastTest: unknown = null;
  const dirArg = { dir: z.string().optional().describe('App directory (default: where the MCP server runs)') };
  const projectOf = (dir?: string) => requireProjectDir(dir ? resolve(baseDir, dir) : baseDir);
  const view = (app: RenderedApp, surface: string) => ({
    surface,
    tree: app.snapshot(),
    text: app.text(),
    calls: app.calls(),
    toasts: app.toasts(),
    navigation: app.navigation(),
    errors: app.errors(),
  });
  const closeSession = async () => {
    if (session) await session.app.dispose();
    session = null;
  };

  server.registerTool(
    'olan_app_validate',
    {
      description: 'Validate the Olan app: manifest, build, size, TypeScript; strict (default) also renders every surface with the mock host and checks component props, labels, keys and missing permissions. Done = ok: true.',
      inputSchema: { ...dirArg, strict: z.boolean().optional().describe('Render surfaces too (default true)') },
    },
    async ({ dir, strict }) =>
      guarded(async () => {
        const { result, errors, warnings } = await validateApp(projectOf(dir), { strict: strict !== false });
        if (errors.length > 0) throw new CliError(errors, { ...result, warnings });
        return { ...result, warnings };
      }),
  );

  server.registerTool(
    'olan_app_build',
    { description: 'Bundle src/app.tsx into dist/app.js; returns size, build id and the largest inputs or build errors with file:line.', inputSchema: dirArg },
    async ({ dir }) =>
      guarded(async () => {
        const output = await buildApp(projectOf(dir));
        lastBuild = output;
        return output;
      }),
  );

  server.registerTool(
    'olan_app_test',
    { description: 'Run tests/**/*.test.ts (node:test + @olan-app/cli/testing) against the mock Olan host; returns pass/fail counts and failure messages.', inputSchema: { ...dirArg, pattern: z.string().optional().describe('Only files whose path contains this') } },
    async ({ dir, pattern }) =>
      guarded(async () => {
        const summary = await runTests(projectOf(dir), { pattern });
        lastTest = summary;
        if (summary.failed > 0) throw new CliError(summary.failures.map((failure) => ({ code: 'test.failed', message: `${failure.name}: ${failure.message}`, file: failure.file })), summary);
        return summary;
      }),
  );

  server.registerTool(
    'olan_app_render',
    {
      description: 'Render a surface headlessly with the mock host and return the UI tree (JSON), visible text, olan.* calls, toasts, navigation and errors. Becomes the session for olan_app_dispatch.',
      inputSchema: {
        ...dirArg,
        surface: z.enum(SURFACES).optional().describe('Default app'),
        params: z.any().optional().describe('init params (default: built from the fixtures for the surface, e.g. { "projectId": "p0" } for project.widget, { projectId, task } of the first task for task.action, the app\'s first record link for record.card, the first fixtures/mail.json message for mail.sidebar)'),
        permissions: z.array(z.string()).optional().describe('Granted permissions (default: the manifest permissions)'),
        fixtures: z.record(z.string(), z.any()).optional().describe('Fixture overrides: projects, conversations, messages, settings, storage, http, db ({ "<collection>": [{ "data": { … } }] }), users ([{ id, displayName, email, title?, department?, team? }]), calendars, calendarEvents, addressBooks, contacts, mail, meetings'),
        settings: z.record(z.string(), z.any()).optional(),
        userId: z.string().optional().describe('Signed-in user: context.user.id / useUser().id and the mock host user (default 00000000-0000-4000-8000-000000000001, "Utku"); olan.db createdBy, rules and user collections depend on it'),
        locale: z.string().optional(),
        theme: z.enum(['light', 'dark']).optional(),
        now: z.string().optional().describe('Freeze the clock (ISO date-time)'),
      },
    },
    async (input) =>
      guarded(async () => {
        await closeSession();
        const surface = input.surface ?? 'app';
        const app = await renderApp({
          root: projectOf(input.dir),
          surface,
          params: input.params as JsonValue | undefined,
          permissions: input.permissions,
          fixtures: input.fixtures,
          settings: input.settings as Record<string, JsonValue> | undefined,
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          locale: input.locale,
          theme: input.theme,
          now: input.now,
          allowErrors: true,
        });
        session = { app, surface };
        return view(app, surface);
      }),
  );

  server.registerTool(
    'olan_app_dispatch',
    {
      description: 'Interact with the rendered session (olan_app_render first): press a label (Button, List item title, Menu item, action, Form submit), fill/select a field by label, submit a form or go back. Returns the new tree.',
      inputSchema: {
        action: z.enum(['press', 'fill', 'select', 'submit', 'back']),
        label: z.string().optional().describe('Label to press, or the field label for fill/select'),
        value: z.string().optional().describe('Value for fill/select'),
      },
    },
    async ({ action, label, value }) =>
      guarded(async () => {
        if (!session) throw new CliError({ code: 'mcp.no_session', message: 'Nothing is rendered; call olan_app_render first' });
        const { app } = session;
        const need = (field: string | undefined, name: string) => {
          if (field === undefined) throw new CliError({ code: 'mcp.invalid_input', message: `${action} needs ${name}` });
          return field;
        };
        if (action === 'press') await app.press(need(label, 'label'));
        else if (action === 'fill') await app.fill(need(label, 'label'), need(value, 'value'));
        else if (action === 'select') await app.select(need(label, 'label'), need(value, 'value'));
        else if (action === 'submit') await app.submit(label);
        else await app.back();
        return view(app, session.surface);
      }),
  );

  server.registerTool(
    'olan_app_db',
    {
      description:
        "The rendered session's mock app database (olan.db; olan_app_render first): collections with row counts, usage, and the rows of one collection (every user's, with owner), optionally filtered by exact field values. Use it to check what the app wrote.",
      inputSchema: {
        collection: z.string().optional().describe('Collection whose rows to return (default: only the summary)'),
        where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Exact matches on data fields or id/createdBy/createdAt/updatedAt'),
        limit: z.number().int().min(1).max(500).optional().describe('Most rows to return (default 50, newest first)'),
      },
    },
    async ({ collection, where, limit }) =>
      guarded(async () => {
        if (!session) throw new CliError({ code: 'mcp.no_session', message: 'Nothing is rendered; call olan_app_render first' });
        const db = session.app.host.db;
        const schema = db.schema;
        const all = db.rows();
        const collections = Object.entries(schema?.collections ?? {}).map(([name, definition]) => ({
          name,
          scope: definition.scope,
          rowCount: all.filter((row) => row.collection === name).length,
        }));
        const summary = { collections, usage: db.usage() };
        if (collection === undefined) return summary;
        if (!schema || !Object.prototype.hasOwnProperty.call(schema.collections, collection)) {
          throw new CliError({ code: 'mcp.invalid_input', message: `No collection "${collection}" in olan-app.json "data"`, hint: collections.length ? `Collections: ${collections.map((item) => item.name).join(', ')}` : 'The manifest has no "data".' });
        }
        const matches = (row: (typeof all)[number]) =>
          Object.entries(where ?? {}).every(([field, value]) => {
            const meta = (row as unknown as Record<string, unknown>)[field];
            const actual = ['id', 'createdBy', 'createdAt', 'updatedAt', 'revision'].includes(field) ? meta : row.data[field];
            return value === null ? actual === null || actual === undefined : actual === value;
          });
        const rows = all.filter((row) => row.collection === collection && matches(row)).reverse();
        const max = limit ?? 50;
        return { ...summary, collection, total: rows.length, rows: rows.slice(0, max) };
      }),
  );

  server.registerTool(
    'olan_app_logs',
    { description: 'Console logs, errors and olan.* calls of the rendered session, plus the last build and test results.', inputSchema: {} },
    async () =>
      guarded(async () => ({
        session: session ? { surface: session.surface, logs: session.app.logs(), errors: session.app.errors(), calls: session.app.calls() } : null,
        lastBuild,
        lastTest,
      })),
  );

  server.registerTool(
    'olan_app_event_send',
    {
      description: `Send one signed event (Standard Webhooks v1a, development key) to the app's own server at <remote.url>/events, like Olan's webhooks; a local issuer on 127.0.0.1:${DEV_ISSUER_PORT} serves the JWKS meanwhile (the app server must allow that issuer). Returns the event, HTTP status and response.`,
      inputSchema: {
        ...dirArg,
        type: z.enum(EVENT_TYPES as unknown as [string, ...string[]]).describe('Event type'),
        to: z.string().optional().describe('App server base URL (default remote.url)'),
        data: z.any().optional().describe('Event data (default: built from fixtures)'),
        installationId: z.string().optional(),
        attempt: z.number().int().min(1).max(100).optional(),
        id: z.string().optional().describe('Reuse a webhook-id (redelivery)'),
        issuerPort: z.number().int().min(0).max(65535).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const dir = projectOf(input.dir);
        const result = await sendDevEvent(dir, requireManifest(dir), {
          type: input.type,
          to: input.to,
          data: input.data as JsonValue | undefined,
          installationId: input.installationId,
          attempt: input.attempt,
          id: input.id,
          issuerPort: input.issuerPort,
          env,
        });
        const out = { event: result.event, issuer: result.issuer, status: result.delivery.status, durationMs: result.delivery.durationMs, response: result.delivery.json ?? result.delivery.body, warnings: result.warnings };
        if (!result.delivery.ok) throw new CliError({ code: 'events.delivery_failed', message: `${result.delivery.url} answered ${result.delivery.status}` }, out);
        return out;
      }),
  );

  server.registerTool(
    'olan_app_request_send',
    {
      description: `Send one signed olan.remote.request (development key) to the app's own server at <remote.url>/requests, like Olan does; a local issuer on 127.0.0.1:${DEV_ISSUER_PORT} serves the JWKS meanwhile (the app server must allow that issuer). Returns the envelope, the { status, headers, body } answer and what the app would get.`,
      inputSchema: {
        ...dirArg,
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().describe('The app path, e.g. /items (a ?query is split off)'),
        query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        body: z.any().optional().describe('JSON body (not with GET/DELETE)'),
        headers: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        userId: z.string().optional(),
        profile: z.boolean().optional().describe('Add email, displayName, role (default: when the manifest has profile:read)'),
        role: z.enum(['admin', 'member']).optional(),
        to: z.string().optional().describe('App server base URL (default remote.url)'),
        issuerPort: z.number().int().min(0).max(65535).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const dir = projectOf(input.dir);
        const split = splitRequestPath(input.path);
        const query = { ...split.query, ...(input.query ?? {}) };
        const result = await sendDevRequest(dir, requireManifest(dir), {
          method: input.method,
          path: split.path,
          ...(Object.keys(query).length ? { query } : {}),
          body: input.body as JsonValue | undefined,
          headers: input.headers,
          timeoutMs: input.timeoutMs,
          userId: input.userId,
          profile: input.profile,
          role: input.role,
          to: input.to,
          issuerPort: input.issuerPort,
          env,
        });
        const out = { envelope: result.envelope, issuer: result.issuer, url: result.forwarded.url, httpStatus: result.forwarded.httpStatus, answer: result.forwarded.ok ? result.forwarded.answer : null, app: result.outcome, warnings: result.warnings };
        if (!result.forwarded.ok) throw new CliError({ code: 'requests.delivery_failed', message: result.forwarded.message }, out);
        return out;
      }),
  );

  server.registerTool(
    'olan_app_tool_call',
    {
      description: "Call one of the app's assistant tools (olan-app.json ai.tools) on its own server: a signed POST to <remote.url>/ai-tools/<name> with the §6 body (dev placeholder token). Checks the input against the tool schema and the answer against the response contract.",
      inputSchema: {
        ...dirArg,
        name: z.string().describe('Tool name from ai.tools'),
        input: z.record(z.string(), z.any()).optional().describe('Tool input (default {})'),
        to: z.string().optional().describe('App server base URL (default remote.url)'),
        userId: z.string().optional(),
        channel: z.enum(['assistant', 'mcp']).optional(),
        issuerPort: z.number().int().min(0).max(65535).optional(),
      },
    },
    async (input) =>
      guarded(async () => {
        const dir = projectOf(input.dir);
        const result = await callDevTool(requireManifest(dir), {
          name: input.name,
          input: (input.input ?? {}) as Record<string, JsonValue>,
          to: input.to,
          userId: input.userId,
          channel: input.channel,
          issuerPort: input.issuerPort,
          env,
        });
        return { callId: result.request.id, status: result.delivery.status, durationMs: result.delivery.durationMs, response: result.response };
      }),
  );

  server.registerTool(
    'olan_app_docs_search',
    { description: 'Search the offline @olan-app/sdk docs (components, olan.* API, hooks, navigation, permissions, manifest, testing, CLI, error codes).', inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() } },
    async ({ query, limit }) => guarded(async () => searchDocs(query, baseDir, limit ?? 6)),
  );

  return { server, dispose: closeSession };
}

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Run the MCP server (stdio) with validate/build/test/render/dispatch/db/logs/event/tool/docs tools',
  usage: 'olan-app mcp',
  options: ['Register it in Claude Code: claude mcp add olan-app -- npx olan-app mcp', 'Codex (~/.codex/config.toml): [mcp_servers.olan-app] command = "npx", args = ["olan-app", "mcp"]'],
  spec: {},
  async run(_args, context) {
    const { server, dispose } = createMcpServer(context.cwd, context.env);
    const transport = new StdioServerTransport();
    const wait = new Promise<void>((resolveWait) => {
      transport.onclose = () => void dispose().then(resolveWait);
    });
    await server.connect(transport);
    return { result: null, wait, silent: true };
  },
};
