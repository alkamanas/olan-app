import { describe, expect, it } from 'vitest';
import {
  EVENT_CATALOG,
  EVENT_TYPES,
  SURFACES,
  SURFACE_PRESENTATIONS,
  appToolName,
  appToolSlug,
  backendCallErrorCode,
  backendCallable,
  backendHandlerResolves,
  backendHookResponse,
  backendMethodAllowed,
  backendTriggers,
  clientAssertionAudience,
  cronProblems,
  eventPermission,
  formatWebhookSignature,
  hostMessageSchema,
  impliedPermissions,
  isDevelopmentRemoteUrl,
  isEventType,
  isPrivateHost,
  parseWebhookSignature,
  remoteEndpoint,
  remoteHost,
  remoteUrlProblem,
  requestedPermissions,
  validateCard,
  validateManifest,
  webhookSignedContent,
  type ManifestIssue,
} from './index.js';

const app = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'com.example.team-standup',
  name: 'Standup',
  version: '1.0.0',
  sdk: '^1.4.0',
  entry: 'dist/app.js',
  surfaces: { app: {} },
  ...extra,
});

const remote = { url: 'https://standup.example.com/olan', jwksUrl: 'https://standup.example.com/.well-known/jwks.json' };

function issues(input: unknown, options?: { backend?: boolean }): ManifestIssue[] {
  const result = validateManifest(input, options);
  return result.ok ? [] : result.issues;
}
const codes = (input: unknown, options?: { backend?: boolean }) => issues(input, options).map((issue) => issue.code);

describe('surfaces (Phase 3 §3)', () => {
  it('lists the surfaces in contract order with a presentation each (Phase 6 appends the project surfaces)', () => {
    expect(SURFACES).toEqual(['app', 'project.widget', 'settings', 'chat.action', 'chat.command', 'chat.card', 'mail.sidebar', 'mail.action', 'calendar.event.action', 'meeting.panel', 'project.tab', 'project.settings', 'task.action', 'issue.action', 'record.card']);
    for (const surface of SURFACES) expect(SURFACE_PRESENTATIONS[surface]).toBeTruthy();
    expect(SURFACE_PRESENTATIONS['meeting.panel']).toBe('panel');
  });

  it('accepts the contract example surfaces', () => {
    const result = validateManifest(
      app({
        surfaces: {
          app: {},
          'chat.action': { title: "Standup'a ekle" },
          'chat.command': { title: 'Standup', command: 'standup', description: "Bugünün standup'ını aç" },
          'chat.card': { title: 'Standup kartı' },
          'mail.sidebar': { title: 'Müşteri' },
          'mail.action': { title: 'Göreve çevir' },
          'calendar.event.action': { title: 'Standup notu' },
          'meeting.panel': { title: 'Notlar' },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('manifest.command_invalid', () => {
    for (const command of ['Standup', 's', '1abc', 'a_b', 'x'.repeat(33)]) {
      expect(codes(app({ surfaces: { 'chat.command': { title: 'S', command } } })), command).toEqual(['manifest.command_invalid']);
    }
    expect(codes(app({ surfaces: { 'chat.command': { title: 'S' } } }))).toEqual(['manifest.command_invalid']);
    expect(codes(app({ surfaces: { 'chat.command': { title: 'S', command: 'ok', description: 'x'.repeat(121) } } }))).toEqual(['manifest.surface_invalid']);
  });

  it('web links keep only the app surface', () => {
    const link = { schemaVersion: 1, id: 'com.example.wiki', name: 'Wiki', version: '1.0.0', sdk: '*', kind: 'web-link', url: 'https://wiki.example.com', surfaces: { app: {}, 'chat.action': { title: 'x' } } };
    expect(codes(link)).toEqual(['manifest.web_link_surface']);
    expect(codes({ ...link, surfaces: { app: {} }, remote })).toEqual(['manifest.web_link_remote']);
  });

  it('init accepts every surface and context carries params', () => {
    const context = { theme: 'light', locale: 'tr', platform: 'web', permissions: [], settings: {}, development: false, user: { id: 'u' } };
    expect(hostMessageSchema.safeParse({ type: 'init', app: { id: 'x', version: '1', installationId: null }, surface: 'meeting.panel', params: { meetingId: 'm' }, context }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ type: 'context', context: {}, params: { messageId: 'm2' } }).success).toBe(true);
  });
});

describe('remote (Phase 3 §1)', () => {
  it('accepts https and local http, rejects public http and odd URLs', () => {
    expect(validateManifest(app({ remote })).ok).toBe(true);
    expect(validateManifest(app({ remote: { url: 'http://127.0.0.1:4100/olan', jwksUrl: 'http://127.0.0.1:4100/jwks.json' } })).ok).toBe(true);
    expect(codes(app({ remote: { ...remote, url: 'http://standup.example.com' } }))).toEqual(['manifest.remote_invalid_url']);
    expect(codes(app({ remote: { ...remote, jwksUrl: 'ftp://x.example.com/j' } }))).toEqual(['manifest.remote_invalid_url']);
    expect(codes(app({ remote: { url: 'https://u:p@x.example.com' , jwksUrl: remote.jwksUrl } }))).toEqual(['manifest.remote_invalid_url']);
    expect(codes(app({ remote: { url: remote.url } }))).toEqual(['manifest.remote_invalid_url']);
    expect(remoteUrlProblem('https://x.example.com/a?b=1')).toBe('query');
  });

  it('classifies private hosts and builds endpoints', () => {
    for (const host of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.1.1', '::1', '[fd00::1]', 'printer.local']) expect(isPrivateHost(host), host).toBe(true);
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) expect(isPrivateHost(host), host).toBe(false);
    expect(isDevelopmentRemoteUrl('https://10.0.0.5/olan')).toBe(true);
    expect(isDevelopmentRemoteUrl(remote.url)).toBe(false);
    expect(remoteEndpoint(remote.url, 'events')).toBe('https://standup.example.com/olan/events');
    expect(remoteEndpoint(`${remote.url}/`, 'ai-tools', 'standup_summary')).toBe('https://standup.example.com/olan/ai-tools/standup_summary');
    expect(remoteHost({ url: 'http://127.0.0.1:4100/olan' })).toBe('127.0.0.1:4100');
  });

  it('implies remote and ai:tools', () => {
    const manifest = { permissions: ['projects:read'], remote, ai: { tools: [{ name: 'x' } as never] } };
    expect(impliedPermissions(manifest)).toEqual(['remote', 'ai:tools']);
    expect(requestedPermissions(manifest)).toEqual(['projects:read', 'remote', 'ai:tools']);
    expect(impliedPermissions({ remote: undefined, ai: { tools: [] } })).toEqual([]);
  });
});

describe('events (Phase 3 §5.1)', () => {
  it('has the catalogue with permissions', () => {
    expect(EVENT_CATALOG.map((entry) => entry.type)).toEqual([...EVENT_TYPES]);
    expect(eventPermission('chat.message.created')).toBe('chat:read');
    expect(eventPermission('calendar.event.deleted')).toBe('calendar:read');
    expect(eventPermission('meeting.ended')).toBe('meetings:read');
    expect(eventPermission('app.installed')).toBeNull();
    expect(isEventType('project.task.deleted')).toBe(true);
    expect(isEventType('mail.received')).toBe(false);
  });

  it('validates subscriptions', () => {
    expect(validateManifest(app({ remote, permissions: ['projects:read', 'chat:read'], events: ['chat.message.created', 'project.task.created', 'app.installed'] })).ok).toBe(true);
    expect(codes(app({ permissions: ['projects:read'], events: ['project.task.created'] }))).toEqual(['manifest.events_require_remote']);
    expect(codes(app({ remote, events: ['mail.received'] }))).toEqual(['manifest.event_unknown']);
    const missing = issues(app({ remote, events: ['meeting.started'] }));
    expect(missing).toEqual([expect.objectContaining({ code: 'manifest.event_permission_missing', path: 'events[0]', detail: { event: 'meeting.started', permission: 'meetings:read' } })]);
  });
});

describe('ai.tools (Phase 3 §6)', () => {
  const tool = (extra: Record<string, unknown> = {}) => ({ name: 'standup_summary', title: 'Standup özeti', description: 'Summarises', input: { type: 'object', properties: {} }, permissions: ['projects:read'], readOnly: true, ...extra });

  it('accepts tools with defaults', () => {
    const result = validateManifest(app({ remote, permissions: ['projects:read'], ai: { tools: [tool({ readOnly: undefined })] } }));
    expect(result.ok && result.manifest.ai?.tools?.[0]).toMatchObject({ readOnly: false, destructive: false });
  });

  it('reports tool problems', () => {
    expect(codes(app({ permissions: ['projects:read'], ai: { tools: [tool()] } }))).toEqual(['manifest.ai_tools_require_remote']);
    expect(codes(app({ remote, ai: { tools: [tool()] } }))).toEqual(['manifest.ai_tool_permission_missing']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: [tool({ name: 'Bad' })] } }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: [tool(), tool()] } }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: [tool({ destructive: true })] } }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: [tool({ input: { type: 'string' } })] } }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: [tool({ input: { type: 'object', properties: { a: { $ref: 'https://x/y.json' } } } })] } }))).toEqual(['manifest.ai_tool_invalid']);
    expect(codes(app({ remote, permissions: ['projects:read'], ai: { tools: Array.from({ length: 17 }, (_, i) => tool({ name: `t${i}` })) } }))).toEqual(['manifest.ai_tool_invalid']);
  });

  it('builds exposed names', () => {
    expect(appToolSlug('com.example.team-standup')).toBe('teamstandup');
    expect(appToolName('com.example.team-standup', 'standup_summary')).toBe('app_teamstandup_standup_summary');
    expect(appToolName('com.example.team-standup', 'standup_summary', { collision: 'a1b2c3d4-0000-4000-8000-000000000000' })).toBe('app_teamstandup_standup_summary_a1b2');
    const long = appToolName('com.example.averyveryverylongappname', 'x'.repeat(32), { collision: 'ffff0000' });
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
    expect(long.endsWith('_ffff')).toBe(true);
  });
});

describe('server (Phase 3 §8.1)', () => {
  const server = {
    entry: 'server/index.ts',
    schedules: [{ name: 'daily', cron: '0 9 * * 1-5', timeZone: 'Europe/Istanbul', function: 'dailyDigest' }],
    events: { 'project.task.created': 'onTaskCreated' },
    hooks: [{ name: 'github', function: 'onGithub', verify: { kind: 'hmac-sha256', header: 'x-hub-signature-256', secretSetting: 'githubSecret' } }],
  };
  const settings = { githubSecret: { type: 'string', label: 'GitHub secret', secret: true } };

  it('validates the contract example (backend on by default, off with { backend: false })', () => {
    expect(validateManifest(app({ permissions: ['projects:read'], settings, server })).ok).toBe(true);
    expect(validateManifest(app({ permissions: ['projects:read'], settings, server }), { backend: true }).ok).toBe(true);
    expect(codes(app({ permissions: ['projects:read'], settings, server }), { backend: false })).toEqual(['manifest.feature_not_available']);
  });

  it('reports server problems', () => {
    expect(codes(app({ settings, server }))).toEqual(['manifest.event_permission_missing']);
    expect(codes(app({ permissions: ['projects:read'], server }))).toEqual(['manifest.server_invalid']);
    expect(codes(app({ permissions: ['projects:read'], settings, server: { ...server, schedules: [{ name: 'x', cron: '* * * * *', function: 'f' }] } }))).toEqual(['manifest.server_invalid']);
    expect(codes(app({ permissions: ['projects:read'], settings, server: { ...server, entry: '../x.ts' } }))).toEqual(['manifest.server_invalid']);
  });

  it('lists triggers and resolves handlers per §15.1', () => {
    const triggers = backendTriggers(server);
    expect(triggers).toEqual([
      { kind: 'schedule', name: 'daily', fallback: 'dailyDigest' },
      { kind: 'event', name: 'project.task.created', fallback: 'onTaskCreated' },
      { kind: 'hook', name: 'github', fallback: 'onGithub' },
    ]);
    const fn = () => null;
    expect(triggers.map((t) => backendHandlerResolves({ functions: { dailyDigest: fn, onTaskCreated: fn, onGithub: fn } }, t))).toEqual([true, true, true]);
    expect(triggers.map((t) => backendHandlerResolves({ schedules: { daily: fn }, events: { 'project.task.created': fn }, hooks: { github: fn } }, t))).toEqual([true, true, true]);
    expect(triggers.map((t) => backendHandlerResolves({ functions: { daily: fn, github: fn } }, t))).toEqual([false, false, false]);
    expect(backendHandlerResolves({ functions: {} }, { kind: 'hook', name: 'x', fallback: 'toString' })).toBe(false);
  });

  it('makes the trigger function optional and resolves maps first', () => {
    const mapsOnly = {
      entry: 'server/index.ts',
      schedules: [{ name: 'daily', cron: '0 9 * * *' }],
      hooks: [{ name: 'github', verify: { kind: 'hmac-sha256', header: 'x-signature-256', secretSetting: 'githubSecret' } }],
    };
    expect(validateManifest(app({ settings, server: mapsOnly })).ok).toBe(true);
    const triggers = backendTriggers(mapsOnly);
    expect(triggers).toEqual([{ kind: 'schedule', name: 'daily' }, { kind: 'hook', name: 'github' }]);
    const fn = () => null;
    expect(triggers.map((t) => backendHandlerResolves({ schedules: { daily: fn }, hooks: { github: fn } }, t))).toEqual([true, true]);
    // Without a fallback name, `functions` is never consulted.
    expect(triggers.map((t) => backendHandlerResolves({ functions: { daily: fn, github: fn, undefined: fn } }, t))).toEqual([false, false]);
  });

  it('keeps trigger fallback functions away from backend.call', () => {
    const manifest = { server };
    expect(backendCallable(manifest, 'summary')).toBe(true);
    expect(backendCallable(manifest, 'dailyDigest')).toBe(false);
    expect(backendCallable(manifest, 'onTaskCreated')).toBe(false);
    expect(backendCallable(manifest, 'onGithub')).toBe(false);
    expect(backendCallable({ server: { schedules: [{ name: 'daily' }] } }, 'daily')).toBe(true);
    expect(backendCallable({}, 'summary')).toBe(false);
    expect(backendCallable(null, 'summary')).toBe(false);
    expect(backendCallable(manifest, '../x')).toBe(false);
  });

  it('answers hooks the same way everywhere', () => {
    expect(backendHookResponse(undefined)).toEqual({ status: 202, headers: {}, body: '' });
    expect(backendHookResponse('ok')).toEqual({ status: 202, headers: {}, body: '' });
    expect(backendHookResponse({ body: 'x' })).toEqual({ status: 202, headers: {}, body: '' });
    expect(backendHookResponse({ status: 204 })).toEqual({ status: 204, headers: {}, body: '' });
    expect(backendHookResponse({ status: 200, body: 'pong' })).toEqual({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'pong' });
    expect(backendHookResponse({ status: 201, body: { ok: true } })).toEqual({ status: 201, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"ok":true}' });
    expect(backendHookResponse({ status: 302, headers: { Location: 'https://evil.example', 'Set-Cookie': 'a=b', 'X-Trace': '1', 'Content-Type': 'text/html' }, body: '<b>' }))
      .toEqual({ status: 302, headers: { 'x-trace': '1', 'content-type': 'text/html' }, body: '<b>' });
  });

  it('maps backend host methods and runtime errors', () => {
    expect(backendMethodAllowed('secrets.get', [])).toBe(true);
    expect(backendMethodAllowed('db.insert', ['db'])).toBe(true);
    expect(backendMethodAllowed('db.insert', [])).toBe(false);
    expect(backendMethodAllowed('ui.toast', [])).toBe(false);
    expect(backendMethodAllowed('storage.get', ['storage'])).toBe(false);
    expect(backendMethodAllowed('backend.call', [])).toBe(false);
    expect(backendMethodAllowed('http.fetch', ['http:api.github.com'], 'https://api.github.com/x')).toBe(true);
    expect(backendCallErrorCode('not_found')).toBe('backend_function_not_found');
    expect(backendCallErrorCode('cpu_limit')).toBe('backend_limit');
    expect(backendCallErrorCode('concurrency_limit')).toBe('backend_busy');
    expect(backendCallErrorCode('runtime_unavailable')).toBe('backend_unavailable');
    expect(backendCallErrorCode('migrating')).toBe('backend_migrating');
    expect(backendCallErrorCode('something_new')).toBe('backend_error');
  });

  it('checks cron expressions', () => {
    expect(cronProblems('0 9 * * 1-5')).toEqual([]);
    expect(cronProblems('*/5 * * * *')).toEqual([]);
    expect(cronProblems('*/2 * * * *')).toHaveLength(1);
    expect(cronProblems('0,3 * * * *')).toHaveLength(1);
    expect(cronProblems('0 0 1 jan mon')).toEqual([]);
    expect(cronProblems('61 * * * *')).toHaveLength(1);
    expect(cronProblems('* * *')).toHaveLength(1);
  });
});

describe('cards (Phase 3 §3.2)', () => {
  const card = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, root: 1, nodes, fallbackText: 'Standup', ...extra });
  const text = (id: number, value: string) => [
    { id, type: 'Text', props: {}, children: [id + 100] },
    { id: id + 100, type: '#text', props: { text: value }, children: [] },
  ];

  it('accepts a card with open and submit buttons', () => {
    const nodes = [
      { id: 1, type: 'Card', props: { title: 'Standup' }, children: [2, 3, 4] },
      ...text(2, 'Bugün'),
      { id: 3, type: 'Button', props: { label: 'Aç', action: { kind: 'open', payload: { day: 1 } } }, children: [] },
      { id: 4, type: 'Button', props: { label: 'Tamam', variant: 'primary', action: { kind: 'submit', name: 'done' } }, children: [] },
    ];
    expect(validateCard(card(nodes)).ok).toBe(true);
    const noRemote = validateCard(card(nodes), { remote: false });
    expect(noRemote.ok ? [] : noRemote.issues.map((issue) => issue.code)).toEqual(['card.submit_requires_remote']);
  });

  it('rejects handlers, inputs, bad actions and limits', () => {
    const codesOf = (input: unknown) => {
      const result = validateCard(input);
      return result.ok ? [] : result.issues.map((issue) => issue.code);
    };
    expect(codesOf(card([{ id: 1, type: 'TextField', props: { name: 'a', label: 'A' }, children: [] }]))).toContain('card.component_not_allowed');
    expect(codesOf(card([{ id: 1, type: 'Button', props: { label: 'x', onPress: { $handler: 1 } }, children: [] }]))).toEqual(['card.handler_not_allowed']);
    expect(codesOf(card([{ id: 1, type: 'Button', props: { label: 'x', action: { kind: 'call' } }, children: [] }]))).toEqual(['card.action_invalid']);
    expect(codesOf(card([{ id: 1, type: 'Button', props: { label: 'x', action: { kind: 'open', payload: 'x'.repeat(3000) } }, children: [] }]))).toEqual(['card.payload_too_large']);
    expect(codesOf(card([{ id: 1, type: 'Badge', props: { text: 'x', color: 'red' }, children: [] }]))).toEqual(['tree.unknown_prop']);
    expect(codesOf(card([{ id: 1, type: 'Badge', props: { text: 'x' }, children: [] }], { fallbackText: '' }))).toEqual(['card.fallback_text']);
    expect(codesOf({ version: 2, root: 1, nodes: [], fallbackText: 'x' })).toContain('card.invalid');
    const many = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, type: 'Stack', props: {}, children: i < 100 ? [i + 2] : [] }));
    expect(codesOf(card(many))).toEqual(expect.arrayContaining(['card.too_many_nodes', 'card.too_deep']));
    expect(codesOf(card([{ id: 1, type: 'Text', props: { text: 'x'.repeat(17000) }, children: [] }]))).toEqual(['card.too_large']);
  });
});

describe('signed requests (Phase 3 §4, §5.3)', () => {
  it('formats and parses Standard Webhooks signatures', () => {
    expect(webhookSignedContent('evt_1', 1792224000, '{"a":1}')).toBe('evt_1.1792224000.{"a":1}');
    expect(formatWebhookSignature(['AAA', 'BBB'])).toBe('v1a,AAA v1a,BBB');
    expect(parseWebhookSignature('v1,xyz v1a,AAA  v1a,BBB')).toEqual(['AAA', 'BBB']);
    expect(parseWebhookSignature(undefined)).toEqual([]);
    expect(clientAssertionAudience('https://olan.example.com/')).toBe('https://olan.example.com/api/v2/apps/oauth/token');
  });
});
