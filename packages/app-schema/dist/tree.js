import { z } from 'zod';
import { COMPONENT_CHILDREN, componentPropSchemas } from './components.js';
import { formatIssuePath } from './issue-path.js';
import { TEXT_NODE_TYPE, isComponentType, uiNodeSchema } from './ui.js';
/**
 * Validates a UI tree: node shape, known types, strict props per component,
 * `#text` nodes, child references, sharing, cycles and where text may appear.
 * Nodes not reachable from `root` are still checked for shape and props.
 */
export function validateTree(nodes, root) {
    const issues = [];
    const table = new Map();
    const entries = nodes instanceof Map ? [...nodes.entries()] : nodes.map((node) => [null, node]);
    for (const [mapKey, node] of entries) {
        const parsed = uiNodeSchema.safeParse(node);
        const id = typeof node?.id === 'number' ? node.id : (mapKey ?? -1);
        if (!parsed.success) {
            issues.push({
                nodeId: id,
                code: 'tree.invalid_node',
                message: `Node is malformed: ${parsed.error.issues.map((i) => `${formatIssuePath(i.path) || '(node)'}: ${i.message}`).join('; ')}`,
            });
            continue;
        }
        if (mapKey !== null && mapKey !== node.id) {
            issues.push({ nodeId: node.id, code: 'tree.id_mismatch', message: `Node is stored under id ${mapKey} but has id ${node.id}.` });
        }
        if (table.has(node.id)) {
            issues.push({ nodeId: node.id, code: 'tree.invalid_node', message: `Duplicate node id ${node.id}.` });
            continue;
        }
        table.set(node.id, node);
    }
    for (const node of table.values())
        checkNode(node, issues);
    // Child references and sharing.
    const parentOf = new Map();
    for (const node of table.values()) {
        for (const childId of node.children) {
            const child = table.get(childId);
            if (!child) {
                issues.push({ nodeId: node.id, code: 'tree.child_missing', message: `Child ${childId} of ${node.type} ${node.id} does not exist.` });
                continue;
            }
            const previous = parentOf.get(childId);
            if (previous !== undefined) {
                issues.push({
                    nodeId: childId,
                    code: 'tree.shared_child',
                    message: `Node ${childId} appears more than once (in ${previous} and ${node.id}); a node has exactly one parent.`,
                });
                continue;
            }
            parentOf.set(childId, node.id);
            checkPlacement(node, child, issues);
        }
    }
    if (root !== null) {
        const rootNode = table.get(root);
        if (!rootNode) {
            issues.push({ nodeId: root, code: 'tree.root_missing', message: `Root node ${root} does not exist.` });
        }
        else if (rootNode.type === TEXT_NODE_TYPE) {
            issues.push({ nodeId: root, code: 'tree.text_outside_text', message: 'The root cannot be a #text node.' });
        }
    }
    // Cycle detection over every node (iterative DFS, colour marking).
    const state = new Map(); // 1 = on stack, 2 = done
    for (const start of table.keys()) {
        if (state.has(start))
            continue;
        const stack = [{ id: start, next: 0 }];
        state.set(start, 1);
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const node = table.get(frame.id);
            if (frame.next >= node.children.length) {
                state.set(frame.id, 2);
                stack.pop();
                continue;
            }
            const childId = node.children[frame.next++];
            if (!table.has(childId))
                continue;
            const childState = state.get(childId);
            if (childState === 1) {
                issues.push({ nodeId: frame.id, code: 'tree.cycle', message: `Node ${frame.id} lists ancestor ${childId} as a child (cycle).` });
            }
            else if (childState === undefined) {
                state.set(childId, 1);
                stack.push({ id: childId, next: 0 });
            }
        }
    }
    return { ok: issues.length === 0, issues };
}
function checkNode(node, issues) {
    if (node.type === TEXT_NODE_TYPE) {
        const keys = Object.keys(node.props);
        if (typeof node.props.text !== 'string' || keys.length !== 1) {
            issues.push({ nodeId: node.id, code: 'tree.text_invalid', message: '#text nodes must have exactly one prop, a string `text`.' });
        }
        if (node.children.length > 0) {
            issues.push({ nodeId: node.id, code: 'tree.text_invalid', message: '#text nodes cannot have children.' });
        }
        return;
    }
    if (!isComponentType(node.type)) {
        issues.push({ nodeId: node.id, code: 'tree.unknown_type', message: `Unknown component type "${node.type}".` });
        return;
    }
    const result = componentPropSchemas[node.type].safeParse(node.props);
    if (!result.success) {
        for (const issue of result.error.issues)
            issues.push(...propIssues(node, issue));
    }
}
function propIssues(node, issue) {
    if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => {
            const path = formatIssuePath([...issue.path, key]);
            return { nodeId: node.id, code: 'tree.unknown_prop', path, message: `${node.type} has no prop "${path}".` };
        });
    }
    const path = formatIssuePath(issue.path);
    return [{ nodeId: node.id, code: 'tree.invalid_prop', path, message: `${node.type}.${path || '(props)'}: ${issue.message}` }];
}
function checkPlacement(parent, child, issues) {
    if (parent.type === TEXT_NODE_TYPE || !isComponentType(parent.type))
        return; // reported elsewhere
    const policy = COMPONENT_CHILDREN[parent.type];
    if (child.type === TEXT_NODE_TYPE) {
        if (policy !== 'text') {
            issues.push({
                nodeId: child.id,
                code: 'tree.text_outside_text',
                message: `Text must be inside a Text component, not directly in ${parent.type} ${parent.id}.`,
            });
        }
        return;
    }
    if (policy !== 'any') {
        issues.push({
            nodeId: parent.id,
            code: 'tree.children_not_allowed',
            message: `${parent.type} cannot contain ${child.type} ${child.id}${policy === 'text' ? '; only text is allowed' : ''}.`,
        });
    }
}
