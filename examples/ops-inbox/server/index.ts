/**
 * Operasyon Kutusu backend (manifest `server`). Runs on the Olan server in an isolated sandbox:
 * no Node APIs, no `fetch`; everything goes through `olan.*` from `@olan-app/sdk/backend`.
 *
 * Handler resolution (docs/backend.md): every trigger resolves by name in its own map
 * (`schedules.digest`, `events['project.task.created']`, `hooks.github`). `functions` holds only
 * what the UI calls with `olan.backend.call`: a trigger handler there would be callable from the UI.
 */
import { defineBackend, olan } from '@olan-app/sdk/backend';

export type RecordKind = 'task' | 'push' | 'digest';

/** A row of the `records` collection (olan-app.json `data`). */
export interface InboxRecord {
  kind: RecordKind;
  title: string;
  projectId?: string;
  detail?: Record<string, unknown>;
}

/** What `olan.backend.call('summary')` returns to the UI. */
export interface Summary {
  counts: Record<RecordKind, number>;
  latest: { id: string; kind: RecordKind; title: string; at: string }[];
  /** Whether the operations API token is set. The token itself never leaves the backend. */
  apiConfigured: boolean;
}

const OPS_API = 'https://ops.example.com/digest';
const records = () => olan.db.collection<InboxRecord>('records');

async function summary(): Promise<Summary> {
  const [task, push, digest, latest, token] = await Promise.all([
    records().count({ kind: 'task' }),
    records().count({ kind: 'push' }),
    records().count({ kind: 'digest' }),
    records().query({ orderBy: { field: 'createdAt', direction: 'desc' }, limit: 10 }),
    olan.secrets.get('apiToken'),
  ]);
  return {
    counts: { task, push, digest },
    latest: latest.rows.map((row) => ({ id: row.id, kind: row.data.kind, title: row.data.title, at: row.createdAt })),
    apiConfigured: token !== null,
  };
}

/**
 * Writes a digest row for what arrived since the previous digest and, when the API token is set,
 * posts it to the operations API (`http:ops.example.com`) with the token as a bearer.
 */
async function writeDigest(trigger: 'schedule' | 'manual', scheduledAt: string | null) {
  const [last] = (await records().query({ where: { kind: 'digest' }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 1 })).rows;
  const since = last?.createdAt ?? null;
  const recent = await records().query({ where: since ? { createdAt: { gt: since } } : {}, orderBy: { field: 'createdAt', direction: 'asc' }, limit: 100 });
  const tasks = recent.rows.filter((row) => row.data.kind === 'task').length;
  const pushes = recent.rows.filter((row) => row.data.kind === 'push').length;
  const row = await records().insert({
    kind: 'digest',
    title: `Özet: ${tasks} yeni görev, ${pushes} push`,
    detail: { tasks, pushes, since, trigger, scheduledAt },
  });
  const token = await olan.secrets.get('apiToken');
  let delivered = false;
  if (token) {
    // The digest row is written either way: an unreachable operations API only skips the delivery.
    try {
      const response = await olan.http.fetch(OPS_API, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tasks, pushes, since }),
      });
      delivered = response.status >= 200 && response.status < 300;
      if (!delivered) console.warn('ops API answered', response.status);
    } catch (error) {
      console.warn('ops API unreachable', error instanceof Error ? error.message : String(error));
    }
  }
  console.log('digest written', row.id, { tasks, pushes, delivered });
  return { id: row.id, tasks, pushes, delivered };
}

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string };
  commits?: unknown[];
  pusher?: { name?: string };
}

export default defineBackend({
  functions: {
    /** UI: the inbox screen. */
    summary,
    /** UI: "Özet oluştur" (the same digest the schedule writes). */
    digestNow: () => writeDigest('manual', null),
  },
  events: {
    /** `server.events["project.task.created"]`, as the app. */
    async 'project.task.created'(event, context) {
      const { projectId, task } = event.data;
      await records().insert({ kind: 'task', title: task.title, projectId, detail: { taskId: task.id, by: context.identity.actor } });
    },
  },
  schedules: {
    /** `server.schedules` "digest", every 5 minutes. */
    digest: (context) => writeDigest('schedule', context.scheduledAt).then(() => undefined),
  },
  hooks: {
    /** `POST /api/v2/apps/hooks/<installationId>/github`; Olan has already checked x-hub-signature-256. */
    async github(request) {
      const kind = request.headers['x-github-event'] ?? 'push';
      if (kind === 'ping') return { status: 200, body: 'pong' };
      if (kind !== 'push') return { status: 202 };
      let payload: PushPayload;
      try {
        payload = JSON.parse(request.body) as PushPayload;
      } catch {
        return { status: 400, body: 'invalid JSON' };
      }
      const repository = payload.repository?.full_name ?? 'bilinmeyen depo';
      const branch = (payload.ref ?? '').replace(/^refs\/heads\//, '') || '?';
      const commits = Array.isArray(payload.commits) ? payload.commits.length : 0;
      const row = await records().insert({ kind: 'push', title: `${repository}: ${branch} dalına ${commits} commit`, detail: { repository, branch, commits, pusher: payload.pusher?.name ?? null } });
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recorded: row.id }) };
    },
  },
});
