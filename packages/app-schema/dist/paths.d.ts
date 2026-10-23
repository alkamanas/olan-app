/**
 * Package-internal paths: relative, forward slashes, no `.`/`..` segments,
 * no empty segments, no backslashes, no control characters, at most 512 chars.
 */
export declare const PACKAGE_PATH_PATTERN: RegExp;
export declare function isPackagePath(path: unknown): path is string;
