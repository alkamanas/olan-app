import { z } from 'zod';
import type { JsonValue } from './json.js';
import { type Surface } from './versions.js';
/**
 * How a host shows a surface: full screen, project widget, modal (one per app at a time), panel, or
 * a tab of the project page (the tab's whole content area, with its own screen stack).
 */
export type SurfacePresentation = 'screen' | 'widget' | 'modal' | 'panel' | 'tab';
export declare const SURFACE_PRESENTATIONS: Readonly<Record<Surface, SurfacePresentation>>;
/** Surfaces whose `title` is optional (it falls back to the app name); every other surface needs one. */
export declare const SURFACES_WITH_OPTIONAL_TITLE: readonly Surface[];
/**
 * Surfaces of the project page (Phase 6): shown only in projects the app is enabled in, with the
 * `projectId` in their params.
 */
export declare const PROJECT_SURFACES: readonly Surface[];
/** Whether the surface belongs to the project page (`PROJECT_SURFACES`). */
export declare function isProjectSurface(surface: string): boolean;
/** `chat.command` `command`: what follows `/` in the composer. */
export declare const CHAT_COMMAND_PATTERN: RegExp;
export declare const SURFACE_TITLE_MAX = 80;
export declare const CHAT_COMMAND_DESCRIPTION_MAX = 120;
/** Most app entries a host shows in one place; the rest go under "Tüm uygulamalar" / "All apps". */
export declare const SURFACE_ENTRIES_PER_PLACE = 8;
export interface BasicSurfaceDefinition {
    /** Title shown by the host; falls back to the app name. */
    title?: string;
}
/** A Phase 3 surface: the title is required (1–80). */
export interface TitledSurfaceDefinition {
    title: string;
}
export interface ChatCommandSurfaceDefinition extends TitledSurfaceDefinition {
    /** `^[a-z][a-z0-9-]{1,31}$`, typed after `/` (e.g. `standup`). */
    command: string;
    /** Shown next to the command in the suggestions (≤ 120). */
    description?: string;
}
/** Manifest options of each surface. */
export interface SurfaceDefinitions {
    app: BasicSurfaceDefinition;
    'project.widget': BasicSurfaceDefinition;
    settings: BasicSurfaceDefinition;
    'chat.action': TitledSurfaceDefinition;
    'chat.command': ChatCommandSurfaceDefinition;
    'chat.card': TitledSurfaceDefinition;
    'mail.sidebar': TitledSurfaceDefinition;
    'mail.action': TitledSurfaceDefinition;
    'calendar.event.action': TitledSurfaceDefinition;
    'meeting.panel': TitledSurfaceDefinition;
    /** Tab label on the project page (≤ 80); falls back to the app name. */
    'project.tab': BasicSurfaceDefinition;
    /** Title of the project settings screen (≤ 80); falls back to the app name. */
    'project.settings': BasicSurfaceDefinition;
    /** Entry in a task's "…" menu (1–80). */
    'task.action': TitledSurfaceDefinition;
    /** Entry in an issue's "…" menu (1–80). */
    'issue.action': TitledSurfaceDefinition;
    /** Title of the sheet a record card's `open` button opens (1–80). */
    'record.card': TitledSurfaceDefinition;
}
/** Any surface's options (the union of `SurfaceDefinitions`). */
export type SurfaceDefinition = SurfaceDefinitions[Surface];
export type ManifestSurfaces = {
    [S in Surface]?: SurfaceDefinitions[S];
};
/** Sender kind of a chat message (`collaboration_messages.sender_kind`; `app` since Phase 3). */
export type ChatSenderKind = 'user' | 'project-bot' | 'system' | 'bot' | 'app';
export interface ChatActionParams {
    conversationId: string;
    message: {
        id: string;
        body: string | null;
        senderId: string | null;
        senderKind: ChatSenderKind;
        createdAt: string;
        threadRootId: string | null;
    };
}
export interface ChatCommandParams {
    conversationId: string;
    /** What the person typed after `/<command> ` (may be empty). */
    text: string;
    threadRootId?: string | null;
}
export interface ChatCardParams {
    conversationId: string;
    messageId: string;
    /** The `open` action's `payload` (null when it has none). */
    payload: JsonValue;
}
export interface MailAddress {
    name: string | null;
    email: string;
}
/** `mail.sidebar` and `mail.action`: the summary of the open message (no body; `mail.getMessage` needs `mail:read`). */
export interface MailSurfaceParams {
    messageId: string;
    threadId: string | null;
    subject: string;
    from: MailAddress;
    to: MailAddress[];
    cc: MailAddress[];
    receivedAt: string;
}
export interface CalendarEventActionParams {
    calendarId: string;
    eventId: string;
    uid: string;
    title: string;
    /** ISO date (all-day) or date-time. */
    start: string;
    end: string;
    timeZone: string | null;
    isAllDay: boolean;
    location?: string | null;
    isOrganizer: boolean;
}
export interface MeetingPanelParams {
    meetingId: string;
    slug: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
    role: 'organizer' | 'participant';
    projectId?: string | null;
}
/**
 * `init.params` of the `app` surface when the host reopens it for an external flow's return and no
 * `openExternal` call was waiting (Phase 5a §5.2): the return address's query parameters.
 */
export interface AppSurfaceParams {
    return?: Record<string, string>;
}
/** `init.params` of the project surfaces (`project.widget`, `project.tab`, `project.settings`). */
export interface ProjectSurfaceParams {
    projectId: string;
}
/** Status category of a project status (`olan_project_statuses.category`). */
export type ProjectStatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
/** `task.action`: the task whose menu was opened. */
export interface TaskActionParams {
    projectId: string;
    task: {
        id: string;
        /** `WEB-12`. */
        key: string | null;
        title: string;
        /** CalDAV value: needs-action, in-process, completed, cancelled. */
        status: string;
        statusId: string | null;
        statusCategory: ProjectStatusCategory | null;
        assigneeId: string | null;
        due: string | null;
    };
}
/** `issue.action`: the issue whose menu was opened. */
export interface IssueActionParams {
    projectId: string;
    issue: {
        id: string;
        /** `WEB-#4`. */
        key: string | null;
        number: number;
        title: string;
        kind: string | null;
        state: 'open' | 'closed';
        stateReason: string | null;
        /** Still waiting in the triage queue. */
        inTriage: boolean;
    };
}
/** What a record link is attached to. */
export type RecordLinkTargetKind = 'task' | 'issue';
/** `record.card`: the link whose card button was pressed, and that button's `payload`. */
export interface RecordCardParams {
    projectId: string;
    linkId: string;
    target: {
        kind: RecordLinkTargetKind;
        id: string;
    };
    /** The app's own id of the record (`project.links.upsert` `externalId`). */
    externalId: string;
    /** The `open` action's `payload` (null when it has none). */
    payload: JsonValue;
}
/** `init.params` (and `context.params` updates of panels) per surface. */
export interface SurfaceParams {
    app: AppSurfaceParams | null;
    'project.widget': ProjectSurfaceParams;
    settings: null;
    'chat.action': ChatActionParams;
    'chat.command': ChatCommandParams;
    'chat.card': ChatCardParams;
    'mail.sidebar': MailSurfaceParams;
    'mail.action': MailSurfaceParams;
    'calendar.event.action': CalendarEventActionParams;
    'meeting.panel': MeetingPanelParams;
    'project.tab': ProjectSurfaceParams;
    'project.settings': ProjectSurfaceParams;
    'task.action': TaskActionParams;
    'issue.action': IssueActionParams;
    'record.card': RecordCardParams;
}
/** zod schema of the manifest `surfaces` object (strict: unknown surfaces are rejected). */
export declare const surfacesSchema: z.ZodObject<Record<"app" | "project.widget" | "settings" | "chat.action" | "chat.command" | "chat.card" | "mail.sidebar" | "mail.action" | "calendar.event.action" | "meeting.panel" | "project.tab" | "project.settings" | "task.action" | "issue.action" | "record.card", z.ZodOptional<z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>>, z.core.$strict>;
