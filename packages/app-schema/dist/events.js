/*
 * Event catalogue and envelope (Phase 3 contract §5.1). Events go to the app's own server
 * (`POST {remote.url}/events`, signed as in §5.3). `data` version 1.
 */
/** Version of every event's `data` shape. */
export const EVENT_DATA_VERSION = 1;
const EVENT_LIST = [
    { type: 'app.installed', permission: null, audience: 'installation', subscription: false, description: 'The app was installed.' },
    { type: 'app.updated', permission: null, audience: 'installation', subscription: false, description: 'The installation moved to another version or its permissions changed.' },
    { type: 'app.uninstalled', permission: null, audience: 'installation', subscription: false, description: 'The app was removed.' },
    { type: 'app.consent.changed', permission: null, audience: 'installation', subscription: false, description: "A person's consent changed (empty lists when it was deleted)." },
    { type: 'chat.message.created', permission: 'chat:read', audience: 'conversation', subscription: true, description: 'A message was posted in a conversation the app was added to.' },
    { type: 'project.task.created', permission: 'projects:read', audience: 'project', subscription: true, description: 'A task was created in a project the app was added to.' },
    { type: 'project.task.updated', permission: 'projects:read', audience: 'project', subscription: true, description: 'A task changed (status included) in a project the app was added to.' },
    { type: 'project.task.deleted', permission: 'projects:read', audience: 'project', subscription: true, description: 'A task was deleted in a project the app was added to.' },
    { type: 'project.task.completed', permission: 'projects:read', audience: 'project', subscription: true, description: 'A task moved to a completed status in a project the app was added to (also sent as project.task.updated).' },
    { type: 'project.issue.opened', permission: 'projects:read', audience: 'project', subscription: true, description: 'An issue was opened in a project the app was added to.' },
    { type: 'project.issue.closed', permission: 'projects:read', audience: 'project', subscription: true, description: 'An issue was closed in a project the app was added to.' },
    { type: 'project.issue.triaged', permission: 'projects:read', audience: 'project', subscription: true, description: 'An issue left the triage queue (accepted, declined, duplicate) or was snoozed, in a project the app was added to.' },
    { type: 'project.approval.decided', permission: 'projects:read', audience: 'requester', subscription: true, description: "An approval the app asked for (project.approvals.request) was approved, rejected or cancelled." },
    { type: 'calendar.event.created', permission: 'calendar:read', audience: 'user', subscription: true, description: "An event was created in the calendar of a person who consented to calendar:read." },
    { type: 'calendar.event.updated', permission: 'calendar:read', audience: 'user', subscription: true, description: "An event changed in the calendar of a person who consented to calendar:read." },
    { type: 'calendar.event.deleted', permission: 'calendar:read', audience: 'user', subscription: true, description: "An event was deleted from the calendar of a person who consented to calendar:read." },
    { type: 'meeting.created', permission: 'meetings:read', audience: 'meeting', subscription: true, description: 'A meeting was scheduled.' },
    { type: 'meeting.started', permission: 'meetings:read', audience: 'meeting', subscription: true, description: 'A meeting went live.' },
    { type: 'meeting.ended', permission: 'meetings:read', audience: 'meeting', subscription: true, description: 'A meeting ended.' },
    { type: 'meeting.cancelled', permission: 'meetings:read', audience: 'meeting', subscription: true, description: 'A meeting was cancelled.' },
];
/** The event catalogue (§5.1), in table order. */
export const EVENT_CATALOG = Object.freeze(EVENT_LIST.map((entry) => Object.freeze(entry)));
export const EVENT_TYPES = [
    'app.installed',
    'app.updated',
    'app.uninstalled',
    'app.consent.changed',
    'chat.message.created',
    'project.task.created',
    'project.task.updated',
    'project.task.deleted',
    'project.task.completed',
    'project.issue.opened',
    'project.issue.closed',
    'project.issue.triaged',
    'project.approval.decided',
    'calendar.event.created',
    'calendar.event.updated',
    'calendar.event.deleted',
    'meeting.created',
    'meeting.started',
    'meeting.ended',
    'meeting.cancelled',
];
const BY_TYPE = new Map(EVENT_CATALOG.map((entry) => [entry.type, entry]));
export function isEventType(value) {
    return typeof value === 'string' && BY_TYPE.has(value);
}
export function eventDefinition(type) {
    return BY_TYPE.get(type) ?? null;
}
/** Permission an event needs (null for lifecycle events and unknown types). */
export function eventPermission(type) {
    return BY_TYPE.get(type)?.permission ?? null;
}
