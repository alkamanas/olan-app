import type { ComponentType } from 'react';

import { SURFACE_NAMES, type JsonValue, type Surface } from './protocol';

/** Props every surface component receives. */
export interface SurfaceProps {
  /**
   * What the host passed when it opened the surface (the project surfaces get `{ projectId }`; see
   * `useSurfaceParams<S>()` for the typed shape of each surface). Panels get new params in place.
   */
  params: JsonValue;
}

export type SurfaceComponent = ComponentType<SurfaceProps>;

export type AppSurfaces = Partial<Record<Surface, SurfaceComponent>>;

/** The value an app module exports by default; the runtime picks `surfaces[init.surface]`. */
export interface AppDefinition {
  readonly $olanApp: 1;
  readonly surfaces: Readonly<AppSurfaces>;
}

/**
 * Declares an app's surfaces:
 *
 * ```tsx
 * export default defineApp({
 *   app: () => <Screen title="Projeler">…</Screen>,
 *   'project.widget': ({ params }) => <Card title="Gecikenler">…</Card>,
 * });
 * ```
 */
export function defineApp(surfaces: AppSurfaces): AppDefinition {
  for (const name of Object.keys(surfaces)) {
    if (!(SURFACE_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown surface "${name}"; Olan Apps surfaces are ${SURFACE_NAMES.join(', ')}`);
    }
    if (typeof surfaces[name as Surface] !== 'function') throw new Error(`Surface "${name}" must be a component`);
  }
  return Object.freeze({ $olanApp: 1 as const, surfaces: Object.freeze({ ...surfaces }) });
}

export function isAppDefinition(value: unknown): value is AppDefinition {
  return typeof value === 'object' && value !== null && (value as { $olanApp?: unknown }).$olanApp === 1;
}
