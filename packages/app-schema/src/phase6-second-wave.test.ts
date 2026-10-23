import { describe, expect, it } from 'vitest';
import {
  BACKEND_HOST_METHODS,
  EVENT_TYPES,
  PROJECT_SURFACES,
  SURFACES,
  SURFACE_PRESENTATIONS,
  backendMethodAllowed,
  describePermission,
  eventDefinition,
  methodAllowed,
  permissionScope,
  validateManifest,
  validateRecordCard,
} from './index.js';

const app = (extra: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: 'com.example.brand-desk',
  name: 'Brand desk',
  version: '1.0.0',
  sdk: '^1.7.0',
  entry: 'dist/app.js',
  surfaces: { 'project.tab': {} },
  ...extra,
});

const template = (extra: Record<string, unknown> = {}) => ({
  key: 'campaign',
  name: 'Kampanya',
  content: {
    version: 1,
    lists: [{ key: 'plan', title: 'Plan', steps: [{ key: 'brief', title: 'Brief' }] }],
    statuses: [
      { key: 'idea', name: 'Fikir', color: '#8A94A6', category: 'unstarted' },
      { key: 'making', name: 'Hazırlanıyor', color: '#E0A526', category: 'started' },
      { key: 'live', name: 'Yayında', color: '#2F9E6E', category: 'completed' },
      { key: 'dropped', name: 'Vazgeçildi', color: '#A1A7B3', category: 'cancelled' },
    ],
    labels: [{ name: 'Instagram', color: '#F472B6', groupName: 'Kanal' }],
    tasks: [{ listKey: 'brief', title: 'Brief yaz', statusKey: 'idea', labels: ['Instagram'] }],
  },
  ...extra,
});

const card = (button: Record<string, unknown>) => ({
  version: 1,
  root: 0,
  fallbackText: 'Gönderi: Yaz kampanyası',
  nodes: [
    { id: 0, type: 'Card', props: {}, children: [1, 2] },
    { id: 1, type: 'Text', props: {}, children: [3] },
    { id: 3, type: '#text', props: { text: 'Yaz kampanyası' }, children: [] },
    { id: 2, type: 'Button', props: { label: 'Aç', action: button }, children: [] },
  ],
});

describe('project extensions, second wave (Phase 6)', () => {
  it('adds task and issue actions and the record card as project surfaces with a required title', () => {
    expect(SURFACES.slice(-3)).toEqual(['task.action', 'issue.action', 'record.card']);
    for (const surface of ['task.action', 'issue.action', 'record.card'] as const) {
      expect(SURFACE_PRESENTATIONS[surface]).toBe('modal');
      expect(PROJECT_SURFACES).toContain(surface);
      expect(validateManifest(app({ surfaces: { [surface]: { title: 'Gönderiye bağla' } } })).ok).toBe(true);
      expect(validateManifest(app({ surfaces: { [surface]: {} } })).ok).toBe(false);
    }
  });

  it('maps the new project methods to projects:read, tasks:write and projects:extend', () => {
    expect(methodAllowed('project.links.list', ['projects:read'])).toBe(true);
    expect(methodAllowed('project.links.upsert', ['projects:read'])).toBe(false);
    expect(methodAllowed('project.links.upsert', ['tasks:write'])).toBe(true);
    expect(methodAllowed('project.links.setStatus', ['projects:write'])).toBe(true);
    for (const method of ['project.statuses.define', 'project.labels.define', 'project.calendar.upsert', 'project.activity.post', 'project.approvals.request']) {
      expect(methodAllowed(method, ['tasks:write']), method).toBe(false);
      expect(methodAllowed(method, ['projects:extend']), method).toBe(true);
      expect(BACKEND_HOST_METHODS, method).toContain(method);
    }
    // Custom fields (1.8.0): the app defines its own, reads values with projects:read and writes them with tasks:write.
    for (const method of ['project.fields.define', 'project.fields.remove']) {
      expect(methodAllowed(method, ['projects:read']), method).toBe(false);
      expect(methodAllowed(method, ['projects:extend']), method).toBe(true);
    }
    expect(methodAllowed('project.fields.list', ['projects:read'])).toBe(true);
    expect(methodAllowed('project.fields.values', ['projects:read'])).toBe(true);
    expect(methodAllowed('project.fields.setValues', ['projects:read'])).toBe(false);
    expect(methodAllowed('project.fields.setValues', ['tasks:write'])).toBe(true);
    for (const method of ['project.fields.list', 'project.fields.define', 'project.fields.remove', 'project.fields.values', 'project.fields.setValues']) {
      expect(BACKEND_HOST_METHODS, method).toContain(method);
    }
    expect(backendMethodAllowed('project.approvals.list', ['projects:read'])).toBe(true);
    expect(permissionScope('projects:extend')).toBe('projects:write');
    expect(describePermission('projects:extend', 'tr').label).toBe('Projelere katkı');
  });

  it('adds task completion, issue and approval events', () => {
    for (const type of ['project.task.completed', 'project.issue.opened', 'project.issue.closed', 'project.issue.triaged', 'project.approval.decided']) {
      expect(EVENT_TYPES).toContain(type);
      expect(eventDefinition(type)?.permission).toBe('projects:read');
    }
    expect(eventDefinition('project.issue.opened')?.audience).toBe('project');
    expect(eventDefinition('project.approval.decided')?.audience).toBe('requester');
    const remote = { url: 'https://app.example.test', jwksUrl: 'https://app.example.test/jwks' };
    expect(validateManifest(app({ remote, permissions: ['projects:read'], events: ['project.issue.triaged', 'project.approval.decided'] })).ok).toBe(true);
  });

  it('accepts project templates and rejects broken ones', () => {
    expect(validateManifest(app({ projectTemplates: [template()] })).ok).toBe(true);
    const duplicate = validateManifest(app({ projectTemplates: [template(), template()] }));
    expect(duplicate.ok).toBe(false);
    const badKey = validateManifest(app({ projectTemplates: [template({ key: 'Kampanya' })] }));
    expect(badKey.ok).toBe(false);
    const noLists = validateManifest(app({ projectTemplates: [template({ content: { version: 1, lists: [] } })] }));
    expect(noLists.ok).toBe(false);
    if (!noLists.ok) expect(noLists.issues[0]?.code).toBe('manifest.project_template_invalid');
    const tooMany = validateManifest(app({ projectTemplates: Array.from({ length: 6 }, (_, index) => template({ key: `t${index}` })) }));
    expect(tooMany.ok).toBe(false);
  });

  it('allows only open buttons on record cards', () => {
    expect(validateRecordCard(card({ kind: 'open', payload: { postId: 'p1' } })).ok).toBe(true);
    const submit = validateRecordCard(card({ kind: 'submit', name: 'publish' }));
    expect(submit.ok).toBe(false);
    if (!submit.ok) expect(submit.issues.map((issue) => issue.code)).toEqual(['card.action_invalid']);
    expect(validateRecordCard({ version: 1 }).ok).toBe(false);
  });
});
