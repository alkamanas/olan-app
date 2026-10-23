import { backendHandlerResolves, backendTriggers, type ManifestServer } from '@olan-app/schema';

import { issue, type Issue } from '../errors';
import { createMockHost } from '../mock-server';
import { BACKEND_BUNDLE } from './build';
import { createBackendRunner, openBackendRuntime, type BackendEngine } from './runner';

/** Handler names a backend module defines (`defineBackend({ … })`). */
export interface BackendShape {
  functions: string[];
  schedules: string[];
  events: string[];
  hooks: string[];
  migrate: boolean;
}

/*
 * Appended to dist/server.js for inspection: replaces the module with one whose only function
 * reports the original definition's handler names. Nothing of the app runs except its top level.
 */
const INSPECT_SUFFIX = `
;(function () {
  var module = typeof __olanBackendModule === 'undefined' ? undefined : __olanBackendModule;
  var definition = module && module.default;
  var names = function (map) {
    if (!map || typeof map !== 'object') return [];
    return Object.keys(map).filter(function (key) { return typeof map[key] === 'function'; });
  };
  __olanBackendModule = { default: { $olanBackend: 1, functions: { __olanInspect: function () {
    if (!definition || typeof definition !== 'object' || definition.$olanBackend !== 1) return { valid: false };
    return { valid: true, functions: names(definition.functions), schedules: names(definition.schedules), events: names(definition.events), hooks: names(definition.hooks), migrate: typeof definition.migrate === 'function' };
  } } } };
})();
`;

/**
 * Loads `code` (a `dist/server.js`) in `@olan-app/runtime` and reads its handler names. Returns the
 * load problem (`bundle_error`, e.g. a top-level throw or a missing default export) as an issue.
 */
export async function inspectBackend(code: string, options: { engine?: BackendEngine; onWarning?: (message: string) => void } = {}): Promise<{ shape: BackendShape | null; issues: Issue[]; engine: string | null }> {
  const runtime = await openBackendRuntime(options.engine ?? 'auto', options.onWarning);
  try {
    const runner = createBackendRunner({ runtime, manifest: { id: 'com.olan.inspect' }, host: createMockHost(), code: `${code}${INSPECT_SUFFIX}`, installationId: 'inspect' });
    const outcome = await runner.invoke({ kind: 'function', name: '__olanInspect', payload: null, identity: { actor: 'app', userId: null, permissions: [] } });
    if (!outcome.ok) {
      return { shape: null, engine: runtime.engine, issues: [issue('validate.backend_load', `${BACKEND_BUNDLE} does not load in the backend runtime: ${outcome.error.message}`, { file: BACKEND_BUNDLE, hint: 'server.entry must `export default defineBackend({ … })` and must not use Node APIs at the top level.' })] };
    }
    const value = outcome.value as ({ valid: boolean } & Partial<BackendShape>) | null;
    if (!value?.valid) {
      return { shape: null, engine: runtime.engine, issues: [issue('validate.backend_default_export', `${BACKEND_BUNDLE} has no defineBackend(...) default export`, { file: BACKEND_BUNDLE, hint: 'In server.entry: `export default defineBackend({ functions: { … } })` from "@olan-app/sdk/backend".' })] };
    }
    return {
      engine: runtime.engine,
      issues: [],
      shape: { functions: value.functions ?? [], schedules: value.schedules ?? [], events: value.events ?? [], hooks: value.hooks ?? [], migrate: value.migrate === true },
    };
  } finally {
    await runtime.dispose();
  }
}

/** §15.1 handler resolution for every manifest schedule, event and hook (errors), plus unreachable handlers (warnings). */
export function backendHandlerIssues(server: ManifestServer, shape: BackendShape): { errors: Issue[]; warnings: Issue[] } {
  const fn = () => null;
  const asMap = (names: string[]) => Object.fromEntries(names.map((name) => [name, fn]));
  const definition = { functions: asMap(shape.functions), schedules: asMap(shape.schedules), events: asMap(shape.events), hooks: asMap(shape.hooks) };
  const errors: Issue[] = [];
  for (const trigger of backendTriggers(server)) {
    if (backendHandlerResolves(definition, trigger)) continue;
    const map = trigger.kind === 'schedule' ? 'schedules' : trigger.kind === 'event' ? 'events' : 'hooks';
    const key = JSON.stringify(trigger.name);
    errors.push(
      issue(
        'validate.backend_handler_missing',
        trigger.fallback
          ? `server.${map} "${trigger.name}" has no handler: defineBackend has neither ${map}[${key}] nor functions.${trigger.fallback}`
          : `server.${map} "${trigger.name}" has no handler: defineBackend has no ${map}[${key}]`,
        { file: 'olan-app.json', hint: `Add ${map}: { ${key}: async (…) => { … } } to defineBackend in ${server.entry}.` },
      ),
    );
  }
  const warnings: Issue[] = [];
  const declared = { schedules: new Set((server.schedules ?? []).map((entry) => entry.name)), events: new Set(Object.keys(server.events ?? {})), hooks: new Set((server.hooks ?? []).map((entry) => entry.name)) };
  for (const key of ['schedules', 'events', 'hooks'] as const) {
    for (const name of shape[key]) {
      if (declared[key].has(name)) continue;
      warnings.push(issue('validate.backend_handler_unused', `defineBackend ${key}[${JSON.stringify(name)}] is not declared in olan-app.json server.${key}, so Olan never runs it`, { file: 'olan-app.json' }));
    }
  }
  return { errors, warnings };
}
