import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_PATTERN,
  REQUIRED_PERMISSION,
  RESERVED_PERMISSIONS,
  IMPLIED_PERMISSIONS,
  isImpliedPermission,
  reservedPermission,
  RPC_METHODS,
  describePermission,
  isHttpUrlAllowed,
  isPermission,
  isRpcMethod,
  methodAllowed,
  normalizePermission,
  permissionCategory,
  permissionsForMethod,
  parsePermission,
  permissionScope,
} from './index.js';

describe('PERMISSIONS', () => {
  it('lists the contract permissions with TR/EN texts', () => {
    expect(PERMISSIONS.map((p) => p.id)).toEqual([
      'projects:read', 'projects:write', 'tasks:write', 'tasks:delete', 'projects:delete', 'projects:create', 'projects:archive', 'projects:extend', 'users:read', 'profile:read', 'chat:read',
      'chat:write', 'calendar:read', 'calendar:write', 'calendar:delete', 'contacts:read', 'contacts:write', 'contacts:delete', 'mail:read', 'meetings:read',
      'storage', 'db', 'files:pick', 'settings:read', 'remote', 'ai:tools', 'http:*',
    ]);
    for (const p of PERMISSIONS) {
      expect(p.label.tr && p.label.en && p.description.tr && p.description.en, p.id).toBeTruthy();
      expect(PERMISSION_CATEGORIES, p.id).toContain(p.category);
    }
    expect(PERMISSIONS.filter((p) => p.legacy).map((p) => p.id)).toEqual(['projects:write']);
    expect(describePermission('projects:write', 'tr').description).toBe('Proje görevlerini değiştirebilir');
    expect(PERMISSIONS.find((p) => p.id === 'http:*')?.pattern).toBe('http');
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });
});

describe('RESERVED_PERMISSIONS', () => {
  it('is empty since Phase 3 granted calendar and contacts writes', () => {
    const ids = RESERVED_PERMISSIONS.map((p) => p.id);
    expect(ids).toEqual([]);
    for (const id of ['calendar:write', 'calendar:delete', 'contacts:write', 'contacts:delete']) {
      expect(isPermission(id), id).toBe(true);
      expect(reservedPermission(id), id).toBeUndefined();
    }
    for (const entry of RESERVED_PERMISSIONS) {
      expect(entry.phase, entry.id).toMatch(/^Phase /);
      expect(PERMISSIONS.some((p) => p.id === entry.id), entry.id).toBe(false);
      expect(isPermission(entry.id), entry.id).toBe(false);
      expect(parsePermission(entry.id), entry.id).toBeNull();
      expect(permissionScope(entry.id), entry.id).toBeNull();
      expect(PERMISSION_PATTERN.test(entry.id), entry.id).toBe(false);
      expect(Object.values(REQUIRED_PERMISSION), entry.id).not.toContain(entry.id);
      expect(reservedPermission(entry.id)).toBe(entry);
    }
    expect(reservedPermission('projects:read')).toBeUndefined();
    expect(reservedPermission('db')).toBeUndefined();
    expect(reservedPermission('mail:delete')).toBeUndefined();
    expect(Object.isFrozen(RESERVED_PERMISSIONS)).toBe(true);
  });
});

describe('parsePermission', () => {
  it('parses static permissions', () => {
    expect(parsePermission('projects:read')).toEqual({ kind: 'static', id: 'projects:read' });
    expect(parsePermission('storage')).toEqual({ kind: 'static', id: 'storage' });
  });

  it('normalises http hosts to lowercase and keeps the port', () => {
    expect(parsePermission('http:API.Example.com:8443')).toEqual({ kind: 'http', host: 'api.example.com:8443' });
    expect(parsePermission('http:graph.facebook.com')).toEqual({ kind: 'http', host: 'graph.facebook.com' });
    expect(parsePermission('http:localhost')).toEqual({ kind: 'http', host: 'localhost' });
    expect(parsePermission('http:10.0.0.1:80')).toEqual({ kind: 'http', host: '10.0.0.1:80' });
  });

  it('rejects malformed permissions', () => {
    for (const value of [
      '',
      'Projects:read',
      'mail:send',
      'http:*',
      'http:',
      'http:https://api.example.com',
      'http://api.example.com',
      'http:api.example.com/path',
      'http:*.example.com',
      'http:-bad.example.com',
      'http:api.example.com:0',
      'http:api.example.com:65536',
      'http:api.example.com:080',
      'http:[::1]',
      'http:api.example.com.',
      'http:user@api.example.com',
      ` storage`,
    ]) {
      expect(parsePermission(value), value).toBeNull();
      expect(isPermission(value), value).toBe(false);
    }
  });

  it('normalizePermission returns canonical strings', () => {
    expect(normalizePermission('http:API.Example.com')).toBe('http:api.example.com');
    expect(normalizePermission('chat:read')).toBe('chat:read');
    expect(normalizePermission('nope')).toBeNull();
  });
});

describe('permissionScope', () => {
  it('follows the contract table', () => {
    expect(permissionScope('projects:read')).toBe('projects:read');
    expect(permissionScope('projects:write')).toBe('projects:write');
    expect(permissionScope('chat:read')).toBe('chat');
    expect(permissionScope('storage')).toBe('apps:storage');
    expect(permissionScope('db')).toBe('apps:db');
    expect(permissionScope('tasks:write')).toBe('projects:write');
    expect(permissionScope('tasks:delete')).toBe('projects:write');
    expect(permissionScope('projects:delete')).toBe('projects:write');
    expect(permissionScope('calendar:read')).toBe('calendar');
    expect(permissionScope('calendar:write')).toBe('calendar');
    expect(permissionScope('calendar:delete')).toBe('calendar');
    expect(permissionScope('contacts:read')).toBe('contacts');
    expect(permissionScope('contacts:delete')).toBe('contacts');
    expect(permissionScope('chat:write')).toBe('chat');
    expect(permissionScope('meetings:read')).toBe('meetings:read');
    expect(permissionScope('projects:create')).toBe('projects:write');
    expect(permissionScope('projects:archive')).toBe('projects:write');
    expect(permissionScope('mail:read')).toBeNull();
    expect(permissionScope('remote')).toBeNull();
    expect(permissionScope('ai:tools')).toBeNull();
    expect(permissionScope('settings:read')).toBeNull();
    expect(permissionScope('http:api.example.com')).toBeNull();
    expect(permissionScope('unknown')).toBeNull();
  });
});

describe('describePermission', () => {
  it('returns localised texts', () => {
    expect(describePermission('projects:read', 'tr').description).toBe('Projelerinizi ve görevlerinizi okuyabilir');
    expect(describePermission('projects:read', 'en').label).toBe('Read projects');
  });

  it('substitutes the host for http permissions', () => {
    expect(describePermission('http:API.example.com', 'tr')).toEqual({
      label: 'api.example.com adresine erişim',
      description: 'api.example.com adresine istek atabilir (Olan üzerinden)',
    });
  });

  it('handles unknown permissions', () => {
    expect(describePermission('mail:send', 'en')).toEqual({ label: 'mail:send', description: 'Unknown permission' });
  });

  it('fills the app server host into implied permissions', () => {
    expect(describePermission('remote', 'tr', { host: 'standup.example.com' })).toEqual({
      label: 'Uygulamanın sunucusu',
      description: 'Veriler standup.example.com adresindeki uygulama sunucusuna gönderilebilir',
    });
    expect(describePermission('ai:tools', 'en', { host: 'a.example.com' }).description).toContain('tool inputs are sent to a.example.com');
    expect(describePermission('remote', 'en').description).not.toContain('{host}');
    expect(IMPLIED_PERMISSIONS).toEqual(['remote', 'ai:tools']);
    expect(isImpliedPermission('remote')).toBe(true);
    expect(isImpliedPermission('db')).toBe(false);
  });
});

describe('isHttpUrlAllowed', () => {
  const granted = ['storage', 'http:api.example.com', 'http:data.example.com:8443'];

  it('matches hosts case-insensitively on default ports', () => {
    expect(isHttpUrlAllowed('https://API.example.com/v1?q=1', granted)).toBe(true);
    expect(isHttpUrlAllowed('https://api.example.com:443/v1', granted)).toBe(true);
    expect(isHttpUrlAllowed('http://api.example.com/', granted)).toBe(true);
  });

  it('requires explicit ports to match', () => {
    expect(isHttpUrlAllowed('https://api.example.com:8443/', granted)).toBe(false);
    expect(isHttpUrlAllowed('https://data.example.com:8443/', granted)).toBe(true);
    expect(isHttpUrlAllowed('https://data.example.com/', granted)).toBe(false);
  });

  it('rejects other hosts, schemes and credentials', () => {
    expect(isHttpUrlAllowed('https://evil.example.com/', granted)).toBe(false);
    expect(isHttpUrlAllowed('https://api.example.com.evil.com/', granted)).toBe(false);
    expect(isHttpUrlAllowed('ftp://api.example.com/', granted)).toBe(false);
    expect(isHttpUrlAllowed('https://user:pw@api.example.com/', granted)).toBe(false);
    expect(isHttpUrlAllowed('not a url', granted)).toBe(false);
  });
});

describe('RPC methods', () => {
  it('maps every method to its permission', () => {
    expect(RPC_METHODS).toEqual(Object.keys(REQUIRED_PERMISSION));
    expect(REQUIRED_PERMISSION['projects.list']).toBe('projects:read');
    expect(REQUIRED_PERMISSION['projects.updateTask']).toBe('tasks:write');
    expect(REQUIRED_PERMISSION['projects.createTask']).toBe('tasks:write');
    expect(REQUIRED_PERMISSION['projects.deleteTask']).toBe('tasks:delete');
    expect(REQUIRED_PERMISSION['projects.deleteList']).toBe('projects:delete');
    for (const method of ['db.insert', 'db.get', 'db.query', 'db.update', 'db.delete', 'db.count']) expect(REQUIRED_PERMISSION[method]).toBe('db');
    expect(REQUIRED_PERMISSION['users.get']).toBe('users:read');
    expect(REQUIRED_PERMISSION['chat.messages']).toBe('chat:read');
    expect(REQUIRED_PERMISSION['storage.keys']).toBe('storage');
    expect(REQUIRED_PERMISSION['settings.get']).toBeNull();
    expect(REQUIRED_PERMISSION['http.fetch']).toBe('http:*');
    expect(REQUIRED_PERMISSION['ui.datePicker']).toBeNull();
    expect(REQUIRED_PERMISSION['navigation.replace']).toBeNull();
    expect(REQUIRED_PERMISSION['chat.postCard']).toBe('chat:write');
    expect(REQUIRED_PERMISSION['calendar.deleteEvent']).toBe('calendar:delete');
    expect(REQUIRED_PERMISSION['contacts.update']).toBe('contacts:write');
    expect(REQUIRED_PERMISSION['mail.getMessage']).toBe('mail:read');
    expect(REQUIRED_PERMISSION['meetings.get']).toBe('meetings:read');
    expect(REQUIRED_PERMISSION['projects.create']).toBe('projects:create');
    expect(REQUIRED_PERMISSION['projects.archive']).toBe('projects:archive');
    expect(REQUIRED_PERMISSION['backend.call']).toBeNull();
    for (const method of RPC_METHODS) {
      const permission = REQUIRED_PERMISSION[method];
      if (permission && permission !== 'http:*') expect(isPermission(permission), method).toBe(true);
    }
  });

  it('isRpcMethod', () => {
    expect(isRpcMethod('ui.toast')).toBe(true);
    expect(isRpcMethod('toString')).toBe(false);
    expect(isRpcMethod('mail.send')).toBe(false);
  });
});

describe('permission categories', () => {
  it('groups permissions for consent screens', () => {
    expect(PERMISSION_CATEGORIES).toEqual(['read', 'write', 'delete', 'data', 'network', 'settings']);
    expect(permissionCategory('projects:read')).toBe('read');
    expect(permissionCategory('chat:read')).toBe('read');
    expect(permissionCategory('users:read')).toBe('read');
    expect(permissionScope('users:read')).toBe('users:read');
    expect(describePermission('users:read', 'tr').description).toBe('Kuruluşunuzdaki kişilerin adını, e-postasını ve dizin bilgilerini görebilir');
    expect(permissionCategory('projects:write')).toBe('write');
    expect(permissionCategory('tasks:write')).toBe('write');
    expect(permissionCategory('tasks:delete')).toBe('delete');
    expect(permissionCategory('projects:delete')).toBe('delete');
    expect(permissionCategory('storage')).toBe('data');
    expect(permissionCategory('db')).toBe('data');
    expect(permissionCategory('settings:read')).toBe('settings');
    expect(permissionCategory('http:API.example.com')).toBe('network');
    expect(permissionCategory('calendar:write')).toBe('write');
    expect(permissionCategory('calendar:delete')).toBe('delete');
    expect(permissionCategory('contacts:delete')).toBe('delete');
    expect(permissionCategory('projects:archive')).toBe('delete');
    expect(permissionCategory('mail:read')).toBe('read');
    expect(permissionCategory('remote')).toBe('network');
    expect(permissionCategory('ai:tools')).toBe('network');
    expect(permissionCategory('mail:delete')).toBeNull();
  });
});

describe('methodAllowed', () => {
  it('accepts the required permission or an alternative', () => {
    expect(ALTERNATIVE_PERMISSIONS['projects.updateTask']).toEqual(['projects:write']);
    expect(permissionsForMethod('projects.updateTask')).toEqual(['tasks:write', 'projects:write']);
    expect(methodAllowed('projects.updateTask', ['tasks:write'])).toBe(true);
    expect(methodAllowed('projects.updateTask', ['projects:write'])).toBe(true);
    expect(methodAllowed('projects.updateTask', ['projects:read'])).toBe(false);
    // projects:write does not unlock the new task methods.
    expect(methodAllowed('projects.createTask', ['projects:write'])).toBe(false);
    expect(methodAllowed('projects.deleteTask', ['projects:write', 'tasks:write'])).toBe(false);
    expect(methodAllowed('projects.deleteTask', ['tasks:delete'])).toBe(true);
    expect(methodAllowed('projects.deleteList', ['tasks:delete'])).toBe(false);
    expect(methodAllowed('projects.deleteList', ['projects:delete'])).toBe(true);
    expect(methodAllowed('db.query', ['storage'])).toBe(false);
    expect(methodAllowed('db.query', ['db'])).toBe(true);
    expect(methodAllowed('users.get', [])).toBe(false);
    expect(methodAllowed('users.get', ['projects:read'])).toBe(false);
    expect(methodAllowed('users.get', ['users:read'])).toBe(true);
  });

  it('needs no permission for ui/navigation/settings and rejects unknown methods', () => {
    expect(methodAllowed('ui.toast', [])).toBe(true);
    expect(methodAllowed('settings.get', [])).toBe(true);
    expect(permissionsForMethod('ui.toast')).toEqual([]);
    expect(methodAllowed('mail.send', ['db'])).toBe(false);
    expect(methodAllowed('toString', [])).toBe(false);
  });

  it('checks http.fetch against the URL', () => {
    expect(methodAllowed('http.fetch', ['http:api.example.com'], 'https://api.example.com/x')).toBe(true);
    expect(methodAllowed('http.fetch', ['http:api.example.com'], 'https://evil.example.com/')).toBe(false);
    expect(methodAllowed('http.fetch', ['http:api.example.com'])).toBe(false);
  });
});
