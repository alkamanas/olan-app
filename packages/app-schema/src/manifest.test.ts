import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FIELDS_BY_VERSION,
  RESERVED_MANIFEST_FIELDS,
  defaultSettings,
  manifestFieldsFor,
  manifestSchema,
  validateManifest,
  validateSettings,
  type ManifestIssue,
  type OlanAppManifest,
} from './index.js';

/** The example from contract §2. */
const contractExample = () => ({
  $schema: 'https://olan.app/schemas/olan-app/v1.json',
  schemaVersion: 1,
  id: 'com.visetra.overdue-tasks',
  name: 'Geciken görevler',
  version: '0.1.0',
  sdk: '^1.0.0',
  minServerVersion: '1.0.0',
  description: '…',
  entry: 'dist/app.js',
  icon: 'assets/icon.png',
  kind: 'app',
  surfaces: {
    app: { title: 'Geciken görevler' },
    'project.widget': { title: 'Gecikenler' },
    settings: { title: 'Ayarlar' },
  },
  permissions: ['projects:read', 'storage', 'http:api.example.com'],
  settings: {
    threshold: { type: 'number', label: 'Gecikme eşiği (gün)', default: 3 },
    accountId: { type: 'string', label: 'Hesap', secret: false },
  },
});

const minimalApp = () => ({
  schemaVersion: 1,
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',
  sdk: '^1.0.0',
  entry: 'dist/app.js',
  surfaces: { app: {} },
});

const webLink = () => ({
  schemaVersion: 1,
  id: 'com.example.wiki',
  name: 'Wiki',
  version: '1.0.0',
  sdk: '*',
  kind: 'web-link',
  url: 'https://wiki.example.com/start',
  surfaces: { app: { title: 'Wiki' } },
});

function issuesOf(input: unknown): ManifestIssue[] {
  const result = validateManifest(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.issues;
}

function codes(input: unknown): string[] {
  return issuesOf(input).map((issue) => issue.code);
}

describe('validateManifest happy paths', () => {
  it('accepts the contract example', () => {
    const result = validateManifest(contractExample());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('app');
    expect(result.manifest.permissions).toEqual(['projects:read', 'storage', 'http:api.example.com']);
  });

  it('accepts JSON text', () => {
    expect(validateManifest(JSON.stringify(contractExample())).ok).toBe(true);
  });

  it('applies defaults for kind and permissions', () => {
    const result = validateManifest(minimalApp());
    expect(result).toMatchObject({ ok: true, manifest: { kind: 'app', permissions: [] } });
  });

  it('normalises http permission hosts', () => {
    const result = validateManifest({ ...minimalApp(), permissions: ['http:API.Example.com:8443'] });
    expect(result.ok && result.manifest.permissions).toEqual(['http:api.example.com:8443']);
  });

  it('accepts a web link', () => {
    const result = validateManifest(webLink());
    expect(result).toMatchObject({ ok: true, manifest: { kind: 'web-link', permissions: [] } });
  });

  it('accepts a web link with an icon name or URL and no surfaces', () => {
    const { surfaces: _surfaces, ...rest } = webLink();
    expect(validateManifest({ ...rest, icon: 'globe' }).ok).toBe(true);
    expect(validateManifest({ ...rest, icon: 'https://wiki.example.com/icon.png' }).ok).toBe(true);
  });

  it('accepts every supported sdk range form', () => {
    for (const sdk of ['*', '1.2.3', '^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '>=1.0.0-beta.1']) {
      expect(validateManifest({ ...minimalApp(), sdk }).ok, sdk).toBe(true);
    }
  });

  it('accepts all settings field types', () => {
    const result = validateManifest({
      ...minimalApp(),
      settings: {
        text: { type: 'string', label: 'Text', default: 'x', required: true },
        count: { type: 'number', label: 'Count', default: 2 },
        enabled: { type: 'boolean', label: 'Enabled', default: true },
        mode: { type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'b' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('manifestSchema enforces cross-field rules by itself', () => {
    const { entry: _entry, ...noEntry } = minimalApp();
    const parsed = manifestSchema.safeParse(noEntry);
    expect(parsed.success).toBe(false);
    expect((parsed.error?.issues[0] as { params?: unknown } | undefined)?.params).toMatchObject({ code: 'manifest.entry_required' });
  });
});

describe('validateManifest error codes', () => {
  it('manifest.invalid_json', () => {
    const issues = issuesOf('{ "id": "com.example.x", }');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'manifest.invalid_json', path: '' });
    expect(issues[0]?.hint).toBeTruthy();
  });

  it('manifest.not_object', () => {
    expect(codes([])).toEqual(['manifest.not_object']);
    expect(codes('42')).toEqual(['manifest.not_object']);
  });

  it('manifest.schema_version', () => {
    expect(codes({ ...minimalApp(), schemaVersion: 2 })).toEqual(['manifest.schema_version']);
    const { schemaVersion: _v, ...missing } = minimalApp();
    const issue = issuesOf(missing)[0]!;
    expect(issue).toMatchObject({ code: 'manifest.schema_version', path: 'schemaVersion' });
    expect(issue.message).toMatch(/required/);
  });

  it('manifest.id', () => {
    for (const id of ['hello', 'Com.Example.App', 'com..example', 'com.example_app', `com.${'a'.repeat(130)}`]) {
      expect(codes({ ...minimalApp(), id }), id).toEqual(['manifest.id']);
    }
  });

  it('manifest.version', () => {
    for (const version of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-']) {
      expect(codes({ ...minimalApp(), version }), version).toEqual(['manifest.version']);
    }
  });

  it('manifest.sdk', () => {
    for (const sdk of ['latest', '^1', '1.x', '^1.0.0 <2.0.0', '']) {
      expect(codes({ ...minimalApp(), sdk }), sdk).toEqual(['manifest.sdk']);
    }
  });

  it('manifest.entry_required and manifest.entry', () => {
    const { entry: _entry, ...noEntry } = minimalApp();
    const issue = issuesOf(noEntry)[0]!;
    expect(issue).toMatchObject({ code: 'manifest.entry_required', path: 'entry' });
    expect(issue.hint).toContain('dist/app.js');
    for (const entry of ['../app.js', '/dist/app.js', 'dist\\app.js', 'dist/app.ts', 'dist//app.js']) {
      expect(codes({ ...minimalApp(), entry }), entry).toEqual(['manifest.entry']);
    }
  });

  it('manifest.url_required and manifest.url', () => {
    const { url: _url, ...noUrl } = webLink();
    expect(codes(noUrl)).toEqual(['manifest.url_required']);
    for (const url of ['ftp://example.com', 'javascript:alert(1)', 'example.com', 'https://']) {
      expect(codes({ ...webLink(), url }), url).toEqual(['manifest.url']);
    }
  });

  it('manifest.url_not_allowed for packaged apps', () => {
    expect(codes({ ...minimalApp(), url: 'https://example.com' })).toEqual(['manifest.url_not_allowed']);
  });

  it('manifest.surface_unknown', () => {
    const issues = issuesOf({ ...minimalApp(), surfaces: { app: {}, 'chat.reaction': { title: 'x' } } });
    expect(issues).toEqual([expect.objectContaining({ code: 'manifest.surface_unknown', path: 'surfaces["chat.reaction"]' })]);
  });

  it('manifest.surfaces_required', () => {
    const { surfaces: _surfaces, ...rest } = minimalApp();
    expect(codes(rest)).toEqual(['manifest.surfaces_required']);
    expect(codes({ ...minimalApp(), surfaces: {} })).toEqual(['manifest.surfaces_required']);
  });

  it('manifest.surface_invalid for invalid surface options', () => {
    expect(codes({ ...minimalApp(), surfaces: { app: { title: '' } } })).toEqual(['manifest.surface_invalid']);
    expect(codes({ ...minimalApp(), surfaces: { app: { color: 'red' } } })).toEqual(['manifest.surface_invalid']);
    // Phase 3 surfaces need a title.
    expect(codes({ ...minimalApp(), surfaces: { app: {}, 'chat.action': {} } })).toEqual(['manifest.surface_invalid']);
    expect(codes({ ...minimalApp(), surfaces: { app: {}, 'meeting.panel': { title: 'x'.repeat(81) } } })).toEqual(['manifest.surface_invalid']);
  });

  it('manifest.permission_unknown', () => {
    const issues = issuesOf({
      ...minimalApp(),
      permissions: ['projects:read', 'mail:send', 'http:https://api.example.com', 'http:*.example.com', 'http:api.example.com/v1', 'http:host:70000'],
    });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['manifest.permission_unknown', 'permissions[1]'],
      ['manifest.permission_unknown', 'permissions[2]'],
      ['manifest.permission_unknown', 'permissions[3]'],
      ['manifest.permission_unknown', 'permissions[4]'],
      ['manifest.permission_unknown', 'permissions[5]'],
    ]);
    expect(issues[0]?.message).toBe('Unknown permission "mail:send".');
    expect(issues[0]?.hint).toContain('http:<host>');
  });

  it('manifest.permission_duplicate (case-insensitive hosts)', () => {
    const issues = issuesOf({ ...minimalApp(), permissions: ['storage', 'http:api.example.com', 'http:API.example.com', 'storage'] });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['manifest.permission_duplicate', 'permissions[2]'],
      ['manifest.permission_duplicate', 'permissions[3]'],
    ]);
  });

  it('accepts the Phase 3 permissions and rejects implied ones in permissions', () => {
    const phase3 = ['chat:write', 'calendar:read', 'calendar:write', 'calendar:delete', 'contacts:read', 'contacts:write', 'contacts:delete', 'mail:read', 'meetings:read', 'projects:create', 'projects:archive'];
    expect(validateManifest({ ...minimalApp(), permissions: phase3 }).ok).toBe(true);
    const issues = issuesOf({ ...minimalApp(), permissions: ['projects:read', 'remote', 'ai:tools', 'mail:delete'] });
    expect(issues.map((i) => [i.code, i.path]).sort()).toEqual([
      ['manifest.permission_unknown', 'permissions[1]'],
      ['manifest.permission_unknown', 'permissions[2]'],
      ['manifest.permission_unknown', 'permissions[3]'],
    ]);
    expect(issues.find((i) => i.path === 'permissions[1]')?.message).toContain('implied');
  });

  it('accepts the Phase 1b permissions', () => {
    const result = validateManifest({ ...minimalApp(), permissions: ['db', 'tasks:write', 'tasks:delete', 'projects:delete', 'projects:write'] });
    expect(result.ok).toBe(true);
  });

  it('manifest.unknown_field', () => {
    const issues = issuesOf({ ...minimalApp(), permision: [] });
    expect(issues).toEqual([expect.objectContaining({ code: 'manifest.unknown_field', path: 'permision' })]);
    expect(issues[0]?.hint).toContain(`Allowed fields: ${MANIFEST_FIELDS_BY_VERSION[1].join(', ')}.`);
  });

  it('accepts server by default; manifest.feature_not_available when the backend is turned off', () => {
    expect(validateManifest({ ...minimalApp(), server: { entry: 'server/index.ts' } }).ok).toBe(true);
    expect(validateManifest({ ...minimalApp(), server: { entry: 'server/index.ts' } }, { backend: true }).ok).toBe(true);
    expect(manifestSchema.safeParse({ ...minimalApp(), server: { entry: 'server/index.ts' } }).success).toBe(true);
    expect(codes({ ...webLink(), server: {} }).sort()).toEqual(['manifest.server_invalid', 'manifest.web_link_remote']);
    const off = validateManifest({ ...minimalApp(), server: { entry: 'server/index.js' } }, { backend: false });
    const issues = off.ok ? [] : off.issues;
    expect(issues.map((i) => [i.code, i.path])).toEqual([['manifest.feature_not_available', 'server']]);
    expect(issues[0]?.message).toContain('turned off');
    expect(issues[0]?.hint).toContain('OLAN_APPS_BACKEND');
    const offWebLink = validateManifest({ ...webLink(), server: {} }, { backend: false });
    expect(offWebLink.ok ? [] : offWebLink.issues.map((i) => i.code)).toEqual(['manifest.feature_not_available']);
    expect(Object.keys(RESERVED_MANIFEST_FIELDS)).toEqual([]);
  });

  it('keeps reserved fields out of every schema version', () => {
    expect(MANIFEST_FIELDS_BY_VERSION[1]).toEqual([
      '$schema', 'schemaVersion', 'id', 'name', 'version', 'sdk', 'minServerVersion', 'description',
      'entry', 'icon', 'kind', 'url', 'surfaces', 'permissions', 'settings', 'data', 'remote', 'events', 'ai', 'server', 'projectTemplates',
    ]);
    for (const fields of Object.values(MANIFEST_FIELDS_BY_VERSION)) {
      for (const reserved of Object.keys(RESERVED_MANIFEST_FIELDS)) expect(fields).not.toContain(reserved);
    }
    expect(manifestFieldsFor(1)).toBe(MANIFEST_FIELDS_BY_VERSION[1]);
    expect(manifestFieldsFor(99)).toBe(MANIFEST_FIELDS_BY_VERSION[1]);
    expect(manifestFieldsFor('__proto__')).toBe(MANIFEST_FIELDS_BY_VERSION[1]);
    expect(Object.isFrozen(RESERVED_MANIFEST_FIELDS)).toBe(true);
  });

  it('manifest.icon', () => {
    expect(codes({ ...minimalApp(), icon: 'https://example.com/icon.png' })).toEqual(['manifest.icon']);
    expect(codes({ ...minimalApp(), icon: 'assets/icon.gif' })).toEqual(['manifest.icon']);
    expect(codes({ ...webLink(), icon: 'assets/icon.png' })).toEqual(['manifest.icon']);
  });

  it('manifest.name and manifest.description', () => {
    expect(codes({ ...minimalApp(), name: '   ' })).toEqual(['manifest.name']);
    expect(codes({ ...minimalApp(), name: 'x'.repeat(81) })).toEqual(['manifest.name']);
    expect(codes({ ...minimalApp(), description: 'x'.repeat(401) })).toEqual(['manifest.description']);
  });

  it('manifest.kind and manifest.min_server_version', () => {
    expect(codes({ ...minimalApp(), kind: 'plugin' })).toEqual(['manifest.kind']);
    expect(codes({ ...minimalApp(), minServerVersion: '1' })).toEqual(['manifest.min_server_version']);
  });

  it('manifest.settings_field', () => {
    const cases: [string, unknown][] = [
      ['unknown type', { type: 'date', label: 'When' }],
      ['missing label', { type: 'string' }],
      ['default type mismatch', { type: 'number', label: 'N', default: '3' }],
      ['boolean default mismatch', { type: 'boolean', label: 'B', default: 'yes' }],
      ['select without options', { type: 'select', label: 'S', options: [] }],
      ['select default not an option', { type: 'select', label: 'S', options: [{ value: 'a', label: 'A' }], default: 'b' }],
      ['unknown field property', { type: 'string', label: 'S', min: 1 }],
    ];
    for (const [name, field] of cases) {
      const issues = issuesOf({ ...minimalApp(), settings: { value: field } });
      expect(issues.map((i) => i.code), name).toEqual(['manifest.settings_field']);
      expect(issues[0]?.path.startsWith('settings.value'), name).toBe(true);
    }
    expect(codes({ ...minimalApp(), settings: { 'bad key': { type: 'string', label: 'x' } } })).toEqual(['manifest.settings_field']);
  });

  it('reports field and cross-field issues together', () => {
    const { entry: _entry, ...noEntry } = minimalApp();
    expect(codes({ ...noEntry, id: 'bad' }).sort()).toEqual(['manifest.entry_required', 'manifest.id']);
  });

  it('every issue has a message and a hint', () => {
    const issues = issuesOf({ schemaVersion: 3, id: 'x', name: '', version: 'x', sdk: 'x', kind: 'app', permissions: ['nope'], extra: 1 });
    expect(issues.length).toBeGreaterThan(5);
    for (const issue of issues) {
      expect(issue.message.length, issue.code).toBeGreaterThan(0);
      expect(issue.hint, issue.code).toBeTruthy();
    }
  });
});

describe('web-link rules', () => {
  it('manifest.web_link_permissions', () => {
    expect(codes({ ...webLink(), permissions: ['projects:read'] })).toEqual(['manifest.web_link_permissions']);
  });

  it('manifest.web_link_entry', () => {
    expect(codes({ ...webLink(), entry: 'dist/app.js' })).toEqual(['manifest.web_link_entry']);
  });

  it('manifest.web_link_surface', () => {
    const issues = issuesOf({ ...webLink(), surfaces: { app: {}, 'project.widget': {} } });
    expect(issues).toEqual([expect.objectContaining({ code: 'manifest.web_link_surface', path: 'surfaces["project.widget"]' })]);
  });

  it('manifest.web_link_settings', () => {
    expect(codes({ ...webLink(), settings: { a: { type: 'string', label: 'A' } } })).toEqual(['manifest.web_link_settings']);
  });

  it('http URLs are accepted', () => {
    expect(validateManifest({ ...webLink(), url: 'http://intranet.example.com' }).ok).toBe(true);
  });
});

describe('settings helpers', () => {
  const manifest = () => {
    const result = validateManifest({
      ...minimalApp(),
      settings: {
        threshold: { type: 'number', label: 'Threshold', default: 3 },
        accountId: { type: 'string', label: 'Account', required: true },
        mode: { type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'a' },
        enabled: { type: 'boolean', label: 'Enabled' },
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.manifest as OlanAppManifest;
  };

  it('defaultSettings returns declared defaults only', () => {
    expect(defaultSettings(manifest())).toEqual({ threshold: 3, mode: 'a' });
    expect(defaultSettings({})).toEqual({});
  });

  it('validateSettings merges over defaults', () => {
    expect(validateSettings(manifest(), { accountId: 'acc-1', threshold: 5 })).toEqual({
      ok: true,
      values: { threshold: 5, mode: 'a', accountId: 'acc-1' },
    });
  });

  it('validateSettings reports problems', () => {
    const result = validateSettings(manifest(), { threshold: '5', mode: 'z', other: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.code, i.key])).toEqual([
      ['settings.type', 'threshold'],
      ['settings.option', 'mode'],
      ['settings.unknown_key', 'other'],
      ['settings.required', 'accountId'],
    ]);
    expect(validateSettings(manifest(), null)).toMatchObject({ ok: false, issues: [{ code: 'settings.not_object' }] });
  });
});
