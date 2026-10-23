import { z } from 'zod';
import type { JsonValue } from './json.js';
/** Component types: Phase 1 (contract §3), then Phase 5a (§4, §6). */
export declare const COMPONENT_TYPES: readonly ["Screen", "Stack", "Text", "List", "Table", "Form", "TextField", "Select", "DatePicker", "Button", "Menu", "Card", "Badge", "EmptyState", "Chart", "Tabs", "Switch", "MultiSelect", "Stat", "Banner", "Image", "Avatar", "ProgressBar"];
export type ComponentType = (typeof COMPONENT_TYPES)[number];
/** Node type of text instances; props are exactly `{ text: string }` and there are no children. */
export declare const TEXT_NODE_TYPE = "#text";
export type NodeType = ComponentType | typeof TEXT_NODE_TYPE;
export declare function isComponentType(type: unknown): type is ComponentType;
export type NodeId = number;
/** Reference to an event handler that lives in the sandbox. */
export type HandlerRef = {
    $handler: number;
};
export type PropValue = JsonValue | HandlerRef | PropValue[] | {
    [key: string]: PropValue;
};
export interface UiNode {
    id: NodeId;
    type: string;
    props: Record<string, PropValue>;
    children: NodeId[];
}
export type UiPatch = {
    op: 'create';
    node: UiNode;
} | {
    op: 'props';
    id: NodeId;
    set: Record<string, PropValue>;
    unset: string[];
} | {
    op: 'children';
    id: NodeId;
    children: NodeId[];
} | {
    op: 'remove';
    id: NodeId;
} | {
    op: 'root';
    id: NodeId | null;
};
export type UiPatchOp = UiPatch['op'];
export declare const nodeIdSchema: z.ZodNumber;
export declare const handlerRefSchema: z.ZodType<HandlerRef>;
export declare function isHandlerRef(value: unknown): value is HandlerRef;
export declare const propValueSchema: z.ZodType<PropValue>;
export declare const uiPropsSchema: z.ZodType<Record<string, PropValue>>;
export declare const uiNodeSchema: z.ZodType<UiNode>;
export declare const uiPatchSchema: z.ZodType<UiPatch>;
export declare const uiPatchBatchSchema: z.ZodType<UiPatch[]>;
