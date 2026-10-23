import { createContext } from 'react';
import Reconciler from 'react-reconciler';
import { DefaultEventPriority, DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants';

import { SDK_VERSION } from '../protocol';
import type { HostChild, HostElement, HostText, UiContainer } from './ui-container';

type Props = Record<string, unknown>;
type HostContext = Record<string, never>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

type Config = Reconciler.HostConfig<
  string, // Type
  Props,
  UiContainer,
  HostElement,
  HostText,
  never, // ActivityInstance
  never, // SuspenseInstance
  never, // HydratableInstance
  never, // FormInstance
  HostChild, // PublicInstance
  HostContext,
  never, // ChildSet
  TimeoutHandle,
  -1, // NoTimeout
  null, // TransitionStatus
  null, // SuspendedState
  null, // RendererInspectionConfig
  never, // FormStateMarkerInstance
  never, // HoistableRoot
  never // Resource
>;

const ROOT_CONTEXT: HostContext = {};
let currentUpdatePriority: number = NoEventPriority;

function insertChild(list: HostChild[], child: HostChild, before: HostChild | null): void {
  const existing = list.indexOf(child);
  if (existing !== -1) list.splice(existing, 1);
  const index = before ? list.indexOf(before) : -1;
  if (index === -1) list.push(child);
  else list.splice(index, 0, child);
}

function removeFromList(list: HostChild[], child: HostChild): void {
  const index = list.indexOf(child);
  if (index !== -1) list.splice(index, 1);
}

/*
 * Mutation-mode host config. Instances only record state; every change is reported to the
 * instance's `UiContainer`, which turns one commit into one patch batch in `resetAfterCommit`.
 * Instances created during a render that never commits are never announced to the host, so they
 * allocate no handler ids.
 */
const hostConfig: Config = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  // Secondary renderer: the SDK may share a process with react-dom (headless tests, previews).
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  rendererVersion: SDK_VERSION,
  rendererPackageName: '@olan-app/sdk',
  extraDevToolsConfig: null,

  bindToConsole(methodName, args, badgeName) {
    const method = (console as unknown as Record<string, (...a: unknown[]) => void>)[methodName] ?? console.log;
    return method.bind(console, `[${badgeName}]`, ...args);
  },

  createInstance(type, props, container): HostElement {
    return {
      kind: 'element',
      container,
      id: container.allocateNodeId(),
      type,
      rawProps: props,
      props: {},
      slots: new Map(),
      children: [],
      parent: null,
      sent: false,
      hidden: false,
    };
  },

  createTextInstance(text, container): HostText {
    return { kind: 'text', container, id: container.allocateNodeId(), text, parent: null, sent: false, hidden: false };
  },

  appendInitialChild(parent, child) {
    child.parent = parent;
    parent.children.push(child);
  },

  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => ROOT_CONTEXT,
  getChildHostContext: (parentContext) => parentContext,
  getPublicInstance: (instance) => instance,
  prepareForCommit: () => null,
  resetAfterCommit(container) {
    container.flush();
  },
  preparePortalMount() {},

  scheduleTimeout: (fn, delay) => setTimeout(fn, delay),
  cancelTimeout: (id) => clearTimeout(id),
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn) => queueMicrotask(() => void fn()),

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  detachDeletedInstance() {},

  // ---- mutation ----

  appendChild(parent, child) {
    child.parent = parent;
    insertChild(parent.children, child, null);
    child.container.attached(parent, child);
  },

  appendChildToContainer(container, child) {
    child.parent = null;
    insertChild(container.children, child, null);
    container.attached(null, child);
  },

  insertBefore(parent, child, before) {
    child.parent = parent;
    insertChild(parent.children, child, before as HostChild);
    child.container.attached(parent, child);
  },

  insertInContainerBefore(container, child, before) {
    child.parent = null;
    insertChild(container.children, child, before as HostChild);
    container.attached(null, child);
  },

  removeChild(parent, child) {
    const node = child as HostChild;
    removeFromList(parent.children, node);
    node.container.detached(parent, node);
    node.parent = null;
  },

  removeChildFromContainer(container, child) {
    removeFromList(container.children, child as HostChild);
    container.detached(null, child as HostChild);
  },

  resetTextContent() {},

  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.container.updateText(textInstance, newText);
  },

  commitUpdate(instance, _type, _oldProps, newProps) {
    instance.container.updateProps(instance, newProps);
  },

  hideInstance(instance) {
    instance.hidden = true;
    instance.container.touch(instance.parent);
  },

  hideTextInstance(textInstance) {
    textInstance.hidden = true;
    textInstance.container.touch(textInstance.parent);
  },

  unhideInstance(instance) {
    instance.hidden = false;
    instance.container.touch(instance.parent);
  },

  unhideTextInstance(textInstance, text) {
    textInstance.hidden = false;
    textInstance.container.updateText(textInstance, text);
    textInstance.container.touch(textInstance.parent);
  },

  clearContainer(container) {
    container.children.length = 0;
  },

  // ---- transitions, priorities, suspensey commits (not used by this renderer) ----

  NotPendingTransition: null,
  HostTransitionContext: createContext<null>(null) as unknown as Config['HostTransitionContext'],
  setCurrentUpdatePriority(priority) {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority as Reconciler.EventPriority,
  resolveUpdatePriority: () =>
    (currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority) as Reconciler.EventPriority,
  resetFormInstance() {},
  requestPostPaintCallback() {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance() {},
  suspendOnActiveViewTransition() {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
};

export const reconciler = Reconciler(hostConfig);

/** Runs `fn` with discrete (user input) priority, so the updates it schedules flush in a microtask. */
export function runWithDiscretePriority<T>(fn: () => T): T {
  const previous = currentUpdatePriority;
  currentUpdatePriority = DiscreteEventPriority;
  try {
    return fn();
  } finally {
    currentUpdatePriority = previous;
  }
}
