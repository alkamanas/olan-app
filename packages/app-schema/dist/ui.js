import { z } from 'zod';
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
];
/** Node type of text instances; props are exactly `{ text: string }` and there are no children. */
export const TEXT_NODE_TYPE = '#text';
export function isComponentType(type) {
    return typeof type === 'string' && COMPONENT_TYPES.includes(type);
}
export const nodeIdSchema = z.number().int().nonnegative();
export const handlerRefSchema = z.strictObject({ $handler: z.number().int().nonnegative() }, { error: 'Expected an event handler reference { $handler: number }' });
export function isHandlerRef(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        Number.isInteger(value.$handler) &&
        (value.$handler >= 0));
}
export const propValueSchema = z.lazy(() => z.union([
    handlerRefSchema,
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(propValueSchema),
    z.record(z.string(), propValueSchema),
]));
export const uiPropsSchema = z.record(z.string(), propValueSchema);
export const uiNodeSchema = z.strictObject({
    id: nodeIdSchema,
    type: z.string().min(1),
    props: uiPropsSchema,
    children: z.array(nodeIdSchema),
});
export const uiPatchSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('create'), node: uiNodeSchema }),
    z.strictObject({ op: z.literal('props'), id: nodeIdSchema, set: uiPropsSchema, unset: z.array(z.string()) }),
    z.strictObject({ op: z.literal('children'), id: nodeIdSchema, children: z.array(nodeIdSchema) }),
    z.strictObject({ op: z.literal('remove'), id: nodeIdSchema }),
    z.strictObject({ op: z.literal('root'), id: nodeIdSchema.nullable() }),
]);
export const uiPatchBatchSchema = z.array(uiPatchSchema);
