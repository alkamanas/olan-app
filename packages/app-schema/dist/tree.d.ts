import { type UiNode } from './ui.js';
export type TreeIssueCode = 'tree.invalid_node' | 'tree.id_mismatch' | 'tree.root_missing' | 'tree.child_missing' | 'tree.shared_child' | 'tree.cycle' | 'tree.unknown_type' | 'tree.unknown_prop' | 'tree.invalid_prop' | 'tree.text_invalid' | 'tree.text_outside_text' | 'tree.children_not_allowed';
export interface TreeIssue {
    nodeId: number;
    code: TreeIssueCode;
    message: string;
    /** Prop path for prop issues, e.g. `items[2].title`. */
    path?: string;
}
export interface ValidateTreeResult {
    ok: boolean;
    issues: TreeIssue[];
}
/**
 * Validates a UI tree: node shape, known types, strict props per component,
 * `#text` nodes, child references, sharing, cycles and where text may appear.
 * Nodes not reachable from `root` are still checked for shape and props.
 */
export declare function validateTree(nodes: UiNode[] | Map<number, UiNode>, root: number | null): ValidateTreeResult;
