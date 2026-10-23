import { z } from 'zod';
import { jsonObjectSchema, type JsonValue } from './json.js';
import type { ProjectStatusCategory } from './surfaces.js';

/*
 * Project templates an app offers (`projectTemplates`, Phase 6 second wave). The organization's
 * "Yeni proje" screen lists them while the app is installed for the person; a project made from one
 * gets the template's work packages, statuses, labels, starter tasks and task/issue templates, and
 * the app is added to it. The statuses and labels it brings are the app's (read-only for members).
 *
 * The content has the shape of Olan's own project templates (`ProjectTemplateContent` in
 * `@olan/contracts`). This schema checks the structure; the server checks the rest (references
 * between keys, one status per required category) when it reads the installed version, and skips a
 * template it cannot use.
 */

export const PROJECT_TEMPLATE_LIMITS = Object.freeze({
  templates: 5,
  /** Serialised `content` of one template. */
  contentBytes: 64 * 1024,
  lists: 50,
  steps: 50,
  statuses: 30,
  labels: 100,
  tasks: 200,
  recordTemplates: 50,
});

export const PROJECT_TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const STATUS_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const satisfies readonly ProjectStatusCategory[];

export interface ManifestProjectTemplateStatus {
  key: string;
  name: string;
  color: string;
  category: ProjectStatusCategory;
}

export interface ManifestProjectTemplateLabel {
  name: string;
  color: string;
  groupName?: string | null;
  description?: string;
}

export interface ManifestProjectTemplateContent {
  version: 1;
  lists: Array<{ key: string; title: string; code?: string | null; color?: string | null; steps?: Array<{ key: string; title: string; color?: string | null }> }>;
  statuses?: ManifestProjectTemplateStatus[];
  labels?: ManifestProjectTemplateLabel[];
  /** Starter tasks (`ProjectTemplateTask`). */
  tasks?: Array<Record<string, JsonValue>>;
  /** Task and issue templates (`ProjectTemplateRecordTemplate`). */
  recordTemplates?: Array<Record<string, JsonValue>>;
  settings?: { description?: string; coverColor?: string | null; estimateScale?: 'none' | 'fibonacci' | 'linear' | 'tshirt' };
}

export interface ManifestProjectTemplate {
  /** Stable id within the app (`^[a-z0-9][a-z0-9._-]{0,62}$`); a new version with the same key replaces it. */
  key: string;
  name: string;
  description?: string;
  content: ManifestProjectTemplateContent;
}

const notBlank = (value: string) => /\S/.test(value);
const listKey = z.string().min(1).max(40).refine(notBlank);
const color = z.string().regex(HEX_COLOR);

const contentSchema = z
  .strictObject({
    version: z.literal(1),
    lists: z
      .array(
        z.strictObject({
          key: listKey,
          title: z.string().min(1).max(200).refine(notBlank),
          code: z.string().max(24).nullable().optional(),
          color: color.nullable().optional(),
          steps: z
            .array(z.strictObject({ key: listKey, title: z.string().min(1).max(200).refine(notBlank), color: color.nullable().optional() }))
            .max(PROJECT_TEMPLATE_LIMITS.steps)
            .optional(),
        }),
      )
      .min(1)
      .max(PROJECT_TEMPLATE_LIMITS.lists),
    statuses: z
      .array(z.strictObject({ key: z.string().regex(PROJECT_TEMPLATE_KEY_PATTERN), name: z.string().min(1).max(60).refine(notBlank), color, category: z.enum(STATUS_CATEGORIES) }))
      .max(PROJECT_TEMPLATE_LIMITS.statuses)
      .optional(),
    labels: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(50).refine(notBlank),
          color,
          groupName: z.string().min(1).max(50).nullable().optional(),
          description: z.string().max(500).optional(),
        }),
      )
      .max(PROJECT_TEMPLATE_LIMITS.labels)
      .optional(),
    tasks: z.array(jsonObjectSchema).max(PROJECT_TEMPLATE_LIMITS.tasks).optional(),
    recordTemplates: z.array(jsonObjectSchema).max(PROJECT_TEMPLATE_LIMITS.recordTemplates).optional(),
    settings: z
      .strictObject({
        description: z.string().max(20000).optional(),
        coverColor: z.string().max(32).nullable().optional(),
        estimateScale: z.enum(['none', 'fibonacci', 'linear', 'tshirt']).optional(),
      })
      .optional(),
  })
  .refine((content) => new TextEncoder().encode(JSON.stringify(content)).length <= PROJECT_TEMPLATE_LIMITS.contentBytes, {
    message: `A template's content is at most ${PROJECT_TEMPLATE_LIMITS.contentBytes} bytes.`,
  })
  .describe('The template: work packages ("lists", with "steps"), "statuses", "labels", starter "tasks", "recordTemplates" and "settings" (docs/manifest.md).');

/** zod schema of the manifest `projectTemplates` array. */
export const projectTemplatesSchema = z
  .array(
    z.strictObject({
      key: z.string().regex(PROJECT_TEMPLATE_KEY_PATTERN).describe('Stable id within the app.'),
      name: z.string().min(1).max(120).refine(notBlank).describe('Name in "Yeni proje" (≤ 120).'),
      description: z.string().max(2000).optional().describe('When to use it (≤ 2000).'),
      content: contentSchema,
    }),
  )
  .max(PROJECT_TEMPLATE_LIMITS.templates)
  .refine((templates) => new Set(templates.map((template) => template.key)).size === templates.length, { message: 'Template keys must be unique.' })
  .describe(`Project templates the app offers in "Yeni proje" (≤ ${PROJECT_TEMPLATE_LIMITS.templates}); a project made from one has the app added.`);
