import type { JsonValue } from './json.js';
import type { ChatSenderKind } from './surfaces.js';

/*
 * Event catalogue and envelope (Phase 3 contract §5.1). Events go to the app's own server
 * (`POST {remote.url}/events`, signed as in §5.3). `data` version 1.
 */

/** Version of every event's `data` shape. */
export const EVENT_DATA_VERSION = 1;

/**
 * Who receives an event: the installation itself, conversations or projects the app was added to
 * (resource grants), people whose consent includes the permission, meetings (organizer
 * consented, or linked to a granted project), or the one installation that made the record the
 * event is about (`data.installationId`, while it is still enabled in `data.projectId`).
 */
export type EventAudience = 'installation' | 'conversation' | 'project' | 'user' | 'meeting' | 'requester';

export interface EventDefinition {
  type: string;
  /** Permission the app needs (in its manifest and effective grant); null for lifecycle events. */
  permission: string | null;
  audience: EventAudience;
  /**
   * `false` for lifecycle events (`app.*`): every app with `remote` gets them without listing
   * them in `events` (listing them is allowed and changes nothing).
   */
  subscription: boolean;
  description: string;
}

const EVENT_LIST: EventDefinition[] = [
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
export const EVENT_CATALOG: readonly EventDefinition[] = Object.freeze(EVENT_LIST.map((entry) => Object.freeze(entry)));

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
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const BY_TYPE = new Map(EVENT_CATALOG.map((entry) => [entry.type, entry]));

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && BY_TYPE.has(value);
}

export function eventDefinition(type: string): EventDefinition | null {
  return BY_TYPE.get(type) ?? null;
}

/** Permission an event needs (null for lifecycle events and unknown types). */
export function eventPermission(type: string): string | null {
  return BY_TYPE.get(type)?.permission ?? null;
}

// ---------------------------------------------------------------------------
// Payloads (`data`, version 1)
// ---------------------------------------------------------------------------

export interface AppLifecycleEventData {
  versionId: string;
  version: string;
  scope: 'organization' | 'user';
  grantedPermissions: string[];
  /**
   * Phase 5a: the installation's organization (tenant id), the same as `user.organizationId` of
   * `remote/requests` envelopes. Servers before 1.5 do not send it.
   */
  organizationId?: string;
}

export interface ChatMessageEventData {
  conversationId: string;
  message: {
    id: string;
    /** Cut to fit the 256 KiB delivery limit when `truncated` is true. */
    body: string | null;
    senderId: string | null;
    senderKind: ChatSenderKind;
    createdAt: string;
    replyToId: string | null;
    threadRootId: string | null;
    attachments: Array<{ id: string; filename: string; contentType: string; sizeBytes: number }>;
    truncated?: boolean;
  };
}

/** The task as `olan.projects.tasks` returns it (`ProjectTask` in `@olan-app/sdk`). */
export type EventProjectTask = Record<string, JsonValue> & { id: string; projectId: string; title: string };

export interface ProjectTaskEventData {
  projectId: string;
  task: EventProjectTask;
  /** `project.task.updated`: the fields that changed. */
  changed?: string[];
}

export interface ProjectTaskDeletedEventData {
  projectId: string;
  taskId: string;
  title: string;
}

/** The issue in `project.issue.*` events. */
export interface EventProjectIssue {
  id: string;
  projectId: string;
  /** `WEB-#4`. */
  key: string | null;
  number: number;
  title: string;
  kind: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  priority: number;
  assigneeId: string | null;
  labels: string[];
  /** Null while the issue waits in the triage queue. */
  triagedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIssueEventData {
  projectId: string;
  issue: EventProjectIssue;
  /** `project.issue.triaged`: accepted, declined, duplicate or snoozed. */
  decision?: 'accepted' | 'declined' | 'duplicate' | 'snoozed' | 'closed';
}

/** `project.approval.decided`: the request (`project.approvals.request`) and how it ended. */
export interface ProjectApprovalEventData {
  projectId: string;
  /** The app that asked; only that installation receives the event. */
  installationId: string;
  approvalId: string;
  externalId: string | null;
  linkId: string | null;
  state: 'approved' | 'rejected' | 'cancelled';
  decisions: Array<{ userId: string; decision: 'approve' | 'reject'; note: string; decidedAt: string }>;
}

export interface CalendarEventEventData {
  userId: string;
  calendarId: string;
  eventId: string;
  uid: string;
  /** Absent in `calendar.event.deleted`. */
  event?: {
    title: string;
    start: string;
    end: string;
    timeZone: string | null;
    isAllDay: boolean;
    location: string | null;
    status: string | null;
  };
}

export interface MeetingEventData {
  meetingId: string;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  organizerId: string;
  projectId?: string | null;
}

/** `data` per event type. */
export interface EventDataMap {
  'app.installed': AppLifecycleEventData;
  'app.updated': AppLifecycleEventData;
  'app.uninstalled': Record<string, never>;
  'app.consent.changed': { userId: string; permissions: string[]; declined: string[] };
  'chat.message.created': ChatMessageEventData;
  'project.task.created': ProjectTaskEventData;
  'project.task.updated': ProjectTaskEventData;
  'project.task.deleted': ProjectTaskDeletedEventData;
  'project.task.completed': ProjectTaskEventData;
  'project.issue.opened': ProjectIssueEventData;
  'project.issue.closed': ProjectIssueEventData;
  'project.issue.triaged': ProjectIssueEventData;
  'project.approval.decided': ProjectApprovalEventData;
  'calendar.event.created': CalendarEventEventData;
  'calendar.event.updated': CalendarEventEventData;
  'calendar.event.deleted': CalendarEventEventData;
  'meeting.created': MeetingEventData;
  'meeting.started': MeetingEventData;
  'meeting.ended': MeetingEventData;
  'meeting.cancelled': MeetingEventData;
}

export interface EventActor {
  kind: 'user' | 'app' | 'system';
  id?: string;
}

/** The body of `POST {remote.url}/events`. */
export interface AppEventEnvelope<T extends EventType = EventType> {
  /** `evt_<uuid>`; also the `webhook-id` header (the same on every attempt). */
  id: string;
  type: T;
  version: typeof EVENT_DATA_VERSION;
  occurredAt: string;
  /** The Olan server that sent it (`OLAN_PUBLIC_URL`). */
  issuer: string;
  installationId: string;
  appId: string;
  actor: EventActor;
  data: EventDataMap[T];
}

/** Any event, narrowed by `type`. */
export type AnyAppEvent = { [T in EventType]: AppEventEnvelope<T> }[EventType];
