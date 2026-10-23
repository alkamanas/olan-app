import { TEXT_NODE_TYPE, type JsonValue, type PropValue, type UiPatch } from '../protocol';
import { diffProps, serializeProps, type HandlerAllocator, type HandlerSlots } from './serialize';

export type HandlerFn = (payload: JsonValue) => unknown;

export interface HostElement {
  kind: 'element';
  container: UiContainer;
  id: number;
  type: string;
  /** Latest React props (functions included). */
  rawProps: Record<string, unknown>;
  /** Wire props last sent to the host. */
  props: Record<string, PropValue>;
  slots: HandlerSlots;
  children: HostChild[];
  parent: HostElement | null;
  /** The host has a `create` for this node and it has not been removed since. */
  sent: boolean;
  /** Hidden by a Suspense boundary: kept, but left out of its parent's `children`. */
  hidden: boolean;
}

export interface HostText {
  kind: 'text';
  container: UiContainer;
  id: number;
  text: string;
  parent: HostElement | null;
  sent: boolean;
  hidden: boolean;
}

export type HostChild = HostElement | HostText;

export type PatchListener = (seq: number, patches: UiPatch[]) => void;

/**
 * The reconciler's container: owns the node table ids, the handler registry and the patch queue
 * of the commit in progress. Host-config callbacks record changes here; `flush()` (called from
 * `resetAfterCommit`) turns them into one `UiPatch[]` batch with the next `seq`.
 *
 * Batch order: `create` (children before parents, so every referenced id exists), `props`,
 * `children` (full child list of each touched parent), `remove` (subtree roots; the host drops
 * the descendants with them), `root`.
 */
export class UiContainer implements HandlerAllocator {
  readonly children: HostChild[] = [];
  private nextNodeId = 1;
  private nextHandlerId = 1;
  private readonly handlers = new Map<number, HandlerFn>();
  private creates: UiPatch[] = [];
  private propPatches: UiPatch[] = [];
  private readonly childrenDirty = new Set<HostElement>();
  private removes: number[] = [];
  private rootDirty = false;
  private lastRoot: number | null = null;
  private seq = 0;

  constructor(private readonly onPatches: PatchListener) {}

  // ---- ids and handlers ----

  allocateNodeId(): number {
    return this.nextNodeId++;
  }

  register(fn: HandlerFn): number {
    const id = this.nextHandlerId++;
    this.handlers.set(id, fn);
    return id;
  }

  update(id: number, fn: HandlerFn): void {
    this.handlers.set(id, fn);
  }

  release(id: number): void {
    this.handlers.delete(id);
  }

  getHandler(id: number): HandlerFn | undefined {
    return this.handlers.get(id);
  }

  /** Live handler count (tests check that removed nodes free theirs). */
  get handlerCount(): number {
    return this.handlers.size;
  }

  get lastSeq(): number {
    return this.seq;
  }

  // ---- commit-phase recording ----

  /** `child` was placed under `parent` (`null` = the container) during a commit. */
  attached(parent: HostElement | null, child: HostChild): void {
    if (!child.sent) this.create(child);
    this.touch(parent);
  }

  /** `child` was removed from `parent` (`null` = the container); its subtree is gone for good. */
  detached(parent: HostElement | null, child: HostChild): void {
    this.touch(parent);
    if (child.sent) this.removes.push(child.id);
    this.releaseSubtree(child);
  }

  /** A parent's child order or visibility changed. */
  touch(parent: HostElement | null): void {
    if (parent) {
      if (parent.sent) this.childrenDirty.add(parent);
    } else {
      this.rootDirty = true;
    }
  }

  updateProps(node: HostElement, rawProps: Record<string, unknown>): void {
    node.rawProps = rawProps;
    const next = serializeProps(rawProps, node.slots, this);
    const diff = diffProps(node.props, next);
    node.props = next;
    if (diff && node.sent) this.propPatches.push({ op: 'props', id: node.id, set: diff.set, unset: diff.unset });
  }

  updateText(node: HostText, text: string): void {
    if (node.text === text) return;
    node.text = text;
    if (node.sent) this.propPatches.push({ op: 'props', id: node.id, set: { text }, unset: [] });
  }

  /** Emits the recorded changes as one batch. */
  flush(): void {
    const patches: UiPatch[] = [...this.creates, ...this.propPatches];
    for (const parent of this.childrenDirty) {
      if (parent.sent) patches.push({ op: 'children', id: parent.id, children: visibleIds(parent.children) });
    }
    for (const id of this.removes) patches.push({ op: 'remove', id });
    if (this.rootDirty) {
      const root = this.children.find((child) => !child.hidden)?.id ?? null;
      if (root !== this.lastRoot) {
        this.lastRoot = root;
        patches.push({ op: 'root', id: root });
      }
    }
    this.creates = [];
    this.propPatches = [];
    this.childrenDirty.clear();
    this.removes = [];
    this.rootDirty = false;
    if (patches.length === 0) return;
    this.seq += 1;
    this.onPatches(this.seq, patches);
  }

  private create(node: HostChild): void {
    if (node.kind === 'text') {
      this.creates.push({ op: 'create', node: { id: node.id, type: TEXT_NODE_TYPE, props: { text: node.text }, children: [] } });
      node.sent = true;
      return;
    }
    for (const child of node.children) if (!child.sent) this.create(child);
    node.props = serializeProps(node.rawProps, node.slots, this);
    this.creates.push({ op: 'create', node: { id: node.id, type: node.type, props: node.props, children: visibleIds(node.children) } });
    node.sent = true;
  }

  private releaseSubtree(node: HostChild): void {
    node.sent = false;
    if (node.kind === 'text') return;
    for (const id of node.slots.values()) this.release(id);
    node.slots.clear();
    this.childrenDirty.delete(node);
    for (const child of node.children) this.releaseSubtree(child);
  }
}

function visibleIds(children: HostChild[]): number[] {
  const ids: number[] = [];
  for (const child of children) if (!child.hidden) ids.push(child.id);
  return ids;
}
