/**
 * Package-internal paths: relative, forward slashes, no `.`/`..` segments,
 * no empty segments, no backslashes, no control characters, at most 512 chars.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what a package path must not contain
export const PACKAGE_PATH_PATTERN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/\\\u0000-\u001f:*?"<>|][^\\\u0000-\u001f:*?"<>|]*$/;
export function isPackagePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 512)
        return false;
    if (!PACKAGE_PATH_PATTERN.test(path))
        return false;
    return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
