import { describe, expect, it } from 'vitest';

import { methodAllowed } from '@olan-app/schema';

import { olan } from '../src/api/olan';
import { isOlanError, OlanError } from '../src/api/rpc-client';
import { Button, Screen, Text } from '../src/components';
import { defineApp } from '../src/define-app';
import { useCollection, useRecord } from '../src/hooks';
import { createMemoryDb, MemoryDbError } from '../src/memory-db';
import type { HostToSandboxMessage, InitMessage, JsonValue, UiPatch } from '../src/protocol';
import { createMemoryChannel, startRuntime } from '../src/runtime';
import { applyPatches, createUiTree, treeText } from '../src/tree';
import { DB_CONTRACT_SCHEMA } from './db-contract';

const INIT: InitMessage = {
  type: 'init',
  app: { id: 'com.visetra.decision-log', version: '0.1.0', installationId: null },
  surface: 'app',
  params: null,
  context: { theme: 'light', locale: 'tr', platform: 'web', permissions: ['db', 'tasks:write', 'tasks:delete', 'projects:delete'], settings: {}, development: true, user: { id: '00000000-0000-4000-8000-000000000001' } },
};

type Decision = { title: string; status?: 'open' | 'done'; score?: number };

/**
 * A host on the other end of an in-memory channel: `db.*` goes to `createMemoryDb`, permissions
 * are checked with `methodAllowed`, other calls go to `projects`.
 */
function boot(app: ReturnType<typeof defineApp>, options: { permissions?: string[]; projects?: (method: string, params: JsonValue) => JsonValue } = {}) {
  const channel = createMemoryChannel();
  const tree = createUiTree();
  const db = createMemoryDb({ data: DB_CONTRACT_SCHEMA, userId: 'u1' });
  const calls: { method: string; params: JsonValue }[] = [];
  const permissions = options.permissions ?? INIT.context.permissions;
  channel.host.onMessage(async (message) => {
    if (message.type === 'patches') applyPatches(tree, message.patches as UiPatch[]);
    if (message.type !== 'rpc') return;
    calls.push({ method: message.method, params: message.params });
    const reply = (outcome: { ok: true; result: JsonValue } | { ok: false; error: { code: string; message: string } }) =>
      channel.host.post({ type: 'rpc-result', id: message.id, ...outcome } as HostToSandboxMessage);
    if (!methodAllowed(message.method, permissions)) return reply({ ok: false, error: { code: 'permission_denied', message: message.method } });
    try {
      const result = message.method.startsWith('db.') ? await db.call(message.method, message.params) : (options.projects?.(message.method, message.params) ?? null);
      reply({ ok: true, result });
    } catch (error) {
      const code = error instanceof MemoryDbError ? error.code : 'host_error';
      reply({ ok: false, error: { code, message: (error as Error).message } });
    }
  });
  const runtime = startRuntime(channel.sandbox, app, { captureGlobalErrors: false });
  channel.host.post({ ...INIT, context: { ...INIT.context, permissions } });
  const press = (label: string) => {
    const button = [...tree.nodes.values()].find((node) => node.type === 'Button' && node.props.label === label);
    if (!button) throw new Error(`No button "${label}"`);
    channel.host.post({ type: 'event', handlerId: (button.props.onPress as { $handler: number }).$handler, payload: null });
  };
  return { runtime, tree, db, calls, press };
}

let describeState: (() => string) | undefined;
async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out${describeState ? `: ${describeState()}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('olan.db through the runtime', () => {
  it('round-trips insert, query, update and delete; hooks follow local mutations', async () => {
    let lastError: unknown;
    function App() {
      const list = useCollection<Decision>('decisions', { where: { status: 'open' }, orderBy: { field: 'title', direction: 'asc' }, limit: 2 });
      const first = list.rows[0];
      const record = useRecord<Decision>('decisions', first?.id ?? null);
      const decisions = olan.db.collection<Decision>('decisions');
      return (
        <Screen>
          <Text text={`list:${list.rows.map((row) => row.data.title).join(',')}|more:${list.nextCursor ? 'y' : 'n'}|record:${record.data?.data.title ?? '-'}@${record.data?.revision ?? 0}`} />
          <Button label="Add" onPress={async () => { await decisions.insert({ title: `d${list.rows.length + 1}`, status: 'open' }); }} />
          <Button label="More" onPress={() => list.loadMore()} />
          <Button
            label="Rename"
            onPress={async () => {
              if (first) await decisions.update(first.id, { title: 'a-renamed', score: null }, { revision: first.revision });
            }}
          />
          <Button
            label="Stale"
            onPress={async () => {
              try {
                if (first) await decisions.update(first.id, { title: 'stale' }, { revision: 1 });
              } catch (error) {
                lastError = error;
              }
            }}
          />
          <Button label="Close" onPress={async () => { if (first) await decisions.delete(first.id, { revision: first.revision }); }} />
        </Screen>
      );
    }
    const { tree, db, press, runtime, calls } = boot(defineApp({ app: App }));
    describeState = () => treeText(tree);
    db.insert({ collection: 'decisions', data: { title: 'a', status: 'open' } });
    db.insert({ collection: 'decisions', data: { title: 'b', status: 'open' } });
    db.insert({ collection: 'decisions', data: { title: 'c', status: 'open' } });
    db.insert({ collection: 'decisions', data: { title: 'z', status: 'done' } });

    await waitFor(() => treeText(tree).includes('list:a,b|more:y|record:a@1'));
    press('More');
    await waitFor(() => treeText(tree).includes('list:a,b,c|more:n'));
    press('Rename');
    await waitFor(() => treeText(tree).includes('record:a-renamed@2'));
    expect(treeText(tree)).toContain('list:a-renamed,b|');
    press('Stale');
    await waitFor(() => lastError !== undefined);
    expect(isOlanError(lastError, 'conflict')).toBe(true);
    expect(lastError).toBeInstanceOf(OlanError);
    press('Close');
    await waitFor(() => treeText(tree).includes('list:b,c|more:n|record:b@1'));
    expect(db.count({ collection: 'decisions' })).toBe(3);
    expect(calls.some((call) => call.method === 'db.delete' && (call.params as { revision?: number }).revision === 2)).toBe(true);
    runtime.dispose();
  });

  it('surfaces typed errors to useCollection', async () => {
    function App() {
      const list = useCollection('decisions');
      return <Text text={list.error ? `error:${list.error.code}` : list.loading ? 'loading' : 'ok'} />;
    }
    const { tree, runtime } = boot(defineApp({ app: App }), { permissions: [] });
    await waitFor(() => treeText(tree) === 'error:permission_denied');
    runtime.dispose();
  });

  it('sends createTask, deleteTask and deleteList as RPC calls', async () => {
    const results: string[] = [];
    function App() {
      return (
        <Button
          label="Go"
          onPress={async () => {
            const task = await olan.projects.createTask('p1', { title: 'Follow up', status: 'needs-action' });
            results.push(task.title);
            await olan.projects.deleteTask('p1', task.id, { revision: task.revision });
            try {
              await olan.projects.deleteList('p1', 'l0', { revision: 1 });
            } catch (error) {
              if (isOlanError(error, 'forbidden_record')) results.push('protected');
            }
          }}
        />
      );
    }
    const projects = (method: string, params: JsonValue): JsonValue => {
      if (method === 'projects.createTask') return { id: 't1', projectId: 'p1', listId: 'l0', title: (params as { title: string }).title, revision: 1, createdByApp: 'com.visetra.decision-log' };
      if (method === 'projects.deleteList') throw new MemoryDbError('forbidden_record', 'default_record');
      return null;
    };
    const { tree, calls, press, runtime } = boot(defineApp({ app: App }), { projects });
    await waitFor(() => tree.root !== null);
    press('Go');
    await waitFor(() => results.length === 2);
    expect(results).toEqual(['Follow up', 'protected']);
    expect(calls).toEqual([
      { method: 'projects.createTask', params: { projectId: 'p1', title: 'Follow up', status: 'needs-action' } },
      { method: 'projects.deleteTask', params: { projectId: 'p1', taskId: 't1', revision: 1 } },
      { method: 'projects.deleteList', params: { projectId: 'p1', listId: 'l0', revision: 1 } },
    ]);
    runtime.dispose();
  });
});
