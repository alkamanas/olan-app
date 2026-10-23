import type { UiTree } from '@olan-app/sdk/tree';
import type { JsonValue, NodeId, PropValue, UiNode } from '@olan-app/sdk/protocol';

/** Nodes reachable from the root, in document (depth-first) order. */
export function documentOrder(tree: UiTree): UiNode[] {
  const out: UiNode[] = [];
  const visit = (id: NodeId) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    out.push(node);
    for (const child of node.children) visit(child);
  };
  if (tree.root !== null) visit(tree.root);
  return out;
}

function str(value: PropValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function arr(value: PropValue | undefined): Record<string, PropValue>[] {
  return Array.isArray(value) ? (value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item)) as Record<string, PropValue>[]) : [];
}

function handlerId(value: PropValue | undefined): number | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { $handler?: unknown }).$handler === 'number') {
    return (value as { $handler: number }).$handler;
  }
  return null;
}

/** Current value of a field: what the test typed (until the app sends a new `value`), else the prop. */
export type FieldValues = Map<NodeId, { value: string; propAtFill: PropValue | undefined }>;

export function fieldValue(node: UiNode, values: FieldValues): string {
  const local = values.get(node.id);
  if (local && local.propAtFill === node.props.value) return local.value;
  const prop = node.props.value;
  return typeof prop === 'string' ? prop : prop === null || prop === undefined ? '' : String(prop);
}

/**
 * The text a person would see, one line per piece, in document order: `#text`, titles,
 * subtitles, labels, list rows, table cells, badges, field labels and values, empty texts.
 * Menu items are not visible until the menu opens, so they are not included.
 */
export function visibleLines(tree: UiTree, values: FieldValues = new Map()): string[] {
  const lines: string[] = [];
  const add = (...parts: (string | undefined)[]) => {
    for (const part of parts) if (part) lines.push(part);
  };
  const actions = (props: UiNode['props']) => arr(props.actions).forEach((action) => add(str(action.label)));
  for (const node of documentOrder(tree)) {
    const p = node.props;
    switch (node.type) {
      case '#text':
        add(str(p.text));
        break;
      case 'Screen':
      case 'Card':
        add(str(p.title), str(p.subtitle));
        actions(p);
        break;
      case 'Text':
        add(str(p.text));
        break;
      case 'Badge':
        add(str(p.text));
        break;
      case 'List': {
        const items = arr(p.items);
        if (items.length === 0) add(str(p.emptyText));
        for (const item of items) {
          const badge = typeof item.badge === 'object' && item.badge !== null && !Array.isArray(item.badge) ? str((item.badge as Record<string, PropValue>).text) : undefined;
          add(str(item.title), str(item.subtitle), str(item.meta), badge);
        }
        break;
      }
      case 'Table': {
        arr(p.columns).forEach((column) => add(str(column.title)));
        const rows = arr(p.rows);
        if (rows.length === 0) add(str(p.emptyText));
        for (const row of rows) {
          const cells = typeof row.cells === 'object' && row.cells !== null && !Array.isArray(row.cells) ? (row.cells as Record<string, PropValue>) : {};
          for (const cell of Object.values(cells)) if (typeof cell === 'string' || typeof cell === 'number') add(String(cell));
        }
        break;
      }
      case 'Form':
        // Buttons are drawn after the fields, but their labels are visible either way.
        add(str(p.submitLabel), str(p.cancelLabel));
        break;
      case 'TextField':
      case 'DatePicker':
        add(str(p.label), fieldValue(node, values) || undefined, str(p.error));
        break;
      case 'Select': {
        const current = fieldValue(node, values);
        const option = arr(p.options).find((candidate) => candidate.value === current);
        add(str(p.label), option ? str(option.label) : str(p.placeholder));
        break;
      }
      case 'Button':
      case 'Menu':
        add(str(p.label));
        break;
      case 'EmptyState': {
        const action = typeof p.action === 'object' && p.action !== null && !Array.isArray(p.action) ? (p.action as Record<string, PropValue>) : {};
        add(str(p.title), str(p.description), str(action.label));
        break;
      }
      case 'Chart':
        arr(p.series).forEach((series) => add(str(series.name)));
        break;
      // ---- Phase 5a ----
      case 'Tabs':
        arr(p.items).forEach((item) => add(str(item.label)));
        break;
      case 'Switch':
        add(str(p.label), str(p.description));
        break;
      case 'MultiSelect': {
        const selected = Array.isArray(p.value) ? p.value.filter((value): value is string => typeof value === 'string') : [];
        const labels = arr(p.options).filter((option) => selected.includes(String(option.value))).map((option) => str(option.label));
        add(str(p.label), ...(labels.length > 0 ? labels : [str(p.placeholder)]));
        break;
      }
      case 'Stat':
        add(str(p.label), typeof p.value === 'number' ? String(p.value) : (str(p.value) ?? (p.value === null ? '—' : undefined)), str(p.caption));
        break;
      case 'Banner': {
        const action = typeof p.action === 'object' && p.action !== null && !Array.isArray(p.action) ? (p.action as Record<string, PropValue>) : {};
        add(str(p.title), str(p.text), str(action.label));
        break;
      }
      case 'ProgressBar':
        add(str(p.label));
        break;
      default:
        break;
    }
  }
  return lines;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function matches(candidate: string | undefined, label: string | RegExp, loose = false): boolean {
  if (candidate === undefined) return false;
  if (label instanceof RegExp) return label.test(candidate);
  const a = normalizeText(candidate);
  const b = normalizeText(label);
  return loose ? a.toLocaleLowerCase('tr') === b.toLocaleLowerCase('tr') : a === b;
}

/** Something `press(label)` can trigger. */
export interface Pressable {
  label: string;
  /** What it is, for messages: `Button`, `List item`, `Menu item`, `Screen action`, … */
  kind: string;
  nodeId: NodeId;
  handlerId: number | null;
  payload: JsonValue;
  disabled: boolean;
  /** Set for a Form's submit label: pressing it submits the form. */
  submitForm?: boolean;
}

export function pressables(tree: UiTree): Pressable[] {
  const out: Pressable[] = [];
  for (const node of documentOrder(tree)) {
    const p = node.props;
    const push = (label: string | undefined, kind: string, handler: PropValue | undefined, payload: JsonValue, disabled = false, submitForm = false) => {
      if (!label) return;
      out.push({ label, kind, nodeId: node.id, handlerId: handlerId(handler), payload, disabled, ...(submitForm ? { submitForm } : {}) });
    };
    switch (node.type) {
      case 'Button':
        push(str(p.label), 'Button', p.onPress, null, p.disabled === true || p.loading === true);
        break;
      case 'Screen':
      case 'Card':
        arr(p.actions).forEach((action) => push(str(action.label), `${node.type} action`, action.onPress, null));
        break;
      case 'List':
        arr(p.items).forEach((item) => push(str(item.title), 'List item', p.onSelect, { key: (item.key ?? null) as JsonValue }, item.disabled === true));
        break;
      case 'Table':
        arr(p.rows).forEach((row) => {
          const cells = typeof row.cells === 'object' && row.cells !== null && !Array.isArray(row.cells) ? (row.cells as Record<string, PropValue>) : {};
          for (const cell of Object.values(cells)) {
            if (typeof cell === 'string' || typeof cell === 'number') push(String(cell), 'Table row', p.onSelectRow, { key: (row.key ?? null) as JsonValue });
          }
        });
        break;
      case 'Menu':
        arr(p.items).forEach((item) => push(str(item.label), 'Menu item', p.onSelect, { key: (item.key ?? null) as JsonValue }, item.disabled === true));
        break;
      case 'EmptyState': {
        const action = typeof p.action === 'object' && p.action !== null && !Array.isArray(p.action) ? (p.action as Record<string, PropValue>) : null;
        if (action) push(str(action.label), 'EmptyState action', action.onPress, null);
        break;
      }
      case 'Form':
        push(str(p.submitLabel), 'Form submit', p.onSubmit, null, false, true);
        push(str(p.cancelLabel), 'Form cancel', p.onCancel, null);
        break;
      case 'Tabs':
        arr(p.items).forEach((item) => push(str(item.label), 'Tab', p.onChange, { key: (item.key ?? null) as JsonValue }, item.disabled === true));
        break;
      case 'Banner': {
        const action = typeof p.action === 'object' && p.action !== null && !Array.isArray(p.action) ? (p.action as Record<string, PropValue>) : null;
        if (action) push(str(action.label), 'Banner action', action.onPress, null);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export const FIELD_TYPES = new Set(['TextField', 'Select', 'DatePicker']);

export function fields(tree: UiTree, within?: NodeId): UiNode[] {
  if (within === undefined) return documentOrder(tree).filter((node) => FIELD_TYPES.has(node.type));
  const out: UiNode[] = [];
  const visit = (id: NodeId) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    if (FIELD_TYPES.has(node.type)) out.push(node);
    node.children.forEach(visit);
  };
  visit(within);
  return out;
}

/** The innermost Form containing `nodeId`, if any. */
export function formOf(tree: UiTree, nodeId: NodeId): UiNode | null {
  const parents = new Map<NodeId, NodeId>();
  for (const node of tree.nodes.values()) for (const child of node.children) parents.set(child, node.id);
  let current: NodeId | undefined = parents.get(nodeId);
  while (current !== undefined) {
    const node = tree.nodes.get(current);
    if (node?.type === 'Form') return node;
    current = parents.get(current);
  }
  return null;
}

export { handlerId as handlerIdOf };
