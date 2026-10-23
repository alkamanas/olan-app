import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Plugin } from 'esbuild';

/**
 * The developer packages were published as `@olan-app/*` (npm organization `olan-app`). Apps written
 * before the rename import the earlier names (formerly `@olan/app-sdk`, `@olan/app-schema`); the
 * build keeps accepting them as aliases of the new names, subpaths included.
 */
export const LEGACY_PACKAGE_NAMES: Readonly<Record<string, string>> = {
  '@olan/app-sdk': '@olan-app/sdk',
  '@olan/app-schema': '@olan-app/schema',
};

/** Matches `@olan-app/sdk`, `@olan-app/schema` and their legacy names, with or without a subpath. */
const ALIASED = /^(@olan-app\/(?:sdk|schema)|@olan\/app-(?:sdk|schema))(\/.*)?$/;
/** `@olan-app/sdk` or its legacy name `@olan/app-sdk` (no subpath). */
export const SDK_ROOT = /^@olan(?:-app\/sdk|\/app-sdk)$/;
/** `@olan-app/cli` or its legacy name `@olan/app-cli`, with or without a subpath. */
export const CLI_PACKAGE = /^@olan(?:-app\/cli|\/app-cli)(\/.*)?$/;
/** `@olan-app/cli/testing` or `@olan/app-cli/testing`. */
export const CLI_TESTING = /^@olan(?:-app\/cli|\/app-cli)\/testing$/;

/** The new name of a package (`@olan/app-sdk` → `@olan-app/sdk`); other names unchanged. */
export function canonicalPackageName(name: string): string {
  return LEGACY_PACKAGE_NAMES[name] ?? name;
}

function legacyName(name: string): string | undefined {
  return Object.keys(LEGACY_PACKAGE_NAMES).find((legacy) => LEGACY_PACKAGE_NAMES[legacy] === name);
}

function installedName(dir: string | null): string | null {
  if (!dir) return null;
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves `@olan-app/sdk|schema[/…]` and the legacy `@olan/app-sdk|schema[/…]` to whichever of
 * the two names is installed. SDK imports prefer the SDK package the CLI picked (`sdkDir`), so an
 * app that mixes both names still bundles one SDK copy.
 */
export function packageAliasPlugin(sdkDir: string | null): Plugin {
  const sdkName = installedName(sdkDir);
  return {
    name: 'olan-package-aliases',
    setup(build) {
      build.onResolve({ filter: ALIASED }, async (args) => {
        if (args.pluginData?.olanAlias) return undefined;
        const match = ALIASED.exec(args.path);
        if (!match) return undefined;
        const requested = match[1];
        const subpath = match[2] ?? '';
        const canonical = canonicalPackageName(requested);
        const names = [canonical === '@olan-app/sdk' ? sdkName : null, requested, canonical, legacyName(canonical)].filter(
          (name, index, all): name is string => !!name && all.indexOf(name) === index,
        );
        const dirs = [args.resolveDir, sdkDir].filter((dir, index, all): dir is string => !!dir && all.indexOf(dir) === index);
        for (const name of names) {
          for (const resolveDir of dirs) {
            const result = await build.resolve(`${name}${subpath}`, { kind: args.kind, importer: args.importer, resolveDir, pluginData: { olanAlias: true } });
            if (result.errors.length === 0) return { path: result.path, external: result.external, sideEffects: result.sideEffects, namespace: result.namespace };
          }
        }
        return undefined;
      });
    },
  };
}
