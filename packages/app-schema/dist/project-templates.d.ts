import { z } from 'zod';
import { type JsonValue } from './json.js';
import type { ProjectStatusCategory } from './surfaces.js';
export declare const PROJECT_TEMPLATE_LIMITS: Readonly<{
    templates: 5;
    /** Serialised `content` of one template. */
    contentBytes: number;
    lists: 50;
    steps: 50;
    statuses: 30;
    labels: 100;
    tasks: 200;
    recordTemplates: 50;
}>;
export declare const PROJECT_TEMPLATE_KEY_PATTERN: RegExp;
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
    lists: Array<{
        key: string;
        title: string;
        code?: string | null;
        color?: string | null;
        steps?: Array<{
            key: string;
            title: string;
            color?: string | null;
        }>;
    }>;
    statuses?: ManifestProjectTemplateStatus[];
    labels?: ManifestProjectTemplateLabel[];
    /** Starter tasks (`ProjectTemplateTask`). */
    tasks?: Array<Record<string, JsonValue>>;
    /** Task and issue templates (`ProjectTemplateRecordTemplate`). */
    recordTemplates?: Array<Record<string, JsonValue>>;
    settings?: {
        description?: string;
        coverColor?: string | null;
        estimateScale?: 'none' | 'fibonacci' | 'linear' | 'tshirt';
    };
}
export interface ManifestProjectTemplate {
    /** Stable id within the app (`^[a-z0-9][a-z0-9._-]{0,62}$`); a new version with the same key replaces it. */
    key: string;
    name: string;
    description?: string;
    content: ManifestProjectTemplateContent;
}
/** zod schema of the manifest `projectTemplates` array. */
export declare const projectTemplatesSchema: z.ZodArray<z.ZodObject<{
    key: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    content: z.ZodObject<{
        version: z.ZodLiteral<1>;
        lists: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            title: z.ZodString;
            code: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                title: z.ZodString;
                color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        statuses: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            name: z.ZodString;
            color: z.ZodString;
            category: z.ZodEnum<{
                backlog: "backlog";
                unstarted: "unstarted";
                started: "started";
                completed: "completed";
                cancelled: "cancelled";
            }>;
        }, z.core.$strict>>>;
        labels: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            color: z.ZodString;
            groupName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            description: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        tasks: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
        recordTemplates: z.ZodOptional<z.ZodArray<z.ZodType<Record<string, JsonValue>, unknown, z.core.$ZodTypeInternals<Record<string, JsonValue>, unknown>>>>;
        settings: z.ZodOptional<z.ZodObject<{
            description: z.ZodOptional<z.ZodString>;
            coverColor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            estimateScale: z.ZodOptional<z.ZodEnum<{
                none: "none";
                fibonacci: "fibonacci";
                linear: "linear";
                tshirt: "tshirt";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>>;
