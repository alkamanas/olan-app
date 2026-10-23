/**
 * Version constants shared by the SDK, the host and the server.
 *
 * Bump policy (see README): `SCHEMA_VERSION` changes only when an existing
 * `olan-app.json` would be read differently or rejected; additive optional
 * fields keep the version. `PROTOCOL_VERSION` changes only when a sandbox
 * built for the old protocol can no longer talk to the host.
 */
export declare const SCHEMA_VERSION = 1;
export declare const PROTOCOL_VERSION = 1;
/** Upper bound for a `.olanapp` archive (5 MiB). */
export declare const MAX_PACKAGE_BYTES: number;
/**
 * Surfaces an app may declare (Phase 1: the first three; Phase 3 contract §3.1 the next seven, in
 * this order; Phase 6 the project tab and project settings, then the task and issue actions and the
 * record card). Per-surface options and `init.params` shapes live in `surfaces.ts`.
 */
export declare const SURFACES: readonly ["app", "project.widget", "settings", "chat.action", "chat.command", "chat.card", "mail.sidebar", "mail.action", "calendar.event.action", "meeting.panel", "project.tab", "project.settings", "task.action", "issue.action", "record.card"];
export type Surface = (typeof SURFACES)[number];
export declare function isSurface(value: unknown): value is Surface;
