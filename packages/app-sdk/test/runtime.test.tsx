import { describe, expect, it } from 'vitest';

import { Button, Screen, Text } from '../src/components';
import { defineApp } from '../src/define-app';
import { olan } from '../src/api/olan';
import { isOlanError, OlanError, RemoteError } from '../src/api/rpc-client';
import { useAppContext, useLocale, useNavigation, useProjectConfig, useQuery, useSurfaceParams, useTheme, useUser, useUsers } from '../src/hooks';
import { SDK_VERSION, type HostToSandboxMessage, type InitMessage, type JsonValue, type SandboxToHostMessage, type UiPatch } from '../src/protocol';
import { createMemoryChannel, startRuntime, type RuntimeHandle } from '../src/runtime';
import { applyPatches, createUiTree, treeText } from '../src/tree';

const INIT: InitMessage = {
  type: 'init',
  app: { id: 'com.visetra.test', version: '0.1.0', installationId: null },
  surface: 'app',
  params: null,
  context: { theme: 'light', locale: 'tr', platform: 'web', permissions: ['projects:read'], settings: { threshold: 3 }, development: true, user: { id: '00000000-0000-4000-8000-000000000001' } },
};

type RpcHandler = (method: string, params: JsonValue) => { ok: true; result: JsonValue } | { ok: false; error: { code: string; message: string } } | Promise<never>;

/** A fake host on the other end of an in-memory channel. */
function boot(app: ReturnType<typeof defineApp>, options: { rpc?: RpcHandler; init?: Partial<InitMessage> } = {}) {
  const channel = createMemoryChannel();
  const tree = createUiTree();
  const received: SandboxToHostMessage[] = [];
  const calls: { method: string; params: JsonValue }[] = [];
  channel.host.onMessage((message) => {
    received.push(message);
    if (message.type === 'patches') applyPatches(tree, message.patches as UiPatch[]);
    if (message.type === 'rpc') {
      calls.push({ method: message.method, params: message.params });
      const outcome = options.rpc?.(message.method, message.params) ?? { ok: true as const, result: null };
      if (outcome instanceof Promise) return;
      channel.host.post({ type: 'rpc-result', id: message.id, ...outcome } as HostToSandboxMessage);
    }
  });
  const runtime: RuntimeHandle = startRuntime(channel.sandbox, app, { captureGlobalErrors: false });
  channel.host.post({ ...INIT, ...options.init });
  const send = (message: HostToSandboxMessage) => channel.host.post(message);
  const press = (label: string) => {
    const button = [...tree.nodes.values()].find((node) => node.type === 'Button' && node.props.label === label);
    if (!button) throw new Error(`No button "${label}"`);
    send({ type: 'event', handlerId: (button.props.onPress as { $handler: number }).$handler, payload: null });
  };
  return { runtime, tree, received, calls, send, press };
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runtime', () => {
  it('sends ready, mounts the requested surface and streams patches', async () => {
    const app = defineApp({
      app: () => <Screen title="Ana" />,
      'project.widget': ({ params }) => <Text text={`Proje ${(params as { projectId: string }).projectId}`} />,
    });
    const { received, tree, runtime } = boot(app, { init: { surface: 'project.widget', params: { projectId: 'p1' } } });
    await waitFor(() => tree.root !== null);
    expect(received[0]).toEqual({ type: 'ready', sdkVersion: SDK_VERSION, protocolVersion: 1 });
    expect(treeText(tree)).toBe('Proje p1');
    runtime.dispose();
  });

  it('types surface params and re-renders panels when context carries new params', async () => {
    function Panel() {
      const params = useSurfaceParams<'mail.sidebar'>();
      return <Text text={`Konu: ${params.subject}`} />;
    }
    function Prop({ params }: { params: JsonValue }) {
      return <Text text={`Prop ${(params as { messageId: string }).messageId}`} />;
    }
    const mail = (messageId: string, subject: string) => ({ messageId, threadId: 't1', subject, from: { name: 'Ayşe', email: 'ayse@example.com' }, to: [], cc: [], receivedAt: '2026-10-17T09:00:00Z' });
    const { tree, send, runtime } = boot(defineApp({ 'mail.sidebar': () => <Screen><Panel /><PropHolder /></Screen> }), { init: { surface: 'mail.sidebar', params: mail('m1', 'Teklif') } });
    function PropHolder() {
      return <Prop params={useSurfaceParams<'mail.sidebar'>() as unknown as JsonValue} />;
    }
    await waitFor(() => treeText(tree).includes('Teklif'));
    expect(treeText(tree)).toContain('Prop m1');
    send({ type: 'context', context: {}, params: mail('m2', 'Fatura') });
    await waitFor(() => treeText(tree).includes('Fatura'));
    expect(treeText(tree)).toContain('Prop m2');
    expect(runtime.session?.get().stack[0]?.params).toMatchObject({ messageId: 'm2' });
    runtime.dispose();
  });

  it('passes new params to the surface component props too', async () => {
    const seen: string[] = [];
    const app = defineApp({
      'meeting.panel': ({ params }) => {
        const title = (params as { title: string }).title;
        seen.push(title);
        return <Text text={title} />;
      },
    });
    const meeting = (title: string) => ({ meetingId: 'm', slug: 's', title, startsAt: '2026-10-17T09:00:00Z', endsAt: null, role: 'organizer' as const });
    const { tree, send, runtime } = boot(app, { init: { surface: 'meeting.panel', params: meeting('Haftalık') } });
    await waitFor(() => treeText(tree) === 'Haftalık');
    send({ type: 'context', context: { theme: 'dark' }, params: meeting('Retro') });
    await waitFor(() => treeText(tree) === 'Retro');
    expect(seen).toContain('Retro');
    runtime.dispose();
  });

  it('opens project.tab with { projectId } and keeps the project configuration with useProjectConfig (Phase 6)', async () => {
    function Tab() {
      const { projectId } = useSurfaceParams<'project.tab'>();
      const config = useProjectConfig();
      if (config.loading) return <Text text="Yükleniyor" />;
      return (
        <Screen>
          <Text text={`${projectId}: ${String(config.value.brandId ?? 'yok')} r${config.data?.revision ?? '?'}`} />
          <Button label="Bağla" onPress={() => void config.save({ brandId: 'b2' })} />
        </Screen>
      );
    }
    const stored = { projectId: 'p1', value: { brandId: 'b1' }, revision: 3, updatedBy: 'u1', updatedAt: '2026-10-22T09:00:00Z' };
    const { tree, calls, press, runtime } = boot(defineApp({ 'project.tab': Tab }), {
      init: { surface: 'project.tab', params: { projectId: 'p1' } },
      rpc: (method, params) => {
        if (method === 'project.config.get') return { ok: true, result: stored as unknown as JsonValue };
        if (method === 'project.config.set') {
          const { value } = params as { value: JsonValue };
          return { ok: true, result: { ...stored, value, revision: 4 } as unknown as JsonValue };
        }
        return { ok: false, error: { code: 'unknown_method', message: method } };
      },
    });
    await waitFor(() => treeText(tree).includes('p1: b1 r3'));
    press('Bağla');
    await waitFor(() => treeText(tree).includes('p1: b2 r4'));
    expect(calls).toEqual([
      { method: 'project.config.get', params: { projectId: 'p1' } },
      // The save is based on the loaded revision, so a concurrent change answers `conflict`.
      { method: 'project.config.set', params: { projectId: 'p1', value: { brandId: 'b2' }, revision: 3 } },
    ]);
    runtime.dispose();
  });

  it('reports a missing surface as a fatal error', async () => {
    const { received, runtime } = boot(defineApp({ app: () => <Screen /> }), { init: { surface: 'settings' } });
    await waitFor(() => received.some((message) => message.type === 'error'));
    expect(received.find((message) => message.type === 'error')).toMatchObject({ fatal: true, message: expect.stringContaining('settings') });
    runtime.dispose();
  });

  it('runs olan.* calls as rpc messages and resolves them from rpc-result', async () => {
    function App() {
      const projects = useQuery(() => olan.projects.list({ limit: 2 }));
      if (projects.loading) return <Text text="Yükleniyor" />;
      return <Text text={projects.data!.items.map((project) => project.name).join(', ')} />;
    }
    const app = defineApp({ app: App });
    const { tree, calls, runtime } = boot(app, {
      rpc: (method) =>
        method === 'projects.list'
          ? { ok: true, result: { items: [{ id: 'p1', name: 'Web' }, { id: 'p2', name: 'Mobil' }] } as unknown as JsonValue }
          : { ok: false, error: { code: 'unknown_method', message: method } },
    });
    await waitFor(() => treeText(tree) === 'Web, Mobil');
    expect(calls).toEqual([{ method: 'projects.list', params: { limit: 2 } }]);
    runtime.dispose();
  });

  it('exposes the current user and loads directory entries through users.get', async () => {
    function App() {
      const me = useUser();
      const context = useAppContext();
      const people = useUsers([me.id, 'u2', me.id]);
      const names = (people.data ?? []).map((user) => user.displayName).join(', ');
      return <Text text={`${context.user.id === me.id ? me.id : 'mismatch'} | ${people.loading ? '…' : names} | ${people.byId.get('u2')?.email ?? '-'}`} />;
    }
    const { tree, calls, runtime } = boot(defineApp({ app: App }), {
      rpc: (method, params) =>
        method === 'users.get'
          ? {
              ok: true,
              result: {
                users: (params as { ids: string[] }).ids
                  .filter((id) => id !== 'missing')
                  .map((id) => ({ id, displayName: id === 'u2' ? 'Ayşe' : 'Utku', email: `${id}@example.com` })),
              },
            }
          : { ok: false, error: { code: 'unknown_method', message: method } },
    });
    await waitFor(() => treeText(tree).includes('Ayşe'));
    expect(treeText(tree)).toBe('00000000-0000-4000-8000-000000000001 | Utku, Ayşe | u2@example.com');
    // Duplicates are dropped and the id set is sorted, so the call does not depend on order.
    expect(calls).toEqual([{ method: 'users.get', params: { ids: ['00000000-0000-4000-8000-000000000001', 'u2'] } }]);
    runtime.dispose();
  });

  it('olan.users.get splits long id lists and skips empty ones', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `u${index}`);
    let result: unknown;
    function App() {
      const query = useQuery(async () => ({ none: await olan.users.get([]), all: await olan.users.get(ids) }));
      result = query.data;
      return <Text text={query.loading ? '…' : 'ok'} />;
    }
    const { tree, calls, runtime } = boot(defineApp({ app: App }), {
      rpc: (_method, params) => ({ ok: true, result: { users: (params as { ids: string[] }).ids.map((id) => ({ id, displayName: id, email: '' })) } }),
    });
    await waitFor(() => treeText(tree) === 'ok');
    expect(calls.map((call) => (call.params as { ids: string[] }).ids.length)).toEqual([100, 100, 5]);
    expect((result as { none: unknown[]; all: unknown[] }).none).toEqual([]);
    expect((result as { all: unknown[] }).all).toHaveLength(205);
    runtime.dispose();
  });

  it('gives an empty user id when an older host sends no user', async () => {
    function Who() {
      return <Text text={`[${useUser().id}]`} />;
    }
    const { tree, runtime } = boot(defineApp({ app: Who }), {
      init: { context: { theme: 'light', locale: 'tr', platform: 'web', permissions: [], settings: {}, development: false } as unknown as InitMessage['context'] },
    });
    await waitFor(() => treeText(tree) === '[]');
    runtime.dispose();
  });

  it('rejects with OlanError carrying the host error code', async () => {
    let caught: unknown;
    function App() {
      const storage = useQuery(() => olan.storage.get('x'));
      if (storage.error) caught = storage.error;
      return <Text text={storage.error ? `Hata: ${(storage.error as OlanError).code}` : '…'} />;
    }
    const app = defineApp({ app: App });
    const { tree, runtime } = boot(app, { rpc: () => ({ ok: false, error: { code: 'permission_denied', message: 'storage' } }) });
    await waitFor(() => treeText(tree) === 'Hata: permission_denied');
    expect(caught).toBeInstanceOf(OlanError);
    runtime.dispose();
  });

  it('useQuery refetches when deps change and ignores superseded results', async () => {
    const resolvers: ((value: JsonValue) => void)[] = [];
    let setId: (id: string) => void = () => {};
    const { useState } = await import('react');
    function App() {
      const [id, set] = useState('a');
      setId = set;
      const query = useQuery(() => new Promise<JsonValue>((resolve) => resolvers.push(resolve)).then((value) => `${id}:${value}`), [id]);
      return <Text text={query.loading ? `loading ${query.data ?? ''}` : String(query.data)} />;
    }
    const app = defineApp({ app: App });
    const { tree, runtime } = boot(app);
    await waitFor(() => resolvers.length === 1);
    setId('b');
    await waitFor(() => resolvers.length === 2);
    resolvers[1]('second');
    await waitFor(() => treeText(tree) === 'b:second');
    resolvers[0]('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(treeText(tree)).toBe('b:second');
    runtime.dispose();
  });

  it('dispatches events, and async handler rejections become error messages', async () => {
    const app = defineApp({
      app: () => (
        <Screen>
          <Button
            label="Patla"
            onPress={async () => {
              await Promise.resolve();
              throw new Error('boom');
            }}
          />
        </Screen>
      ),
    });
    const { press, received, tree, runtime } = boot(app);
    await waitFor(() => tree.root !== null);
    press('Patla');
    await waitFor(() => received.some((message) => message.type === 'error'));
    expect(received.find((message) => message.type === 'error')).toMatchObject({ message: 'boom' });
    expect(received.find((message) => message.type === 'error')).not.toHaveProperty('fatal');
    runtime.dispose();
  });

  it('applies context updates to useTheme and useLocale', async () => {
    function App() {
      return <Text text={`${useTheme()} ${useLocale()}`} />;
    }
    const app = defineApp({ app: App });
    const { tree, send, runtime } = boot(app);
    await waitFor(() => treeText(tree) === 'light tr');
    send({ type: 'context', context: { theme: 'dark', locale: 'en' } });
    await waitFor(() => treeText(tree) === 'dark en');
    runtime.dispose();
  });

  it('keeps a navigation stack, tells the host and pops on the host back message', async () => {
    function App() {
      const nav = useNavigation();
      return (
        <Screen title={nav.screen}>
          <Button label="Detay" onPress={() => olan.navigation.push('detail', { id: 7 })} />
          <Text text={`${nav.screen} ${JSON.stringify(nav.params)} ${nav.depth}`} />
        </Screen>
      );
    }
    const app = defineApp({ app: App });
    const { tree, press, send, calls, runtime } = boot(app);
    await waitFor(() => treeText(tree).includes('index null 1'));
    press('Detay');
    await waitFor(() => treeText(tree).includes('detail {"id":7} 2'));
    expect(calls).toEqual([{ method: 'navigation.push', params: { screen: 'detail', params: { id: 7 } } }]);
    send({ type: 'navigation', action: 'back' });
    await waitFor(() => treeText(tree).includes('index null 1'));
    runtime.dispose();
  });

  it('tells the host about pop() on the first screen so it can close a modal (Phase 3 §3.1)', async () => {
    function App() {
      const nav = useNavigation();
      return (
        <Screen title={nav.screen}>
          <Button label="Detay" onPress={() => olan.navigation.push('detail')} />
          <Button label="Kapat" onPress={() => olan.navigation.pop()} />
          <Text text={`${nav.screen} ${nav.depth}`} />
        </Screen>
      );
    }
    const { tree, press, calls, runtime } = boot(defineApp({ app: App }));
    await waitFor(() => treeText(tree).includes('index 1'));
    press('Detay');
    await waitFor(() => treeText(tree).includes('detail 2'));
    press('Kapat');
    await waitFor(() => treeText(tree).includes('index 1'));
    press('Kapat');
    await waitFor(() => calls.length === 3);
    expect(calls.map((call) => call.method)).toEqual(['navigation.push', 'navigation.pop', 'navigation.pop']);
    expect(treeText(tree)).toContain('index 1');
    runtime.dispose();
  });

  it('forwards console output as log messages', async () => {
    const app = defineApp({
      app: () => {
        console.info('merhaba', { n: 1 }, new Error('e'));
        return <Text text="x" />;
      },
    });
    const { received, runtime } = boot(app);
    const isInfo = (message: SandboxToHostMessage) => message.type === 'log' && message.level === 'info';
    await waitFor(() => received.some(isInfo));
    runtime.dispose();
    const log = received.find(isInfo);
    expect(log).toMatchObject({ type: 'log', level: 'info', args: ['merhaba', { n: 1 }, { name: 'Error', message: 'e' }] });
  });

  it('rejects pending calls on dispose', async () => {
    let pending: Promise<unknown> | undefined;
    const app = defineApp({
      app: () => {
        pending ??= olan.ui.confirm({ title: 'Emin misin?' });
        return <Text text="x" />;
      },
    });
    const { runtime, calls } = boot(app, { rpc: () => new Promise<never>(() => {}) });
    await waitFor(() => calls.length === 1);
    runtime.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('Phase 5a runtime', () => {
  it('rejects remote.request failures with RemoteError (status, code, details)', async () => {
    let caught: unknown;
    function App() {
      const posts = useQuery(() => olan.remote.request({ method: 'GET', path: '/posts' }));
      if (posts.error) caught = posts.error;
      return <Text text={posts.error ? 'hata' : '…'} />;
    }
    const { tree, runtime, calls } = boot(defineApp({ app: App }), {
      rpc: () => ({ ok: false, error: { code: 'remote_rejected', message: 'nope', details: { status: 422, body: { issues: ['text'] } } } }) as never,
    });
    await waitFor(() => treeText(tree) === 'hata');
    expect(calls[0]).toEqual({ method: 'remote.request', params: { method: 'GET', path: '/posts' } });
    expect(caught).toBeInstanceOf(RemoteError);
    expect(isOlanError(caught, 'remote_rejected')).toBe(true);
    expect(caught).toMatchObject({ code: 'remote_rejected', status: 422, details: { issues: ['text'] } });
    runtime.dispose();
  });

  it('reports upload progress and cancels by upload id', async () => {
    const progress: number[] = [];
    let task: ReturnType<typeof olan.files.upload> | undefined;
    const app = defineApp({
      app: () => {
        if (!task) {
          task = olan.files.upload({ id: 'file_1', name: 'a.png', size: 10, type: 'image/png' }, { url: 'https://x.example/u', onProgress: (p) => progress.push(p.loaded) });
          task.catch(() => undefined);
        }
        return <Text text="x" />;
      },
    });
    const { runtime, calls, send } = boot(app, { rpc: (method) => (method === 'files.upload' ? new Promise<never>(() => {}) : { ok: true, result: null }) });
    await waitFor(() => calls.length === 1);
    const params = calls[0]!.params as { uploadId: string; fileId: string; url: string };
    expect(params).toMatchObject({ fileId: 'file_1', url: 'https://x.example/u' });
    expect(params.uploadId).toBe(task!.uploadId);
    expect(params.uploadId.startsWith('upl_')).toBe(true);
    send({ type: 'upload-progress', uploadId: params.uploadId, loaded: 4, total: 10 });
    send({ type: 'upload-progress', uploadId: 'upl_other', loaded: 9, total: 10 });
    await waitFor(() => progress.length === 1);
    expect(progress).toEqual([4]);
    await task!.cancel();
    expect(calls[1]).toEqual({ method: 'files.cancel', params: { uploadId: params.uploadId } });
    runtime.dispose();
  });

  it('refetches useQuery quietly on host timer ticks and clears the timer', async () => {
    let n = 0;
    function App() {
      const query = useQuery(() => Promise.resolve(++n), [], { refetchIntervalMs: 1000 });
      return <Text text={`${query.loading ? 'loading' : 'ready'} ${String(query.data)}`} />;
    }
    const { tree, runtime, calls, send } = boot(defineApp({ app: App }));
    await waitFor(() => treeText(tree) === 'ready 1');
    const set = calls.find((call) => call.method === 'timers.set');
    expect(set?.params).toMatchObject({ intervalMs: 5000 });
    const timerId = (set!.params as { timerId: string }).timerId;
    send({ type: 'timer', timerId });
    await waitFor(() => treeText(tree) === 'ready 2');
    runtime.dispose();
  });

  it('falls back to a sandbox interval on hosts without timers', async () => {
    function App() {
      useQuery(() => Promise.resolve(1), [], { refetchIntervalMs: 5000 });
      return <Text text="x" />;
    }
    const { runtime, calls } = boot(defineApp({ app: App }), { rpc: (method) => (method === 'timers.set' ? { ok: false, error: { code: 'unknown_method', message: 'old host' } } : { ok: true, result: null }) });
    await waitFor(() => calls.some((call) => call.method === 'timers.set'));
    runtime.dispose();
  });

  it('starts on the screen of an app address (init.navigation)', async () => {
    function App() {
      const navigation = useNavigation();
      return <Text text={`${navigation.screen} ${JSON.stringify(navigation.params)} ${navigation.depth}`} />;
    }
    const pushed = boot(defineApp({ app: App }), { init: { navigation: { screen: 'composer', params: { brand: 'b1' } } } });
    await waitFor(() => treeText(pushed.tree) === 'composer {"brand":"b1"} 2');
    pushed.send({ type: 'navigation', action: 'back' });
    await waitFor(() => treeText(pushed.tree) === 'index null 1');
    pushed.runtime.dispose();
    const index = boot(defineApp({ app: App }), { init: { navigation: { screen: 'index', params: { tab: 'ads' } } } });
    await waitFor(() => treeText(index.tree) === 'index {"tab":"ads"} 1');
    index.runtime.dispose();
  });
});
