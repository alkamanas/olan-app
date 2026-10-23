// @vitest-environment node
// Phase 6 (second wave): the mock host answers olan.project.statuses/labels/fields/links/calendar/activity/
// approvals like the server (project-contributions.ts), with the host's error mapping.
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@olan-app/sdk/protocol';

import { createMockHost, defaultFixtures, DEFAULT_USER_ID, MOCK_INSTALLATION_ID, normalizeFixtures, type Fixtures } from '../src/mock-server';
import { defaultSurfaceParams } from '../src/testing';

const AYSE = '00000000-0000-4000-8000-000000000002';
const ALL = ['projects:read', 'tasks:write', 'projects:extend'];

const card = (text = 'SAT-7 · 4 ekran', action: JsonValue = { kind: 'open', payload: { id: 'SAT-7' } }): JsonValue => ({
  version: 1,
  root: 1,
  fallbackText: text,
  nodes: [
    { id: 1, type: 'Card', props: { title: text }, children: [2] },
    { id: 2, type: 'Button', props: { label: 'Aç', action }, children: [] },
  ],
});

function fixtures(): Fixtures {
  return {
    ...defaultFixtures(),
    projects: [
      {
        id: 'office',
        name: 'Ofis',
        taskKeyPrefix: 'OFS',
        members: [
          { userId: DEFAULT_USER_ID, displayName: 'Utku', role: 'owner' },
          { userId: AYSE, displayName: 'Ayşe', role: 'manager' },
          { userId: 'guest-1', displayName: 'Misafir', role: 'guest' },
        ],
        tasks: [
          { id: 't1', title: 'Masa', status: 'needs-action' },
          { id: 't2', title: 'Ekran', status: 'in-process' },
        ],
        issues: [{ id: 'i1', title: 'Klima bozuk' }],
        statuses: [{ key: 'review', name: 'İncelemede', category: 'started' }],
        labels: [{ key: 'hardware', name: 'Donanım' }, { name: 'Ekip', app: false }],
      },
      { id: 'hidden', name: 'Gizli', enabled: false, tasks: [{ id: 'h1', title: 'Gizli görev' }] },
      { id: 'old', name: 'Arşiv', archived: true, tasks: [{ id: 'o1', title: 'Eski' }] },
    ],
  };
}

const ok = async (host: ReturnType<typeof createMockHost>, method: string, params: Record<string, unknown>) => {
  const outcome = await host.handle(method, params as never);
  if (!outcome.ok) throw new Error(`${method}: ${outcome.error.code} ${outcome.error.message}`);
  return outcome.result as never;
};

describe('project contributions on the mock host', () => {
  it('normalizes the fixtures: default statuses, the app\'s statuses and labels, issue keys, task statuses', () => {
    const data = normalizeFixtures(fixtures(), { id: 'com.example.records', name: 'Kayıtlar' });
    expect(data.projectStatuses.office!.map((status) => status.key)).toEqual(['todo', 'in_progress', 'review', 'done', 'cancelled']);
    expect(data.projectStatuses.office!.find((status) => status.key === 'review')).toMatchObject({ appInstallationId: MOCK_INSTALLATION_ID, createdByApp: 'com.example.records', color: '#E0A526' });
    expect(data.projectLabels.office!.map((label) => [label.name, label.appInstallationId])).toEqual([['Donanım', MOCK_INSTALLATION_ID], ['Ekip', null]]);
    expect(data.projectIssues.office).toEqual([{ id: 'i1', projectId: 'office', number: 1, key: 'OFS-#1', title: 'Klima bozuk', kind: null, state: 'open', stateReason: null, inTriage: false }]);
    expect(data.taskStatusIds).toMatchObject({ t1: 'office-status-todo', t2: 'office-status-in_progress' });
    // The default sample projects have one issue each (the issue.action sample).
    expect(normalizeFixtures(defaultFixtures()).projectIssues.p0).toHaveLength(1);
  });

  it('builds task.action, issue.action and record.card params from the fixtures', () => {
    const data = normalizeFixtures(fixtures());
    expect(defaultSurfaceParams('task.action', data)).toEqual({
      projectId: 'office',
      task: { id: 't1', key: null, title: 'Masa', status: 'needs-action', statusId: 'office-status-todo', statusCategory: 'unstarted', assigneeId: null, due: null },
    });
    expect(defaultSurfaceParams('issue.action', data)).toMatchObject({ projectId: 'office', issue: { id: 'i1', key: 'OFS-#1', number: 1, state: 'open', inTriage: false } });
    expect(defaultSurfaceParams('record.card', data)).toEqual({ projectId: 'office', linkId: 'link-0', target: { kind: 'task', id: 't1' }, externalId: 'record-0', payload: null });
  });

  it('checks permissions and enabled projects', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ['projects:read'] });
    expect(await host.handle('project.statuses.define', { projectId: 'office', statuses: [{ key: 'x', name: 'X', category: 'started' }] })).toMatchObject({ ok: false, error: { code: 'permission_denied', message: 'The app needs the projects:extend permission' } });
    expect(await host.handle('project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'A', card: card() })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await host.handle('project.statuses.list', { projectId: 'hidden' })).toMatchObject({ ok: false, error: { code: 'project_not_enabled' } });
    host.permissions = ['projects:read', 'projects:write'];
    // links.setStatus also accepts the older projects:write (like projects.updateTask).
    expect(await host.handle('project.links.setStatus', { projectId: 'office', linkId: 'nope', status: 'completed' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('defines, updates and removes the app\'s statuses', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ALL, appId: 'com.example.records' });
    const mine = await ok(host, 'project.statuses.define', { projectId: 'office', statuses: [{ key: 'waiting', name: 'Bekliyor', category: 'started' }, { key: 'review', name: 'Kontrol', category: 'started', color: '#112233' }] });
    expect((mine as { key: string; name: string; color: string }[]).map((status) => [status.key, status.name, status.color])).toEqual([['review', 'Kontrol', '#112233'], ['waiting', 'Bekliyor', '#E0A526']]);
    expect(host.data.projectActivity.office!.at(-1)).toMatchObject({ type: 'PROJECT_UPDATED', text: 'Bekliyor, Kontrol' });
    const error = async (statuses: unknown[]) => ((await host.handle('project.statuses.define', { projectId: 'office', statuses } as never)) as { error?: { code: string; message: string } }).error;
    expect(await error([{ key: 'todo', name: 'Benim', category: 'unstarted' }])).toMatchObject({ code: 'conflict', message: expect.stringContaining('status_key_taken') });
    expect(await error([{ key: 'mine', name: 'yapılacak', category: 'unstarted' }])).toMatchObject({ code: 'conflict', message: expect.stringContaining('status_name_taken') });
    expect(await error([{ key: 'review', name: 'Kontrol', category: 'completed' }])).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('status_category_immutable') });
    expect(await error([{ key: 'Bad Key', name: 'X', category: 'started' }])).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('invalid_key') });
    expect(await error([])).toMatchObject({ code: 'invalid_params' });
    // A failed call changes nothing (the server's transaction).
    expect(await error([{ key: 'fresh', name: 'Yeni', category: 'started' }, { key: 'todo', name: 'X', category: 'unstarted' }])).toMatchObject({ code: 'conflict' });
    expect(host.data.projectStatuses.office!.some((status) => status.key === 'fresh')).toBe(false);
    expect(await host.handle('project.statuses.define', { projectId: 'old', statuses: [{ key: 'x', name: 'X', category: 'started' }] })).toMatchObject({ ok: false, error: { code: 'conflict' } });

    // Removing moves its tasks to a status of the same task value.
    const link = await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't2' }, externalId: 'R1', card: card() }) as { id: string };
    await ok(host, 'project.links.setStatus', { projectId: 'office', linkId: link.id, statusKey: 'waiting' });
    expect(await ok(host, 'project.statuses.remove', { projectId: 'office', key: 'waiting', replacementKey: 'review' })).toEqual({ movedTasks: 1 });
    expect(host.data.taskStatusIds.t2).toBe('office-status-review');
    expect(await host.handle('project.statuses.remove', { projectId: 'office', key: 'todo' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await host.handle('project.statuses.remove', { projectId: 'office', key: 'review', replacementKey: 'done' })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('invalid_replacement_status') } });
  });

  it('defines labels, taking over its template labels by name', async () => {
    const host = createMockHost({
      fixtures: { ...fixtures(), projects: [{ id: 'office', name: 'Ofis', labels: [{ name: 'Mobilya' }, { name: 'Ekip', app: false }] }] },
      permissions: ALL,
    });
    const labels = await ok(host, 'project.labels.define', { projectId: 'office', labels: [{ key: 'furniture', name: 'Mobilya', groupName: 'Tür' }, { key: 'it', name: 'BT' }] }) as { key: string; groupName: string | null }[];
    expect(labels.map((label) => [label.key, label.groupName])).toEqual([['furniture', 'Tür'], ['it', null]]);
    expect(host.data.projectLabels.office).toHaveLength(3);
    expect(await host.handle('project.labels.define', { projectId: 'office', labels: [{ key: 'team', name: 'ekip' }] })).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('label_name_taken') } });
    expect(await ok(host, 'project.labels.remove', { projectId: 'office', key: 'it' })).toBeNull();
    expect(await host.handle('project.labels.remove', { projectId: 'office', key: 'it' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('defines the app\'s custom fields and sets values of tasks and issues', async () => {
    const host = createMockHost({
      fixtures: {
        ...fixtures(),
        projects: [{
          ...(fixtures().projects![0] as object),
          id: 'office',
          name: 'Ofis',
          fields: [{ name: 'Bütçe', type: 'number', app: false }],
          fieldValues: [{ target: { kind: 'task', id: 't2' }, values: { 'office-field-0': 1200 } }],
        } as never],
      },
      permissions: ALL,
    });
    const data = normalizeFixtures({ ...fixtures(), projects: [{ id: 'office', name: 'Ofis', fields: [{ key: 'size', name: 'Boyut', type: 'select', options: [{ name: 'Büyük Boy' }] }] }] });
    expect(data.projectFields.office).toMatchObject([{ key: 'size', options: [{ id: 'buyuk-boy' }], appliesTo: ['task'], appInstallationId: MOCK_INSTALLATION_ID }]);
    const defined = await ok(host, 'project.fields.define', {
      projectId: 'office',
      fields: [
        { key: 'channel', name: 'Kanal', type: 'select', options: [{ name: 'Instagram Reels' }, { id: 'tt', name: 'TikTok' }], showOnCard: true },
        { key: 'reach', name: 'Erişim', type: 'number', required: true, appliesTo: ['task', 'issue'] },
      ],
    }) as { key: string; options: { id: string }[]; appliesTo: string[]; position: number }[];
    expect(defined.map((field) => [field.key, field.options.map((option) => option.id), field.appliesTo, field.position])).toEqual([
      ['channel', ['instagram-reels', 'tt'], ['task'], 1],
      ['reach', [], ['task', 'issue'], 2],
    ]);
    expect(await ok(host, 'project.fields.list', { projectId: 'office' })).toHaveLength(3);
    expect(await host.handle('project.fields.define', { projectId: 'office', fields: [{ key: 'channel', name: 'Kanal', type: 'text' }] })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('field_type_immutable') } });
    expect(await host.handle('project.fields.define', { projectId: 'office', fields: [{ key: 'budget', name: 'bütçe', type: 'number' }] })).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('field_name_taken') } });
    const onTask = { kind: 'task', id: 't2' };
    expect(await ok(host, 'project.fields.values', { projectId: 'office', target: onTask })).toEqual({ target: onTask, values: { 'office-field-0': 1200 } });
    expect(await ok(host, 'project.fields.setValues', { projectId: 'office', target: onTask, values: { channel: 'tt', reach: '1,5' } })).toEqual({ target: onTask, values: { 'office-field-0': 1200, channel: 'tt', reach: 1.5 } });
    expect(await host.handle('project.fields.setValues', { projectId: 'office', target: onTask, values: { channel: 'youtube' } })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('invalid_field_value') } });
    expect(await host.handle('project.fields.setValues', { projectId: 'office', target: onTask, values: { reach: null } })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('field_required') } });
    // `channel` is a task field only.
    expect(await host.handle('project.fields.setValues', { projectId: 'office', target: { kind: 'issue', id: 'i1' }, values: { channel: 'tt' } })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('invalid_field') } });
    expect(await ok(host, 'project.fields.remove', { projectId: 'office', key: 'channel' })).toBeNull();
    expect(await ok(host, 'project.fields.values', { projectId: 'office', target: onTask })).toEqual({ target: onTask, values: { 'office-field-0': 1200, reach: 1.5 } });
    expect(await host.handle('project.fields.remove', { projectId: 'office', key: 'channel' })).toMatchObject({ ok: false, error: { code: 'not_found', message: expect.stringContaining('field_not_found') } });
    expect(await host.handle('project.fields.values', { projectId: 'office', target: { kind: 'task', id: 'nope' } })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('links records with record cards and moves tasks and issues through them', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ALL, appId: 'com.example.records', appName: 'Kayıtlar' });
    const link = await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'SAT-7', card: card() }) as Record<string, unknown>;
    expect(link).toMatchObject({ id: 'link-1', installationId: MOCK_INSTALLATION_ID, appId: 'com.example.records', name: 'Kayıtlar', active: true, title: 'SAT-7 · 4 ekran', revision: 1, target: { kind: 'task', id: 't1' } });
    // The same record again replaces its card.
    expect(await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'SAT-7', card: card('SAT-7 · 5 ekran') })).toMatchObject({ id: 'link-1', title: 'SAT-7 · 5 ekran', revision: 2 });
    expect(host.data.projectActivity.office!.filter((line) => line.type === 'APP_RECORD_LINKED')).toHaveLength(1);
    // Record cards only open.
    expect(await host.handle('project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'X', card: card('X', { kind: 'submit', name: 'go' }) })).toMatchObject({ ok: false, error: { code: 'validation_failed', message: expect.stringContaining('invalid_card') } });
    expect(await host.handle('project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 'nope' }, externalId: 'X', card: card() })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await host.handle('project.links.upsert', { projectId: 'office', target: { kind: 'story', id: 't1' }, externalId: 'X', card: card() })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    for (let n = 0; n < 9; n += 1) await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: `N${n}`, card: card() });
    expect(await host.handle('project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'N10', card: card() })).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(await ok(host, 'project.links.list', { projectId: 'office', target: { kind: 'task', id: 't2' } })).toEqual([]);
    expect((await ok(host, 'project.links.list', { projectId: 'office' }) as unknown[]).length).toBe(10);

    expect(await ok(host, 'project.links.setStatus', { projectId: 'office', linkId: 'link-1', status: 'completed' })).toEqual({ target: { kind: 'task', id: 't1' }, status: 'completed', statusId: 'office-status-done', statusKey: 'done' });
    expect(host.data.projects[0]!.tasks[0]).toMatchObject({ status: 'completed', revision: 2 });
    expect(await host.handle('project.links.setStatus', { projectId: 'office', linkId: 'link-1', statusKey: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    const issueLink = await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'issue', id: 'i1' }, externalId: 'TCK-1', card: card('TCK-1') }) as { id: string };
    expect(await ok(host, 'project.links.setStatus', { projectId: 'office', linkId: issueLink.id, state: 'closed', stateReason: 'not_planned' })).toEqual({ target: { kind: 'issue', id: 'i1' }, state: 'closed' });
    expect(host.data.projectIssues.office![0]).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    expect(await host.handle('project.links.setStatus', { projectId: 'office', linkId: issueLink.id, status: 'completed' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    expect(await ok(host, 'project.links.remove', { projectId: 'office', linkId: issueLink.id })).toBeNull();
    expect(await host.handle('project.links.remove', { projectId: 'office', linkId: issueLink.id })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(host.data.projectActivity.office!.at(-1)).toMatchObject({ type: 'APP_RECORD_UNLINKED', text: 'TCK-1', target: { kind: 'issue', id: 'i1' } });
  });

  it('keeps the calendar layer and posts feed lines', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ALL });
    const link = await ok(host, 'project.links.upsert', { projectId: 'office', target: { kind: 'task', id: 't1' }, externalId: 'SAT-7', card: card() }) as { id: string };
    const item = await ok(host, 'project.calendar.upsert', { projectId: 'office', externalId: 'SAT-7', title: 'Teslim', start: '2026-11-02', allDay: true, linkId: link.id }) as Record<string, unknown>;
    expect(item).toMatchObject({ externalId: 'SAT-7', start: '2026-11-02T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z', allDay: true, color: null, linkId: link.id, target: { kind: 'task', id: 't1' } });
    await ok(host, 'project.calendar.upsert', { projectId: 'office', externalId: 'SAT-7', title: 'Teslim (ertelendi)', start: '2026-11-09', allDay: true, color: '#00ce9d' });
    await ok(host, 'project.calendar.upsert', { projectId: 'office', externalId: 'Q', title: 'Toplantı', start: '2027-01-10T09:00:00Z', end: '2027-01-10T10:00:00Z' });
    expect((await ok(host, 'project.calendar.list', { projectId: 'office', from: '2026-11-01', to: '2026-12-01' }) as { title: string; color: string }[]).map((entry) => [entry.title, entry.color])).toEqual([['Teslim (ertelendi)', '#00CE9D']]);
    expect(await host.handle('project.calendar.list', { projectId: 'office', from: '2026-01-01', to: '2027-06-01' })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('invalid_range') } });
    expect(await host.handle('project.calendar.upsert', { projectId: 'office', externalId: 'Z', title: 'Z', start: '2026-11-02', end: '2026-11-01' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('project.calendar.upsert', { projectId: 'office', externalId: 'Z', title: 'Z', start: '2026-11-02', linkId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await ok(host, 'project.calendar.remove', { projectId: 'office', externalId: 'Q' })).toBeNull();
    expect(await host.handle('project.calendar.remove', { projectId: 'office', externalId: 'Q' })).toMatchObject({ ok: false, error: { code: 'not_found' } });

    expect(await ok(host, 'project.activity.post', { projectId: 'office', text: '  SAT-7   teslim alındı ', target: { kind: 'task', id: 't1' } })).toBeNull();
    expect(host.data.projectActivity.office!.at(-1)).toMatchObject({ type: 'APP_ACTIVITY', text: 'SAT-7 teslim alındı', target: { kind: 'task', id: 't1' }, actorId: DEFAULT_USER_ID });
    expect(await host.handle('project.activity.post', { projectId: 'office', text: 'x'.repeat(281) })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('project.activity.post', { projectId: 'old', text: 'Arşivde' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('requests, lists, cancels and decides approvals (all / any)', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ALL });
    const any = await ok(host, 'project.approvals.request', { projectId: 'office', title: 'Satın alma', approverIds: [AYSE, DEFAULT_USER_ID], mode: 'any', externalId: 'SAT-7', card: card() }) as { id: string; state: string; projectName: string; approvers: string[] };
    expect(any).toMatchObject({ id: 'approval-1', state: 'pending', projectName: 'Ofis', approvers: [AYSE, DEFAULT_USER_ID], requestedBy: DEFAULT_USER_ID, decisions: [] });
    const all = await ok(host, 'project.approvals.request', { projectId: 'office', title: 'Bütçe', approverIds: [AYSE, DEFAULT_USER_ID] }) as { id: string };
    const cancelled = await ok(host, 'project.approvals.request', { projectId: 'office', title: 'İptal', approverIds: [AYSE] }) as { id: string };
    expect(await host.handle('project.approvals.request', { projectId: 'office', title: 'X', approverIds: ['guest-1'] })).toMatchObject({ ok: false, error: { code: 'invalid_params', message: expect.stringContaining('invalid_approvers') } });
    expect(await host.handle('project.approvals.request', { projectId: 'office', title: 'X', approverIds: [] })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(await host.handle('project.approvals.request', { projectId: 'office', title: 'X', approverIds: [AYSE], linkId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });

    expect(host.decideApproval('office', any.id, 'reject', { userId: AYSE, note: ' bütçe yok ' })).toMatchObject({ state: 'rejected', decisions: [{ userId: AYSE, decision: 'reject', note: 'bütçe yok' }] });
    expect(host.decideApproval('office', all.id, 'approve', { userId: AYSE }).state).toBe('pending');
    expect(() => host.decideApproval('office', all.id, 'approve', { userId: AYSE })).toThrow(/approval_already_decided/);
    expect(() => host.decideApproval('office', all.id, 'approve', { userId: 'guest-1' })).toThrow(/not_an_approver/);
    expect(host.decideApproval('office', all.id, 'approve').state).toBe('approved');

    expect(await ok(host, 'project.approvals.cancel', { projectId: 'office', approvalId: cancelled.id })).toMatchObject({ state: 'cancelled' });
    expect(await host.handle('project.approvals.cancel', { projectId: 'office', approvalId: cancelled.id })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await host.handle('project.approvals.cancel', { projectId: 'office', approvalId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // Newest first, as the server lists them.
    expect((await ok(host, 'project.approvals.list', { projectId: 'office' }) as { title: string }[]).map((approval) => approval.title)).toEqual(['İptal', 'Bütçe', 'Satın alma']);
    expect((await ok(host, 'project.approvals.list', { projectId: 'office', state: 'approved' }) as { title: string }[]).map((approval) => approval.title)).toEqual(['Bütçe']);
    expect(await host.handle('project.approvals.list', { projectId: 'office', state: 'done' })).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });

  it('serves the same methods to backend code', async () => {
    const host = createMockHost({ fixtures: fixtures(), permissions: ALL });
    expect(await host.handle('project.statuses.list', { projectId: 'office' }, { backend: true })).toMatchObject({ ok: true });
    expect(await host.handle('project.activity.post', { projectId: 'office', text: 'Gece eşitlemesi bitti' }, { backend: true })).toEqual({ ok: true, result: null });
    expect(await host.handle('project.fields.list', { projectId: 'office' }, { backend: true })).toEqual({ ok: true, result: [] });
  });
});
