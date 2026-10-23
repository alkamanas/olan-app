/**
 * Minimal semver helpers. Only what manifests need: version validation,
 * comparison and a small range grammar (`*`, `x.y.z`, `^x.y.z`, `~x.y.z` and
 * whitespace-separated comparator sets such as `>=1.0.0 <2.0.0`).
 */
/** Strict semver 2.0.0 pattern (usable as a JSON Schema `pattern`). */
export declare const SEMVER_PATTERN: RegExp;
export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}
export declare function parseSemver(version: string): ParsedSemver | null;
export declare function isSemver(version: unknown): version is string;
/** Compares two versions by semver precedence. Returns -1, 0 or 1. Throws on invalid input. */
export declare function compareSemver(a: string, b: string): -1 | 0 | 1;
/** True for `*`, `x.y.z`, `^x.y.z`, `~x.y.z` and comparator sets like `>=1.0.0 <2.0.0`. */
export declare function isSemverRange(range: unknown): range is string;
/** Whether `version` satisfies `range`. Pre-release versions are compared by plain precedence. */
export declare function satisfiesSemverRange(version: string, range: string): boolean;
