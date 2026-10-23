/*
 * Team Standup's own server (manifest `remote`, Phase 3 contract §4–§6), a small Node test server:
 *   node remote-server/server.ts            (Node ≥ 22.18 / 24: runs the TypeScript directly)
 *
 * - `GET  /.well-known/jwks.json`  the app's public key (manifest `remote.jwksUrl`)
 * - `POST /olan/events`            signed events (`project.task.created`, `chat.message.created`, app.*)
 * - `POST /olan/ai-tools/:name`    the assistant tools `standup_summary` (read-only, projects:read) and
 *                                   `standup_add_task` (confirmed by the person, projects:read + tasks:write)
 * - `POST /olan/card-actions`      the standup card's "Tamamladım" button
 * - `/__test/*`, `/health`         test controls for the end-to-end test (see README.md)
 *
 * Every Olan request is verified with `@olan-app/sdk/server` (issuer allowlist → key → Ed25519
 * signature → ±5 min timestamp). What arrives is appended to `<dataDir>/received.jsonl`: ids,
 * types and outcomes only, never tokens.
 *
 * Env: PORT (4417), OLAN_ISSUERS (comma-separated, default http://localhost:4000),
 *      STANDUP_DATA_DIR (default remote-server/.data: app-key.json + received.jsonl).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createOlanServer,
  fromNodeRequest,
  generateAppKey,
  OlanServerError,
  sendNodeResponse,
  ToolError,
  type OlanServer,
  type ToolContext,
  type ToolOutput,
  type VerifiedRequest,
} from '@olan-app/sdk/server';

import { DONE_ACTION, standupCard, standupCardData } from '../src/card.ts';

export const APP_ID = 'com.olan.examples.team-standup';
export const DEFAULT_PORT = 4417;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ISSUERS: readonly string[] = ['http://localhost:4000'];
const MAX_BODY = 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

export type LogEntry = { kind: string; receivedAt: string; [key: string]: unknown };

export interface StandupServerOptions {
  /** Olan servers accepted (`olan-issuer`); default `OLAN_ISSUERS` or http://localhost:4000. */
  issuers?: readonly string[];
  /** Key and log directory; default `STANDUP_DATA_DIR` or `remote-server/.data`. */
  dataDir?: string;
  /** Used for the issuer's JWKS, the token endpoint and calls back to Olan (tests pass a fake). */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface StandupServer {
  readonly olan: OlanServer;
  readonly keyId: string;
  /** Node request handler (`http.createServer(server.handle)`). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  /** Parsed `received.jsonl`. */
  log(): LogEntry[];
  reset(): void;
}

type AppKey = { privateKeyPem: string; keyId: string };

/** The app's signing key: `app-key.json` in the data directory, made on the first start. */
async function loadKey(dataDir: string): Promise<AppKey> {
  const file = join(dataDir, 'app-key.json');
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppKey>;
    if (typeof stored.privateKeyPem === 'string' && typeof stored.keyId === 'string') return { privateKeyPem: stored.privateKeyPem, keyId: stored.keyId };
  }
  const generated = await generateAppKey();
  const key = { privateKeyPem: generated.privateKeyPem, keyId: generated.keyId };
  writeFileSync(file, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  return key;
}

const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `YYYY-MM-DD` in a time zone (UTC when unknown). */
function dayIn(timeZone: string | undefined, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** A UUID that is the same for the same tool call (Olan's task creation key). */
function creationKey(callId: string): string {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(callId)?.[0];
  if (uuid) return uuid.toLowerCase();
  const hex = createHash('sha256').update(callId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Task = { title?: unknown; status?: unknown; due?: unknown; assigneeId?: unknown; completedAt?: unknown; updatedAt?: unknown };

export async function createStandupServer(options: StandupServerOptions = {}): Promise<StandupServer> {
  const dataDir = resolve(options.dataDir ?? process.env.STANDUP_DATA_DIR ?? join(here, '.data'));
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, 'received.jsonl');
  const issuers = options.issuers ?? (process.env.OLAN_ISSUERS ? process.env.OLAN_ISSUERS.split(',').map((item) => item.trim()).filter(Boolean) : DEFAULT_ISSUERS);
  const doFetch: typeof fetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const key = await loadKey(dataDir);
  const olan = createOlanServer({ appId: APP_ID, privateKeyPem: key.privateKeyPem, keyId: key.keyId, issuers, fetch: doFetch, now });

  /** Pending deliberate failures of event deliveries (`POST /__test/fail`). */
  let failures: { count: number; status: number; type: string | null } = { count: 0, status: 500, type: null };
  let jwksUrl = '';

  const record = (entry: Record<string, unknown>) => {
    appendFileSync(logFile, `${JSON.stringify({ ...entry, receivedAt: new Date(now()).toISOString() })}\n`);
  };
  const log = (): LogEntry[] => {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
  };
  const reset = () => {
    writeFileSync(logFile, '');
    failures = { count: 0, status: 500, type: null };
  };

  /** Logs a refused Olan request (verification failures and malformed bodies answer 4xx). */
  const noteRejected = async (path: string, response: Response) => {
    if (response.status !== 401 && response.status !== 400 && response.status !== 503) return response;
    const body = (await response.clone().json().catch(() => ({}))) as { error?: unknown };
    record({ kind: 'rejected', path, status: response.status, error: typeof body.error === 'string' ? body.error : 'rejected' });
    return response;
  };

  // ---------------------------------------------------------------------------------------------
  // The assistant tool
  // ---------------------------------------------------------------------------------------------

  /** Olan's API as the person: the embedded token first; on 401 once more with an installation token on their behalf. */
  function olanApi(ctx: ToolContext) {
    let token = ctx.token.accessToken;
    let renewed = false;
    return async (path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> => {
      const call = () => doFetch(`${ctx.issuer}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      let response = await call();
      if (response.status === 401 && !renewed) {
        renewed = true;
        token = (await olan.getInstallationToken({ issuer: ctx.issuer, installationId: ctx.installationId, userId: ctx.user.id })).accessToken;
        response = await call();
      }
      return response;
    };
  }

  async function standupSummary(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    record({ kind: 'tool_call', callId: ctx.callId, tool: ctx.tool, channel: ctx.channel, userId: ctx.user.id });
    const api = olanApi(ctx);
    const requested = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;
    let ids: string[];
    if (requested) ids = [requested];
    else {
      const response = await api('/api/v2/projects');
      if (!response.ok) throw new ToolError('olan_unavailable', `Olan answered ${response.status} for the project list`);
      const page = (await response.json()) as unknown;
      const items = Array.isArray(page) ? page : isObject(page) && Array.isArray(page.items) ? page.items : [];
      ids = items.filter((item): item is Record<string, unknown> => isObject(item) && item.archived !== true && typeof item.id === 'string')
        .slice(0, 20).map((item) => item.id as string);
    }

    const today = dayIn(ctx.user.timeZone, now());
    const projects = [];
    for (const id of ids) {
      const response = await api(`/api/v2/projects/${encodeURIComponent(id)}`);
      if (response.status === 404 || response.status === 403) {
        if (requested) throw new ToolError('project_not_found', 'Proje bulunamadı ya da görülemiyor');
        continue;
      }
      if (!response.ok) throw new ToolError('olan_unavailable', `Olan answered ${response.status} for a project`);
      const detail = (await response.json()) as { project?: { id?: string; name?: string }; tasks?: Task[]; members?: { userId?: string; displayName?: string }[] };
      const names = new Map((detail.members ?? []).map((member) => [member.userId, member.displayName]));
      const tasks = detail.tasks ?? [];
      const open = tasks.filter((task) => task.status === 'needs-action' || task.status === 'in-process');
      const dueDay = (task: Task) => (typeof task.due === 'string' && task.due ? task.due.slice(0, 10) : null);
      const overdue = open.filter((task) => {
        const due = dueDay(task);
        return due !== null && due < today;
      });
      const completedToday = tasks.filter((task) => {
        const at = typeof task.completedAt === 'string' ? task.completedAt : typeof task.updatedAt === 'string' ? task.updatedAt : null;
        return task.status === 'completed' && at !== null && dayIn(ctx.user.timeZone, Date.parse(at)) === today;
      });
      projects.push({
        id: detail.project?.id ?? id,
        name: detail.project?.name ?? '',
        open: open.length,
        overdue: overdue.length,
        completedToday: completedToday.length,
        tasks: open.slice(0, 10).map((task) => ({
          title: typeof task.title === 'string' ? task.title : '',
          due: dueDay(task),
          assignee: typeof task.assigneeId === 'string' ? (names.get(task.assigneeId) ?? null) : null,
        })),
      });
    }
    const open = projects.reduce((sum, project) => sum + project.open, 0);
    const overdue = projects.reduce((sum, project) => sum + project.overdue, 0);
    return { result: { today, projects }, summary: `${open} açık, ${overdue} gecikmiş görev` };
  }

  /**
   * `standup_add_task` (not read-only: Olan runs it only after the person confirms the assistant's
   * card). One task in the project's first work package; the creation key comes from the call id,
   * so a repeated call creates it once.
   */
  async function standupAddTask(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    record({ kind: 'tool_call', callId: ctx.callId, tool: ctx.tool, channel: ctx.channel, userId: ctx.user.id });
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
    const description = typeof input.description === 'string' ? input.description.slice(0, 4000) : '';
    if (!projectId || !title) throw new ToolError('invalid_input', 'projectId and title are required');
    const api = olanApi(ctx);
    const detail = await api(`/api/v2/projects/${encodeURIComponent(projectId)}`);
    if (detail.status === 404 || detail.status === 403) throw new ToolError('project_not_found', 'Proje bulunamadı ya da görülemiyor');
    if (!detail.ok) throw new ToolError('olan_unavailable', `Olan answered ${detail.status} for the project`);
    const { project, lists } = (await detail.json()) as { project?: { name?: string }; lists?: { id?: string; archived?: boolean; parentId?: string | null; isDefault?: boolean }[] };
    const open = (lists ?? []).filter((list) => typeof list.id === 'string' && !list.archived && !list.parentId);
    const list = open.find((entry) => entry.isDefault) ?? open[0];
    if (!list) throw new ToolError('no_work_package', 'Projede iş paketi yok');
    const created = await api(`/api/v2/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: 'POST',
      body: { title, listId: list.id, creationKey: creationKey(ctx.callId), ...(description ? { description } : {}) },
    });
    if (created.status === 403) throw new ToolError('permission_denied', 'Bu projeye görev eklenemiyor');
    if (!created.ok) throw new ToolError('olan_unavailable', `Olan answered ${created.status} for the new task`);
    const task = (await created.json()) as { id?: string; title?: string; task?: { id?: string; title?: string } };
    const saved = task.task ?? task;
    return {
      result: { projectId, taskId: saved.id ?? null, title: saved.title ?? title },
      summary: `"${saved.title ?? title}" ${project?.name ? `${project.name} projesine ` : ''}eklendi`,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------------------------

  async function route(method: string, path: string, request: IncomingMessage): Promise<Response> {
    if (method === 'GET' && path === '/health') return json(200, { ok: true, jwksUrl, keyId: key.keyId });
    if (method === 'GET' && path === '/.well-known/jwks.json') return json(200, await olan.jwks());
    if (method === 'GET' && path === '/__test/log') return json(200, { entries: log() });
    if (method !== 'POST') return json(404, { error: 'not_found' });

    const incoming = await fromNodeRequest(request, { maxBytes: MAX_BODY });
    const testBody = () => {
      try {
        const value = JSON.parse(new TextDecoder().decode(incoming.body) || '{}') as unknown;
        return isObject(value) ? value : {};
      } catch {
        return {};
      }
    };

    if (path === '/__test/reset') {
      reset();
      return json(200, { ok: true });
    }
    if (path === '/__test/fail') {
      const body = testBody();
      const count = Number.isInteger(body.count) && (body.count as number) >= 0 ? (body.count as number) : 1;
      const status = Number.isInteger(body.status) && (body.status as number) >= 400 && (body.status as number) <= 599 ? (body.status as number) : 500;
      // `type`: only deliveries of that event type fail (others pass, e.g. bot messages of a project chat).
      const type = typeof body.type === 'string' && body.type ? body.type : null;
      failures = { count, status, type };
      return json(200, { ok: true, ...failures });
    }
    if (path === '/__test/app-identity') {
      const body = testBody();
      const issuer = typeof body.issuer === 'string' ? body.issuer.replace(/\/+$/, '') : '';
      const installationId = typeof body.installationId === 'string' ? body.installationId : '';
      const target = typeof body.path === 'string' && body.path.startsWith('/') ? body.path : '';
      if (!issuer || !installationId || !target) return json(400, { error: 'invalid_request', message: 'issuer, installationId and path (starting with /) are required' });
      let accessToken: string;
      try {
        accessToken = (await olan.getInstallationToken({ issuer, installationId })).accessToken;
      } catch (error) {
        const code = error instanceof OlanServerError ? error.code : 'token_failed';
        record({ kind: 'app_identity', installationId, path: target, tokenOk: false, error: code });
        return json(200, { tokenOk: false, error: code, status: error instanceof OlanServerError ? error.status : null });
      }
      const response = await doFetch(`${issuer}${target}`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      record({ kind: 'app_identity', installationId, path: target, tokenOk: true, status: response.status });
      return json(200, { tokenOk: true, status: response.status, body: parsed });
    }

    if (path === '/olan/events') {
      let verified: VerifiedRequest<{ id?: unknown; type?: unknown }>;
      try {
        verified = await olan.verify<{ id?: unknown; type?: unknown }>(incoming);
      } catch (error) {
        const status = error instanceof OlanServerError ? error.status : 400;
        const code = error instanceof OlanServerError ? error.code : 'invalid_body';
        record({ kind: 'rejected', path, status, error: code });
        return json(status, { error: code, message: error instanceof Error ? error.message : 'rejected' });
      }
      if (failures.count > 0 && (failures.type === null || verified.eventType === failures.type)) {
        // Deliberate failure after verification: the id is not marked seen, so the retry is processed.
        failures.count -= 1;
        record({ kind: 'failed_on_purpose', webhookId: verified.webhookId, type: verified.eventType, attempt: verified.attempt, status: failures.status });
        return json(failures.status, { ok: false, error: 'failed_on_purpose' });
      }
      const response = await olan.handleEvent(incoming, async (event, context) => {
        record({
          kind: 'event',
          webhookId: context.webhookId,
          type: event.type,
          installationId: context.installationId,
          attempt: context.attempt,
          timestamp: verified.timestamp,
          data: event.data,
        });
      });
      if (response.ok) {
        const body = (await response.clone().json().catch(() => ({}))) as { duplicate?: unknown };
        if (body.duplicate === true) record({ kind: 'duplicate', webhookId: verified.webhookId, attempt: verified.attempt });
      }
      return noteRejected(path, response);
    }

    const tool = /^\/olan\/ai-tools\/([a-z][a-z0-9_]{1,31})$/.exec(path);
    if (tool) {
      return noteRejected(path, await olan.handleToolCall(incoming, {
        standup_summary: (input, ctx) => standupSummary(input as Record<string, unknown>, ctx),
        standup_add_task: (input, ctx) => standupAddTask(input as Record<string, unknown>, ctx),
      }));
    }

    if (path === '/olan/card-actions') {
      return noteRejected(path, await olan.handleCardAction(incoming, async (action) => {
        record({ kind: 'card_action', name: action.name, messageId: action.messageId, installationId: action.installationId });
        if (action.name !== DONE_ACTION) return { toast: { text: 'Bilinmeyen eylem', tone: 'warning' } };
        const data = standupCardData(action.payload) ?? { day: dayIn(undefined, now()), note: '' };
        return { card: standupCard(data, { done: true }), toast: { text: 'Standup tamamlandı', tone: 'success' } };
      }));
    }

    return json(404, { error: 'not_found' });
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let answer: Response;
    try {
      answer = await route((request.method ?? 'GET').toUpperCase(), path, request);
    } catch (error) {
      if (error instanceof OlanServerError) answer = json(error.status, { error: error.code, message: error.message });
      else {
        console.error('team-standup remote server:', error instanceof Error ? error.message : error);
        answer = json(500, { error: 'internal_error' });
      }
    }
    await sendNodeResponse(response, answer);
  };

  let server: Server | null = null;
  return {
    olan,
    keyId: key.keyId,
    handle,
    log,
    reset,
    listen(port = DEFAULT_PORT, host = DEFAULT_HOST) {
      return new Promise((resolveListen, reject) => {
        server = createServer((request, response) => void handle(request, response));
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server!.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          const url = `http://${host}:${actual}`;
          jwksUrl = `${url}/.well-known/jwks.json`;
          resolveListen({ port: actual, url });
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        if (!server) return resolveClose();
        server.close(() => resolveClose());
        server = null;
      });
    },
  };
}

// Started directly: `node remote-server/server.ts`. (A bundle that includes this module, e.g. a
// test, has another file name and never listens.)
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && /[\\/]remote-server[\\/]server\.ts$/.test(self) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = await createStandupServer();
  const { url } = await server.listen(port, DEFAULT_HOST);
  console.log(`Team Standup app server on ${url} (remote.url ${url}/olan, key ${server.keyId})`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
