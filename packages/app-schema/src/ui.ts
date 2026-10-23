import { z } from 'zod';
import type { JsonValue } from './json.js';

/** Component types: Phase 1 (contract §3), then Phase 5a (§4, §6). */
export const COMPONENT_TYPES = [
  'Screen',
  'Stack',
  'Text',
  'List',
  'Table',
  'Form',
  'TextField',
  'Select',
  'DatePicker',
  'Button',
  'Menu',
  'Card',
  'Badge',
  'EmptyState',
  'Chart',
  'Tabs',
  'Switch',
  'MultiSelect',
  'Stat',
  'Banner',
  'Image',
  'Avatar',
  'ProgressBar',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/** Node type of text instances; props are exactly `{ text: string }` and there are no children. */
export const TEXT_NODE_TYPE = '#text';
export type NodeType = ComponentType | typeof TEXT_NODE_TYPE;

export function isComponentType(type: unknown): type is ComponentType {
  return typeof type === 'string' && (COMPONENT_TYPES as readonly string[]).includes(type);
}

export type NodeId = number;

/** Reference to an event handler that lives in the sandbox. */
export type HandlerRef = { $handler: number };

export type PropValue = JsonValue | HandlerRef | PropValue[] | { [key: string]: PropValue };

export interface UiNode {
  id: NodeId;
  type: string;
  props: Record<string, PropValue>;
  children: NodeId[];
}

export type UiPatch =
  | { op: 'create'; node: UiNode }
  | { op: 'props'; id: NodeId; set: Record<string, PropValue>; unset: string[] }
  | { op: 'children'; id: NodeId; children: NodeId[] }
  | { op: 'remove'; id: NodeId }
  | { op: 'root'; id: NodeId | null };

export type UiPatchOp = UiPatch['op'];

export const nodeIdSchema = z.number().int().nonnegative();

export const handlerRefSchema: z.ZodType<HandlerRef> = z.strictObject(
  { $handler: z.number().int().nonnegative() },
  { error: 'Expected an event handler reference { $handler: number }' },
);

export function isHandlerRef(value: unknown): value is HandlerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Number.isInteger((value as { $handler?: unknown }).$handler) &&
    ((value as { $handler: number }).$handler >= 0)
  );
}

export const propValueSchema: z.ZodType<PropValue> = z.lazy(() =>
  z.union([
    handlerRefSchema,
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(propValueSchema),
    z.record(z.string(), propValueSchema),
  ]),
);

export const uiPropsSchema: z.ZodType<Record<string, PropValue>> = z.record(z.string(), propValueSchema);

export const uiNodeSchema: z.ZodType<UiNode> = z.strictObject({
  id: nodeIdSchema,
  type: z.string().min(1),
  props: uiPropsSchema,
  children: z.array(nodeIdSchema),
});

export const uiPatchSchema: z.ZodType<UiPatch> = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), node: uiNodeSchema }),
  z.strictObject({ op: z.literal('props'), id: nodeIdSchema, set: uiPropsSchema, unset: z.array(z.string()) }),
  z.strictObject({ op: z.literal('children'), id: nodeIdSchema, children: z.array(nodeIdSchema) }),
  z.strictObject({ op: z.literal('remove'), id: nodeIdSchema }),
  z.strictObject({ op: z.literal('root'), id: nodeIdSchema.nullable() }),
]);

export const uiPatchBatchSchema: z.ZodType<UiPatch[]> = z.array(uiPatchSchema);
