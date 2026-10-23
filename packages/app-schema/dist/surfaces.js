import { z } from 'zod';
import { SURFACES } from './versions.js';
export const SURFACE_PRESENTATIONS = Object.freeze({
    app: 'screen',
    'project.widget': 'widget',
    settings: 'screen',
    'chat.action': 'modal',
    'chat.command': 'modal',
    'chat.card': 'modal',
    'mail.sidebar': 'panel',
    'mail.action': 'modal',
    'calendar.event.action': 'modal',
    'meeting.panel': 'panel',
    'project.tab': 'tab',
    'project.settings': 'screen',
    'task.action': 'modal',
    'issue.action': 'modal',
    'record.card': 'modal',
});
/** Surfaces whose `title` is optional (it falls back to the app name); every other surface needs one. */
export const SURFACES_WITH_OPTIONAL_TITLE = Object.freeze(['app', 'project.widget', 'settings', 'project.tab', 'project.settings']);
/**
 * Surfaces of the project page (Phase 6): shown only in projects the app is enabled in, with the
 * `projectId` in their params.
 */
export const PROJECT_SURFACES = Object.freeze(['project.widget', 'project.tab', 'project.settings', 'task.action', 'issue.action', 'record.card']);
/** Whether the surface belongs to the project page (`PROJECT_SURFACES`). */
export function isProjectSurface(surface) {
    return PROJECT_SURFACES.includes(surface);
}
/** `chat.command` `command`: what follows `/` in the composer. */
export const CHAT_COMMAND_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const SURFACE_TITLE_MAX = 80;
export const CHAT_COMMAND_DESCRIPTION_MAX = 120;
/** Most app entries a host shows in one place; the rest go under "Tüm uygulamalar" / "All apps". */
export const SURFACE_ENTRIES_PER_PLACE = 8;
// ---------------------------------------------------------------------------
// zod (manifest `surfaces`)
// ---------------------------------------------------------------------------
const notBlank = (value) => /\S/.test(value);
const titleSchema = z.string().min(1).max(SURFACE_TITLE_MAX).refine(notBlank, 'title must not be blank');
const basicSurfaceSchema = z.strictObject({ title: titleSchema.optional().describe('Title shown by the host (≤ 80).') }).describe('Surface options.');
const titledSurfaceSchema = z.strictObject({ title: titleSchema.describe('Title shown in the host menu or panel (1–80, required).') }).describe('Surface options.');
const chatCommandSurfaceSchema = z
    .strictObject({
    title: titleSchema.describe('Title shown in the suggestions (1–80, required).'),
    command: z.string().regex(CHAT_COMMAND_PATTERN).describe('Command typed after "/": ^[a-z][a-z0-9-]{1,31}$.'),
    description: z.string().max(CHAT_COMMAND_DESCRIPTION_MAX).optional().describe('Shown next to the command (≤ 120).'),
})
    .describe('chat.command options.');
const SURFACE_SCHEMAS = {
    app: basicSurfaceSchema,
    'project.widget': basicSurfaceSchema,
    settings: basicSurfaceSchema,
    'chat.action': titledSurfaceSchema,
    'chat.command': chatCommandSurfaceSchema,
    'chat.card': titledSurfaceSchema,
    'mail.sidebar': titledSurfaceSchema,
    'mail.action': titledSurfaceSchema,
    'calendar.event.action': titledSurfaceSchema,
    'meeting.panel': titledSurfaceSchema,
    'project.tab': basicSurfaceSchema,
    'project.settings': basicSurfaceSchema,
    'task.action': titledSurfaceSchema,
    'issue.action': titledSurfaceSchema,
    'record.card': titledSurfaceSchema,
};
/** zod schema of the manifest `surfaces` object (strict: unknown surfaces are rejected). */
export const surfacesSchema = z
    .strictObject(Object.fromEntries(SURFACES.map((surface) => [surface, SURFACE_SCHEMAS[surface].optional()])))
    .describe(`Surfaces the app provides. Known surfaces: ${SURFACES.join(', ')}.`);
