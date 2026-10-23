import { z } from 'zod';
import { BUTTON_VARIANTS } from './components.js';
import { type JsonValue } from './json.js';
import type { EmbeddedAppToken } from './remote.js';
import type { ProfileRole } from './remote-requests.js';
import { type TreeIssueCode } from './tree.js';
import { type UiNode } from './ui.js';
export declare const CARD_VERSION = 1;
/** Components a card may use (and `#text`). */
export declare const CARD_COMPONENTS: readonly ["Card", "Stack", "Text", "Badge", "Table", "Button", "EmptyState"];
export type CardComponent = (typeof CARD_COMPONENTS)[number];
export declare const CARD_LIMITS: Readonly<{
    /** Serialised card JSON. */
    bytes: number;
    nodes: 100;
    /** Root = depth 1. */
    depth: 8;
    fallbackTextMax: 500;
    /** Serialised `payload` of one button action. */
    payloadBytes: number;
}>;
/**
 * A card: `nodes` like a UI tree, `root` the top node, `fallbackText` (1–500) for notifications,
 * search and previews. Buttons carry `action` instead of `onPress`.
 */
export interface AppCard {
    version: typeof CARD_VERSION;
    root: number;
    nodes: UiNode[];
    fallbackText: string;
}
/**
 * A card button's action: `open` opens the app's `chat.card` surface (params
 * `{ conversationId, messageId, payload }`); `submit` calls the app's server
 * (`POST {remote.url}/card-actions`) and needs `remote`.
 */
export type CardButtonAction = {
    kind: 'open';
    payload?: JsonValue;
} | {
    kind: 'submit';
    name: string;
    payload?: JsonValue;
};
/** Wire props of a card `Button` (no `onPress`). */
export interface CardButtonProps {
    label: string;
    action: CardButtonAction;
    variant?: (typeof BUTTON_VARIANTS)[number];
    icon?: string;
    disabled?: boolean;
}
export declare const CARD_ACTION_NAME_PATTERN: RegExp;
export declare const cardButtonActionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"open">;
    payload: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"submit">;
    name: z.ZodString;
    payload: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
}, z.core.$strict>], "kind">;
export declare const cardButtonPropsSchema: z.ZodObject<{
    label: z.ZodString;
    action: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"open">;
        payload: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"submit">;
        name: z.ZodString;
        payload: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    }, z.core.$strict>], "kind">;
    variant: z.ZodOptional<z.ZodEnum<{
        danger: "danger";
        primary: "primary";
        secondary: "secondary";
        ghost: "ghost";
    }>>;
    icon: z.ZodOptional<z.ZodString>;
    disabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type CardIssueCode = 'card.invalid' | 'card.too_large' | 'card.too_many_nodes' | 'card.too_deep' | 'card.fallback_text' | 'card.component_not_allowed' | 'card.handler_not_allowed' | 'card.action_invalid' | 'card.payload_too_large' | 'card.submit_requires_remote' | TreeIssueCode;
export interface CardIssue {
    code: CardIssueCode;
    message: string;
    nodeId?: number;
    /** Prop path for prop issues. */
    path?: string;
}
export type ValidateCardResult = {
    ok: true;
    card: AppCard;
} | {
    ok: false;
    issues: CardIssue[];
};
/**
 * Validates a card: shape and limits, allowed components, no `$handler`, button actions, then
 * `validateTree` (props, children, cycles) on the tree. `remote: false` rejects `submit` buttons
 * (the app has no server); leave it out to skip that rule.
 */
export declare function validateCard(input: unknown, options?: {
    remote?: boolean;
}): ValidateCardResult;
/**
 * A record card (Phase 6: the card an app draws on a task or issue it linked one of its records to,
 * `project.links.upsert`): a valid card whose buttons only `open` (the app's `record.card` surface).
 */
export declare function validateRecordCard(input: unknown): ValidateCardResult;
/** Every `submit` action name and every button action of a valid card (for hosts and servers). */
export declare function cardActions(card: AppCard): Array<{
    nodeId: number;
    action: CardButtonAction;
}>;
/** Body of `POST {remote.url}/card-actions` (signed like events, §5.4). */
export interface CardActionRequest {
    /** `act_<uuid>`; also the `webhook-id`. */
    id: string;
    issuer: string;
    installationId: string;
    /** `email`, `displayName` and `role` only when the person consented to `profile:read`. */
    user: {
        id: string;
        locale: string;
        email?: string;
        displayName?: string;
        role?: ProfileRole;
    };
    conversationId: string;
    messageId: string;
    /** The button's `action.name`. */
    name: string;
    payload: JsonValue;
    /** On behalf of the person who pressed the button (300 s). */
    token: EmbeddedAppToken;
}
/** Response of `card-actions` (≤ 5 s): a new card replaces the message's card; a toast is shown to the person. */
export interface CardActionResponse {
    card?: AppCard;
    toast?: {
        text: string;
        tone?: 'default' | 'success' | 'warning' | 'danger';
    };
}
