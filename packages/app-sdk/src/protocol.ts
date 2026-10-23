/**
 * Sandbox <-> host protocol, version 1 (contract §3 and §4).
 *
 * Types come from `@olan-app/schema` as type-only imports: a value import would pull zod (and
 * every schema the package builds at load time) into the worker bundle. The few runtime
 * constants the SDK needs are repeated here; `test/protocol.test.ts` keeps them equal.
 */
import type {
  AppContext,
  AppIdentity,
  AppUser,
  HandlerRef,
  HostMessage,
  HostPlatform,
  InitMessage,
  JsonValue,
  LogLevel,
  NodeId,
  PropValue,
  RpcError,
  RpcErrorCode,
  SandboxMessage,
  Surface,
  SurfaceParams,
  Theme,
  UiNode,
  UiPatch,
} from '@olan-app/schema';

export type {
  AppContext,
  AppIdentity,
  AppUser,
  HandlerRef,
  InitMessage,
  JsonValue,
  LogLevel,
  NodeId,
  PropValue,
  RpcError,
  RpcErrorCode,
  Surface,
  SurfaceParams,
  Theme,
  UiNode,
  UiPatch,
};
export type Platform = HostPlatform;
/** Messages the sandbox sends to the host. */
export type SandboxToHostMessage = SandboxMessage;
/** Messages the host sends to the sandbox. */
export type HostToSandboxMessage = HostMessage;

export const PROTOCOL_VERSION = 1;
export const SDK_VERSION = '1.8.1';

/** Surfaces in contract order (repeats `SURFACES` of @olan-app/schema; a test keeps them equal). */
export const SURFACE_NAMES: readonly Surface[] = Object.freeze([
  'app',
  'project.widget',
  'settings',
  'chat.action',
  'chat.command',
  'chat.card',
  'mail.sidebar',
  'mail.action',
  'calendar.event.action',
  'meeting.panel',
  'project.tab',
  'project.settings',
  'task.action',
  'issue.action',
  'record.card',
] as Surface[]);

/** Node type of text instances (`props: { text }`, no children). */
export const TEXT_NODE_TYPE = '#text';

export function isHandlerRef(value: unknown): value is HandlerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Number.isInteger((value as { $handler?: unknown }).$handler)
  );
}
