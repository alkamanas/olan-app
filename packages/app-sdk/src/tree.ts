import type { NodeId, UiNode, UiPatch } from './protocol';

/** A host-side copy of the UI tree: the flat node table plus the root id. */
export interface UiTree {
  nodes: Map<NodeId, UiNode>;
  root: NodeId | null;
}

export function createUiTree(): UiTree {
  return { nodes: new Map(), root: null };
}

/**
 * Applies one patch batch in order. Changed nodes are replaced by new objects (never mutated),
 * so a renderer can compare node identity to skip unchanged subtrees. `remove` drops the node and
 * its descendants. Returns the ids whose node object changed or disappeared.
 */
export function applyPatches(tree: UiTree, patches: readonly UiPatch[]): Set<NodeId> {
  const touched = new Set<NodeId>();
  for (const patch of patches) {
    switch (patch.op) {
      case 'create':
        tree.nodes.set(patch.node.id, { ...patch.node, children: [...patch.node.children] });
        touched.add(patch.node.id);
        break;
      case 'props': {
        const node = tree.nodes.get(patch.id);
        if (!node) break;
        const props = { ...node.props, ...patch.set };
        for (const key of patch.unset) delete props[key];
        tree.nodes.set(patch.id, { ...node, props });
        touched.add(patch.id);
        break;
      }
      case 'children': {
        const node = tree.nodes.get(patch.id);
        if (!node) break;
        tree.nodes.set(patch.id, { ...node, children: [...patch.children] });
        touched.add(patch.id);
        break;
      }
      case 'remove':
        removeSubtree(tree, patch.id, touched);
        break;
      case 'root':
        tree.root = patch.id;
        break;
    }
  }
  return touched;
}

function removeSubtree(tree: UiTree, id: NodeId, touched: Set<NodeId>): void {
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    const node = tree.nodes.get(current);
    if (!node) continue;
    tree.nodes.delete(current);
    touched.add(current);
    stack.push(...node.children);
  }
}

/** Nested JSON view of the tree (tests, snapshots, `olan-app` tooling). */
export interface UiTreeSnapshot {
  type: string;
  props: UiNode['props'];
  children: UiTreeSnapshot[];
}

export function snapshotTree(tree: UiTree, id: NodeId | null = tree.root): UiTreeSnapshot | null {
  if (id === null) return null;
  const node = tree.nodes.get(id);
  if (!node) return null;
  return {
    type: node.type,
    props: node.props,
    children: node.children.map((child) => snapshotTree(tree, child)).filter((child): child is UiTreeSnapshot => child !== null),
  };
}

/** All text in the subtree (`#text` nodes and `text`/`label`/`title` props), for tests. */
export function treeText(tree: UiTree, id: NodeId | null = tree.root): string {
  if (id === null) return '';
  const node = tree.nodes.get(id);
  if (!node) return '';
  const parts: string[] = [];
  for (const key of ['text', 'title', 'label', 'subtitle']) {
    const value = node.props[key];
    if (typeof value === 'string') parts.push(value);
  }
  for (const child of node.children) parts.push(treeText(tree, child));
  return parts.filter(Boolean).join(' ');
}
