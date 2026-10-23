import { z } from 'zod';
import { BUTTON_VARIANTS } from './components.js';
import { jsonValueSchema as jsonValue, type JsonValue } from './json.js';
import type { EmbeddedAppToken } from './remote.js';
import type { ProfileRole } from './remote-requests.js';
import { validateTree, type TreeIssueCode } from './tree.js';
import { TEXT_NODE_TYPE, type UiNode } from './ui.js';

/*
 * Static chat cards (`chat.card`, Phase 3 contract §3.2): the UI tree format without handlers.
 * Sent with `chat.postCard` / `chat.updateCard` from the sandbox or from the app's server, and
 * returned by `card-actions`.
 */

export const CARD_VERSION = 1;

/** Components a card may use (and `#text`). */
export const CARD_COMPONENTS = ['Card', 'Stack', 'Text', 'Badge', 'Table', 'Button', 'EmptyState'] as const;
export type CardComponent = (typeof CARD_COMPONENTS)[number];

export const CARD_LIMITS = Object.freeze({
  /** Serialised card JSON. */
  bytes: 16 * 1024,
  nodes: 100,
  /** Root = depth 1. */
  depth: 8,
  fallbackTextMax: 500,
  /** Serialised `payload` of one button action. */
  payloadBytes: 2 * 1024,
});

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
export type CardButtonAction = { kind: 'open'; payload?: JsonValue } | { kind: 'submit'; name: string; payload?: JsonValue };

/** Wire props of a card `Button` (no `onPress`). */
export interface CardButtonProps {
  label: string;
  action: CardButtonAction;
  variant?: (typeof BUTTON_VARIANTS)[number];
  icon?: string;
  disabled?: boolean;
}

export const CARD_ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export const cardButtonActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), payload: jsonValue.optional() }),
  z.strictObject({ kind: z.literal('submit'), name: z.string().regex(CARD_ACTION_NAME_PATTERN), payload: jsonValue.optional() }),
]);

export const cardButtonPropsSchema = z.strictObject({
  label: z.string(),
  action: cardButtonActionSchema,
  variant: z.enum(BUTTON_VARIANTS).optional(),
  icon: z.string().min(1).max(64).optional(),
  disabled: z.boolean().optional(),
});

export type CardIssueCode =
  | 'card.invalid'
  | 'card.too_large'
  | 'card.too_many_nodes'
  | 'card.too_deep'
  | 'card.fallback_text'
  | 'card.component_not_allowed'
  | 'card.handler_not_allowed'
  | 'card.action_invalid'
  | 'card.payload_too_large'
  | 'card.submit_requires_remote'
  | TreeIssueCode;

export interface CardIssue {
  code: CardIssueCode;
  message: string;
  nodeId?: number;
  /** Prop path for prop issues. */
  path?: string;
}

export type ValidateCardResult = { ok: true; card: AppCard } | { ok: false; issues: CardIssue[] };

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function containsHandler(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHandler);
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, '$handler')) return true;
  return Object.values(value).some(containsHandler);
}

/**
 * Validates a card: shape and limits, allowed components, no `$handler`, button actions, then
 * `validateTree` (props, children, cycles) on the tree. `remote: false` rejects `submit` buttons
 * (the app has no server); leave it out to skip that rule.
 */
export function validateCard(input: unknown, options: { remote?: boolean } = {}): ValidateCardResult {
  const issues: CardIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ code: 'card.invalid', message: 'A card must be an object { version: 1, root, nodes, fallbackText }.' }] };
  const unknown = Object.keys(input).filter((key) => !['version', 'root', 'nodes', 'fallbackText'].includes(key));
  if (unknown.length > 0) issues.push({ code: 'card.invalid', message: `Unknown card field(s): ${unknown.join(', ')}.` });
  if (input.version !== CARD_VERSION) issues.push({ code: 'card.invalid', message: `"version" must be ${CARD_VERSION}.` });
  if (typeof input.root !== 'number' || !Number.isInteger(input.root) || input.root < 0) issues.push({ code: 'card.invalid', message: '"root" must be a node id.' });
  if (!Array.isArray(input.nodes)) issues.push({ code: 'card.invalid', message: '"nodes" must be an array of UI nodes.' });
  const fallback = input.fallbackText;
  if (typeof fallback !== 'string' || fallback.trim().length === 0 || fallback.length > CARD_LIMITS.fallbackTextMax) {
    issues.push({ code: 'card.fallback_text', message: `"fallbackText" must be 1–${CARD_LIMITS.fallbackTextMax} characters (used in notifications, search and previews).` });
  }
  let size = 0;
  try {
    size = byteLength(input);
  } catch {
    issues.push({ code: 'card.invalid', message: 'A card must be JSON.' });
  }
  if (size > CARD_LIMITS.bytes) issues.push({ code: 'card.too_large', message: `The card is ${size} bytes; at most ${CARD_LIMITS.bytes}.` });
  if (!Array.isArray(input.nodes) || typeof input.root !== 'number') return { ok: false, issues };
  const nodes = input.nodes as unknown[];
  if (nodes.length > CARD_LIMITS.nodes) issues.push({ code: 'card.too_many_nodes', message: `The card has ${nodes.length} nodes; at most ${CARD_LIMITS.nodes}.` });

  // Card rules per node; buttons get a stand-in handler so validateTree checks the rest of their props.
  const forTree: unknown[] = nodes.map((raw) => {
    if (!isRecord(raw) || !isRecord(raw.props)) return raw;
    const id = typeof raw.id === 'number' ? raw.id : -1;
    const type = raw.type;
    if (type !== TEXT_NODE_TYPE && !(CARD_COMPONENTS as readonly unknown[]).includes(type)) {
      issues.push({ code: 'card.component_not_allowed', nodeId: id, message: `${String(type)} is not allowed in cards; use ${CARD_COMPONENTS.join(', ')}.` });
      return raw;
    }
    if (containsHandler(raw.props)) {
      issues.push({ code: 'card.handler_not_allowed', nodeId: id, message: `${String(type)} ${id}: cards have no event handlers; buttons use "action".` });
      return raw;
    }
    if (type !== 'Button') return raw;
    const { action, ...rest } = raw.props;
    const parsed = cardButtonActionSchema.safeParse(action);
    if (!parsed.success) {
      issues.push({
        code: 'card.action_invalid',
        nodeId: id,
        path: 'action',
        message: `Button ${id}: "action" must be { kind: "open", payload? } or { kind: "submit", name, payload? } (${parsed.error.issues[0]?.message ?? 'invalid'}).`,
      });
    } else {
      if (parsed.data.payload !== undefined && byteLength(parsed.data.payload) > CARD_LIMITS.payloadBytes) {
        issues.push({ code: 'card.payload_too_large', nodeId: id, path: 'action.payload', message: `Button ${id}: the action payload is larger than ${CARD_LIMITS.payloadBytes} bytes.` });
      }
      if (parsed.data.kind === 'submit' && options.remote === false) {
        issues.push({ code: 'card.submit_requires_remote', nodeId: id, path: 'action', message: `Button ${id}: "submit" actions need the app's own server (manifest "remote"); use "open" instead.` });
      }
    }
    return { ...raw, props: { ...rest, onPress: { $handler: 0 } } };
  });

  const tree = validateTree(forTree as UiNode[], input.root);
  for (const problem of tree.issues) {
    issues.push({ code: problem.code, nodeId: problem.nodeId, ...(problem.path ? { path: problem.path } : {}), message: problem.message });
  }

  // Depth from the root (cycles are reported by validateTree).
  const table = new Map<number, UiNode>();
  for (const node of nodes) if (isRecord(node) && typeof node.id === 'number' && Array.isArray(node.children)) table.set(node.id, node as unknown as UiNode);
  let deepest = 0;
  const seen = new Set<number>();
  const walk: Array<[number, number]> = [[input.root, 1]];
  while (walk.length > 0) {
    const [id, depth] = walk.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = table.get(id);
    if (!node || node.type === TEXT_NODE_TYPE) continue;
    deepest = Math.max(deepest, depth);
    for (const child of node.children) walk.push([child, depth + 1]);
  }
  if (deepest > CARD_LIMITS.depth) issues.push({ code: 'card.too_deep', message: `The card is ${deepest} levels deep; at most ${CARD_LIMITS.depth}.` });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, card: input as unknown as AppCard };
}

/**
 * A record card (Phase 6: the card an app draws on a task or issue it linked one of its records to,
 * `project.links.upsert`): a valid card whose buttons only `open` (the app's `record.card` surface).
 */
export function validateRecordCard(input: unknown): ValidateCardResult {
  const result = validateCard(input);
  if (!result.ok) return result;
  const submits = cardActions(result.card).filter((entry) => entry.action.kind !== 'open');
  if (!submits.length) return result;
  return {
    ok: false,
    issues: submits.map((entry) => ({
      code: 'card.action_invalid' as const,
      nodeId: entry.nodeId,
      path: 'action',
      message: `Button ${entry.nodeId}: record cards only open the app's "record.card" surface; use { kind: "open", payload? }.`,
    })),
  };
}

/** Every `submit` action name and every button action of a valid card (for hosts and servers). */
export function cardActions(card: AppCard): Array<{ nodeId: number; action: CardButtonAction }> {
  return card.nodes.filter((node) => node.type === 'Button').map((node) => ({ nodeId: node.id, action: node.props.action as CardButtonAction }));
}

/** Body of `POST {remote.url}/card-actions` (signed like events, §5.4). */
export interface CardActionRequest {
  /** `act_<uuid>`; also the `webhook-id`. */
  id: string;
  issuer: string;
  installationId: string;
  /** `email`, `displayName` and `role` only when the person consented to `profile:read`. */
  user: { id: string; locale: string; email?: string; displayName?: string; role?: ProfileRole };
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
  toast?: { text: string; tone?: 'default' | 'success' | 'warning' | 'danger' };
}
