import type { JsonValue } from './json.js';
import type { ChatSenderKind } from './surfaces.js';
/** Version of every event's `data` shape. */
export declare const EVENT_DATA_VERSION = 1;
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
/** The event catalogue (§5.1), in table order. */
export declare const EVENT_CATALOG: readonly EventDefinition[];
export declare const EVENT_TYPES: readonly ["app.installed", "app.updated", "app.uninstalled", "app.consent.changed", "chat.message.created", "project.task.created", "project.task.updated", "project.task.deleted", "project.task.completed", "project.issue.opened", "project.issue.closed", "project.issue.triaged", "project.approval.decided", "calendar.event.created", "calendar.event.updated", "calendar.event.deleted", "meeting.created", "meeting.started", "meeting.ended", "meeting.cancelled"];
export type EventType = (typeof EVENT_TYPES)[number];
export declare function isEventType(value: unknown): value is EventType;
export declare function eventDefinition(type: string): EventDefinition | null;
/** Permission an event needs (null for lifecycle events and unknown types). */
export declare function eventPermission(type: string): string | null;
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
        attachments: Array<{
            id: string;
            filename: string;
            contentType: string;
            sizeBytes: number;
        }>;
        truncated?: boolean;
    };
}
/** The task as `olan.projects.tasks` returns it (`ProjectTask` in `@olan-app/sdk`). */
export type EventProjectTask = Record<string, JsonValue> & {
    id: string;
    projectId: string;
    title: string;
};
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
    decisions: Array<{
        userId: string;
        decision: 'approve' | 'reject';
        note: string;
        decidedAt: string;
    }>;
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
    'app.consent.changed': {
        userId: string;
        permissions: string[];
        declined: string[];
    };
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
export type AnyAppEvent = {
    [T in EventType]: AppEventEnvelope<T>;
}[EventType];
