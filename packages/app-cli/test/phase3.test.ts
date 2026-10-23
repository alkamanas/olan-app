// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { createOlanServer, fromNodeRequest, sendNodeResponse, ToolError } from '@olan-app/sdk/server';
import type { JsonValue } from '@olan-app/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli';
import { CliError } from '../src/errors';
import { createMockHost, defaultFixtures, type MockHost } from '../src/mock-server';
import { callDevTool, sendDevEvent, toolInputProblems } from '../src/remote-dev';
import { renderApp } from '../src/testing';
import { manifest, tempProject, TMP_ROOT } from './helpers';

const CARD: { [key: string]: JsonValue } = {
  version: 1,
  root: 1,
  fallbackText: 'Standup',
  nodes: [
    { id: 1, type: 'Card', props: { title: 'Standup' }, children: [2] },
    { id: 2, type: 'Button', props: { label: 'Tamam', action: { kind: 'submit', name: 'done' } }, children: [] },
  ],
};

function host(permissions: string[], extra: Parameters<typeof createMockHost>[0] = {}): MockHost {
  return createMockHost({ fixtures: defaultFixtures(), permissions, appId: 'com.example.test-app', ...extra });
}

describe('mock host Phase 3 RPCs', () => {
  it('reads calendars and events and protects system records', async () => {
    const mock = host(['calendar:read', 'calendar:write', 'calendar:delete']);
    expect(await mock.handle('calendar.calendars', {})).toMatchObject({ ok: true, result: { calendars: [{ id: 'cal-0', isDefault: true }, { id: 'cal-p0' }] } });
    const events = await mock.handle('calendar.events', { from: '2026-10-19', to: '2026-10-21' });
    expect(events.ok && (events.result as { events: { id: string }[] }).events.map((event) => event.id)).toEqual(['ev-0', 'ev-meeting', 'ev-invite']);
    expect(await mock.handle('calendar.events', { from: '2026-01-01', to: '2027-06-01' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await mock.handle('calendar.deleteEvent', { eventId: 'ev-meeting' })).toMatchObject({ ok: false, error: { code: 'forbidden_record', message: expect.stringContaining('system_record') } });
    expect(await mock.handle('calendar.updateEvent', { eventId: 'ev-invite', patch: { title: 'x' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('not_organizer') } });
    expect(await mock.handle('calendar.deleteEvent', { eventId: 'ev-p0' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('system_record') } });
    const created = await mock.handle('calendar.createEvent', { title: 'Standup notu', start: '2026-10-21T09:00:00Z', duration: 'PT15M' });
    expect(created).toMatchObject({ ok: true, result: { calendarId: 'cal-0', end: '2026-10-21T09:15:00.000Z', createdByApp: 'com.example.test-app', isOrganizer: true } });
    expect(await mock.handle('calendar.createEvent', { title: 'x', start: '2026-10-21T09:00:00Z', participants: ['a@example.com'] } as never)).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    const id = (created as unknown as { result: { id: string } }).result.id;
    expect(await mock.handle('calendar.deleteEvent', { eventId: id })).toEqual({ ok: true, result: null });
    expect(mock.audit()).toEqual([
      { action: 'record.delete_denied', detail: { kind: 'event', recordId: 'ev-meeting', reason: 'system_record' } },
      { action: 'record.delete_denied', detail: { kind: 'event', recordId: 'ev-p0', reason: 'system_record' } },
      { action: 'record.delete', detail: { kind: 'event', recordId: id, title: 'Standup notu' } },
    ]);
    expect(await host(['calendar:read']).handle('calendar.deleteEvent', { eventId: 'ev-0' })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  });

  it('keeps the own-records switch for events and contacts', async () => {
    const mock = host(['calendar:delete', 'contacts:delete'], { deleteOwnRecordsOnly: true });
    expect(await mock.handle('calendar.deleteEvent', { eventId: 'ev-0' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('not_created_by_app') } });
    expect(await mock.handle('contacts.delete', { contactId: 'ct-0' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('not_created_by_app') } });
  });

  it('searches, creates and protects contacts', async () => {
    const mock = host(['contacts:read', 'contacts:write', 'contacts:delete']);
    expect(await mock.handle('contacts.search', { query: 'ayşe' })).toMatchObject({ ok: true, result: { contacts: [{ id: 'ct-0' }] } });
    expect(await mock.handle('contacts.update', { contactId: 'ct-company', patch: { name: 'x' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('system_record') } });
    expect(await mock.handle('contacts.create', { addressBookId: 'ab-company', name: 'x' })).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    const created = await mock.handle('contacts.create', { name: 'Mehmet', emails: ['m@example.com'] });
    expect(created).toMatchObject({ ok: true, result: { addressBookId: 'ab-0', createdByApp: 'com.example.test-app' } });
    expect(await mock.handle('contacts.delete', { contactId: (created as unknown as { result: { id: string } }).result.id })).toEqual({ ok: true, result: null });
  });

  it('reads only the mail message of the invocation context, and meetings', async () => {
    const opened = host(['mail:read', 'meetings:read'], { surfaceParams: { messageId: 'mail-0' } });
    expect(await opened.handle('mail.getMessage', { messageId: 'mail-0' })).toMatchObject({ ok: true, result: { subject: 'Teklif hakkında', textBody: expect.stringContaining('teklif') } });
    expect(await opened.handle('mail.getMessage', { messageId: 'mail-9' })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await opened.handle('meetings.get', { meetingId: 'mt-0' })).toMatchObject({ ok: true, result: { title: 'Ürün toplantısı', participants: [{ role: 'organizer' }] } });
  });

  it('creates projects and archives only its own', async () => {
    const mock = host(['projects:create', 'projects:archive', 'projects:read']);
    const created = await mock.handle('projects.create', { title: 'Standup' });
    expect(created).toMatchObject({ ok: true, result: { name: 'Standup', createdByApp: 'com.example.test-app' } });
    const id = (created as unknown as { result: { id: string } }).result.id;
    expect(await mock.handle('projects.archive', { projectId: 'p0' })).toMatchObject({ ok: false, error: { code: 'forbidden_record' } });
    expect(await mock.handle('projects.archive', { projectId: id })).toEqual({ ok: true, result: null });
    expect(await mock.handle('projects.archive', { projectId: id })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(mock.audit().map((entry) => [entry.action, entry.detail.reason ?? entry.detail.kind])).toEqual([
      ['record.delete_denied', 'not_created_by_app'],
      ['record.delete', 'project'],
    ]);
  });

  it('posts and updates cards (validateCard; submit needs remote)', async () => {
    const mock = host(['chat:write'], { surfaceParams: { conversationId: 'c-1' } });
    expect(await mock.handle('chat.postCard', { conversationId: 'c-1', card: CARD })).toMatchObject({ ok: false, error: { code: 'validation_failed', message: expect.stringContaining('card.submit_requires_remote') } });
    const withRemote = host(['chat:write'], { surfaceParams: { conversationId: 'c-1' }, remote: true });
    const posted = await withRemote.handle('chat.postCard', { conversationId: 'c-1', card: CARD });
    expect(posted).toMatchObject({ ok: true, result: { messageId: expect.any(String) } });
    expect(await withRemote.handle('chat.postCard', { conversationId: 'elsewhere', card: CARD })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const messageId = (posted as unknown as { result: { messageId: string } }).result.messageId;
    expect(await withRemote.handle('chat.updateCard', { messageId, card: { ...CARD, fallbackText: 'Bitti' } })).toEqual({ ok: true, result: { messageId } });
    expect(withRemote.cards).toEqual([expect.objectContaining({ messageId, conversationId: 'c-1', card: expect.objectContaining({ fallbackText: 'Bitti' }) })]);
    expect(await withRemote.handle('backend.call', { name: 'x' })).toMatchObject({ ok: false, error: { code: 'backend_unavailable' } });
  });

  it('checks ref:* fields against the fixtures (§9)', async () => {
    const data = {
      version: 1,
      collections: {
        notes: { scope: 'organization' as const, fields: { title: { type: 'string' as const }, projectId: { type: 'ref:project' as const }, taskId: { type: 'ref:task' as const }, ownerId: { type: 'ref:user' as const } } },
      },
    };
    const projects = [{ id: '11111111-1111-4111-8111-111111111111', name: 'P', tasks: [{ id: '22222222-2222-4222-8222-222222222222', title: 'T' }] }];
    const mock = createMockHost({ fixtures: { projects }, data, permissions: ['db'] });
    const ok = await mock.handle('db.insert', { collection: 'notes', data: { title: 'a', projectId: projects[0]!.id.toUpperCase(), taskId: projects[0]!.tasks[0]!.id, ownerId: '00000000-0000-4000-8000-000000000001' } });
    expect(ok.ok).toBe(true);
    expect(await mock.handle('db.insert', { collection: 'notes', data: { title: 'b', projectId: '33333333-3333-4333-8333-333333333333' } })).toEqual({ ok: false, error: { code: 'validation_failed', message: 'data.projectId: ref.not_found' } });
    const row = (ok as unknown as { result: { id: string; revision: number } }).result;
    // Unchanged refs are not checked again; changed ones are.
    expect((await mock.handle('db.update', { collection: 'notes', id: row.id, revision: row.revision, patch: { title: 'c' } })).ok).toBe(true);
    expect(await mock.handle('db.update', { collection: 'notes', id: row.id, revision: row.revision + 1, patch: { taskId: '44444444-4444-4444-8444-444444444444' } })).toMatchObject({ ok: false, error: { message: 'data.taskId: ref.not_found' } });
  });
});

const SURFACE_APP = `
import { defineApp, Screen, Text, Button, useSurfaceParams, useQuery, olan } from '@olan-app/sdk';

function Action() {
  const { message } = useSurfaceParams<'chat.action'>();
  return <Screen title="Eylem"><Text text={'Mesaj: ' + (message.body ?? '')} /></Screen>;
}

function Sidebar() {
  const params = useSurfaceParams<'mail.sidebar'>();
  const full = useQuery(() => olan.mail.getMessage(params.messageId), [params.messageId]);
  return <Screen title="Posta"><Text text={'Konu: ' + params.subject} /><Text text={'Gövde: ' + (full.data?.textBody ?? full.error?.code ?? '…')} /></Screen>;
}

function Command() {
  const params = useSurfaceParams<'chat.command'>();
  return (
    <Screen title="Komut">
      <Button label="Kart gönder" onPress={async () => {
        await olan.chat.postCard({ conversationId: params.conversationId, card: { version: 1, root: 1, nodes: [{ id: 1, type: 'Card', props: { title: 'Standup' }, children: [] }], fallbackText: 'Standup' } });
        await olan.ui.toast({ text: 'Gönderildi' });
      }} />
    </Screen>
  );
}

export default defineApp({ 'chat.action': Action, 'mail.sidebar': Sidebar, 'chat.command': Command });
`;

describe('Phase 3 surfaces in renderApp and validate --strict', () => {
  const project = tempProject('phase3-surfaces', {
    'olan-app.json': manifest({
      sdk: '^1.4.0',
      surfaces: { 'chat.action': { title: 'Ekle' }, 'mail.sidebar': { title: 'Müşteri' }, 'chat.command': { title: 'Standup', command: 'standup' } },
      permissions: ['mail:read', 'chat:write'],
    }),
    'src/app.tsx': SURFACE_APP,
  });
  afterAll(() => project.remove());

  it('opens surfaces with default params from the fixtures and updates panels in place', async () => {
    const action = await renderApp({ root: project.dir, surface: 'chat.action' });
    action.expectText('Mesaj: Yarın 10:00 standup');
    await action.dispose();
    const sidebar = await renderApp({ root: project.dir, surface: 'mail.sidebar', fixtures: { mail: [...(defaultFixtures().mail ?? []), { id: 'mail-1', subject: 'Fatura', textBody: 'Ekte fatura' }] } });
    sidebar.expectText('Konu: Teklif hakkında');
    await sidebar.waitForText('Gövde: Merhaba');
    await sidebar.setParams({ messageId: 'mail-1', threadId: null, subject: 'Fatura', from: { name: null, email: 'a@example.com' }, to: [], cc: [], receivedAt: '2026-10-17T09:00:00Z' });
    await sidebar.waitForText('Gövde: Ekte fatura');
    sidebar.expectText('Konu: Fatura');
    await sidebar.dispose();
    const command = await renderApp({ root: project.dir, surface: 'chat.command' });
    await command.press('Kart gönder');
    expect(command.host.cards).toHaveLength(1);
    expect(command.toasts()).toEqual([{ text: 'Gönderildi' }]);
    await command.dispose();
  });

  it('validates the Phase 3 surfaces with --strict', async () => {
    let output = '';
    const code = await runCli(['validate', '--strict', '--json', '--cwd', project.dir], { stdout: (text) => (output += text), stderr: () => {}, cwd: project.dir, env: process.env });
    const parsed = JSON.parse(output);
    expect(parsed.errors ?? []).toEqual([]);
    expect(code).toBe(0);
    expect(parsed.result.surfaces.map((surface: { surface: string }) => surface.surface)).toEqual(['chat.action', 'chat.command', 'mail.sidebar']);
  }, 60_000);
});

describe('events send / tools call against an app server', () => {
  const env = { ...process.env, OLAN_APP_DEV_KEY: join(TMP_ROOT, `dev-key-${process.pid}.json`) };
  let server: Server;
  let base = '';
  const received: { type: string; installationId: string }[] = [];
  const project = tempProject('phase3-remote', {});

  beforeAll(async () => {
    const olan = createOlanServer({ appId: 'com.example.test-app', issuers: (issuer) => issuer.startsWith('http://127.0.0.1:') });
    server = createServer(async (req, res) => {
      const request = await fromNodeRequest(req);
      if (req.url === '/olan/events') {
        return sendNodeResponse(res, await olan.handleEvent(request, (event, context) => void received.push({ type: event.type, installationId: context.installationId })));
      }
      if (req.url?.startsWith('/olan/ai-tools/')) {
        return sendNodeResponse(
          res,
          await olan.handleToolCall(request, {
            standup_summary: async (input, context) => ({ result: { projectId: input.projectId ?? null, token: context.token.accessToken }, summary: 'Özet hazır' }),
            failing: async () => {
              throw new ToolError('not_found', 'Proje yok');
            },
          }),
        );
      }
      if (req.url === '/broken/ai-tools/standup_summary') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"result":1}');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    project.write(
      'olan-app.json',
      manifest({
        sdk: '^1.4.0',
        permissions: ['projects:read'],
        remote: { url: `${base}/olan`, jwksUrl: `${base}/jwks.json` },
        events: ['project.task.created'],
        ai: {
          tools: [
            { name: 'standup_summary', description: 'Özet', input: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false }, permissions: ['projects:read'], readOnly: true },
            { name: 'failing', description: 'Hata', input: { type: 'object' } },
          ],
        },
      }),
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    project.remove();
  });

  it('delivers a signed event the SDK verifier accepts', async () => {
    const { requireManifest } = await import('../src/project');
    const result = await sendDevEvent(project.dir, requireManifest(project.dir), { type: 'project.task.created', issuerPort: 0, env });
    expect(result.delivery.status).toBe(200);
    expect(result.warnings).toEqual([]);
    expect(received.at(-1)).toEqual({ type: 'project.task.created', installationId: '00000000-0000-4000-8000-0000000000a1' });
    expect((result.event.data as { projectId: string }).projectId).toBe('p0');
    // Same webhook-id again: acknowledged as a duplicate.
    const again = await sendDevEvent(project.dir, requireManifest(project.dir), { type: 'project.task.created', id: String(result.event.id), attempt: 2, issuerPort: 0, env });
    expect(again.delivery.json).toEqual({ ok: true, duplicate: true });
    const unsubscribed = await sendDevEvent(project.dir, requireManifest(project.dir), { type: 'meeting.started', issuerPort: 0, env });
    expect(unsubscribed.warnings.map((warning) => warning.code)).toEqual(['events.not_subscribed', 'events.permission_missing']);
  });

  it('runs `olan-app events send` and reports rejected deliveries', async () => {
    let output = '';
    const io = { stdout: (text: string) => (output += text), stderr: () => {}, cwd: project.dir, env };
    expect(await runCli(['events', 'send', 'app.installed', '--issuer-port', '0', '--json'], io)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, result: { type: 'app.installed', status: 200 } });
    output = '';
    expect(await runCli(['events', 'send', 'app.installed', '--to', `${base}/missing`, '--issuer-port', '0', '--json'], io)).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, errors: [{ code: 'events.delivery_failed' }] });
    output = '';
    expect(await runCli(['events', 'send', 'mail.received', '--json'], io)).toBe(1);
    expect(JSON.parse(output).errors[0].code).toBe('events.unknown_type');
  });

  it('calls tools and checks inputs and answers', async () => {
    const { requireManifest } = await import('../src/project');
    const app = requireManifest(project.dir);
    const ok = await callDevTool(app, { name: 'standup_summary', input: { projectId: 'p1' }, issuerPort: 0, env });
    expect(ok.response).toEqual({ ok: true, result: { projectId: 'p1', token: 'olan-app-dev-token' }, summary: 'Özet hazır' });
    const failed = await callDevTool(app, { name: 'failing', input: {}, issuerPort: 0, env });
    expect(failed.response).toEqual({ ok: false, error: { code: 'not_found', message: 'Proje yok' } });
    await expect(callDevTool(app, { name: 'standup_summary', input: { projectId: 1 } as never, issuerPort: 0, env })).rejects.toThrow(CliError);
    await expect(callDevTool(app, { name: 'nope', input: {}, issuerPort: 0, env })).rejects.toThrow(/no tool "nope"/);
    await expect(callDevTool(app, { name: 'standup_summary', input: { projectId: 'p1' }, to: `${base}/broken`, issuerPort: 0, env })).rejects.toThrow(/did not answer/);
    let output = '';
    const io = { stdout: (text: string) => (output += text), stderr: () => {}, cwd: project.dir, env };
    expect(await runCli(['tools', 'call', 'standup_summary', '--input', '{"projectId":"p2"}', '--issuer-port', '0', '--json'], io)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, result: { tool: 'standup_summary', response: { ok: true, result: { projectId: 'p2' } } } });
  });

  it('checks tool inputs against the schema', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' }, kind: { enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false };
    expect(toolInputProblems(schema, { n: 1, kind: 'a' })).toEqual([]);
    expect(toolInputProblems(schema, { n: 1.5, kind: 'c', extra: true })).toEqual(['n must be integer', 'kind must be one of "a", "b"', 'extra is not allowed']);
    expect(toolInputProblems(schema, {})).toEqual(['n is required']);
  });
});
