import { COMPONENT_TYPES, PROTOCOL_VERSION as SCHEMA_PROTOCOL_VERSION, REQUIRED_PERMISSION, RPC_LIMITS, SURFACES, TEXT_NODE_TYPE as SCHEMA_TEXT_NODE_TYPE } from '@olan-app/schema';
import { describe, expect, it } from 'vitest';

import * as components from '../src/components';
import { MIN_REFETCH_INTERVAL_MS } from '../src/hooks';
import type { RpcMethodName } from '../src/api/types';
import { PROTOCOL_VERSION, SDK_VERSION, SURFACE_NAMES, TEXT_NODE_TYPE } from '../src/protocol';
import packageJson from '../package.json';

/* The SDK repeats a few schema constants to keep zod out of the worker bundle; these must agree. */
describe('protocol constants', () => {
  it('match @olan-app/schema', () => {
    expect(PROTOCOL_VERSION).toBe(SCHEMA_PROTOCOL_VERSION);
    expect(TEXT_NODE_TYPE).toBe(SCHEMA_TEXT_NODE_TYPE);
    expect(SURFACE_NAMES).toEqual(SURFACES);
  });

  it('export one component per contract type', () => {
    for (const type of COMPONENT_TYPES) expect(typeof (components as Record<string, unknown>)[type]).toBe('function');
  });

  it('type every RPC method the host knows', () => {
    const methods: Record<RpcMethodName, true> = {
      'projects.list': true, 'projects.get': true, 'projects.tasks': true, 'projects.updateTask': true,
      'projects.createTask': true, 'projects.deleteTask': true, 'projects.deleteList': true,
      'users.get': true,
      'chat.conversations': true, 'chat.messages': true,
      'storage.get': true, 'storage.set': true, 'storage.remove': true, 'storage.keys': true,
      'db.insert': true, 'db.get': true, 'db.query': true, 'db.update': true, 'db.delete': true, 'db.count': true,
      'settings.get': true, 'http.fetch': true,
      'ui.confirm': true, 'ui.prompt': true, 'ui.toast': true, 'ui.menu': true, 'ui.datePicker': true, 'ui.share': true,
      'navigation.push': true, 'navigation.pop': true, 'navigation.replace': true,
      'chat.postCard': true, 'chat.updateCard': true,
      'calendar.calendars': true, 'calendar.events': true, 'calendar.createEvent': true, 'calendar.updateEvent': true, 'calendar.deleteEvent': true,
      'contacts.addressBooks': true, 'contacts.search': true, 'contacts.create': true, 'contacts.update': true, 'contacts.delete': true,
      'mail.getMessage': true, 'meetings.get': true, 'projects.create': true, 'projects.archive': true, 'backend.call': true,
      'remote.request': true, 'files.pick': true, 'files.upload': true, 'files.cancel': true, 'ui.openUrl': true, 'ui.openExternal': true,
      'timers.set': true, 'timers.clear': true,
      'project.config.get': true, 'project.config.set': true,
      'project.statuses.list': true, 'project.statuses.define': true, 'project.statuses.remove': true,
      'project.labels.list': true, 'project.labels.define': true, 'project.labels.remove': true,
      'project.fields.list': true, 'project.fields.define': true, 'project.fields.remove': true, 'project.fields.values': true, 'project.fields.setValues': true,
      'project.links.list': true, 'project.links.upsert': true, 'project.links.remove': true, 'project.links.setStatus': true,
      'project.calendar.list': true, 'project.calendar.upsert': true, 'project.calendar.remove': true,
      'project.activity.post': true, 'project.approvals.list': true, 'project.approvals.request': true, 'project.approvals.cancel': true,
    };
    expect(Object.keys(methods).sort()).toEqual(Object.keys(REQUIRED_PERMISSION).sort());
  });

  it('repeats the minimum refetch interval', () => {
    expect(MIN_REFETCH_INTERVAL_MS).toBe(RPC_LIMITS.timerMinIntervalMs);
  });

  it('SDK_VERSION matches package.json', () => {
    expect(SDK_VERSION).toBe(packageJson.version);
  });
});
