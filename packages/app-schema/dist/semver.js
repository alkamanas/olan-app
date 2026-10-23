/**
 * Minimal semver helpers. Only what manifests need: version validation,
 * comparison and a small range grammar (`*`, `x.y.z`, `^x.y.z`, `~x.y.z` and
 * whitespace-separated comparator sets such as `>=1.0.0 <2.0.0`).
 */
const NUMERIC = '0|[1-9]\\d*';
const PRERELEASE_ID = `(?:${NUMERIC}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_ID = '[0-9A-Za-z-]+';
const VERSION_BODY = `(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))?` +
    `(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?`;
/** Strict semver 2.0.0 pattern (usable as a JSON Schema `pattern`). */
export const SEMVER_PATTERN = new RegExp(`^${VERSION_BODY}$`);
const VERSION_RE = new RegExp(`^${VERSION_BODY}$`);
const COMPARATOR_RE = new RegExp(`^(>=|<=|>|<|=|\\^|~)?${VERSION_BODY}$`);
export function parseSemver(version) {
    const match = VERSION_RE.exec(version);
    if (!match)
        return null;
    return toParsed(match, 1);
}
function toParsed(match, offset) {
    const major = Number(match[offset]);
    const minor = Number(match[offset + 1]);
    const patch = Number(match[offset + 2]);
    if (![major, minor, patch].every(Number.isSafeInteger))
        return null;
    const pre = match[offset + 3];
    return { major, minor, patch, prerelease: pre ? pre.split('.') : [] };
}
export function isSemver(version) {
    return typeof version === 'string' && parseSemver(version) !== null;
}
/** Compares two versions by semver precedence. Returns -1, 0 or 1. Throws on invalid input. */
export function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right)
        throw new TypeError(`Invalid semver: ${!left ? a : b}`);
    return compareParsed(left, right);
}
function compareParsed(a, b) {
    for (const key of ['major', 'minor', 'patch']) {
        if (a[key] !== b[key])
            return a[key] < b[key] ? -1 : 1;
    }
    if (a.prerelease.length === 0 && b.prerelease.length === 0)
        return 0;
    if (a.prerelease.length === 0)
        return 1;
    if (b.prerelease.length === 0)
        return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < length; i += 1) {
        const x = a.prerelease[i];
        const y = b.prerelease[i];
        if (x === undefined)
            return -1;
        if (y === undefined)
            return 1;
        if (x === y)
            continue;
        const xNum = /^\d+$/.test(x);
        const yNum = /^\d+$/.test(y);
        if (xNum && yNum)
            return Number(x) < Number(y) ? -1 : 1;
        if (xNum)
            return -1;
        if (yNum)
            return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}
/** Parses a range into comparators (all must hold). Returns null when the range is not supported. */
function parseRange(range) {
    const trimmed = range.trim();
    if (trimmed === '*')
        return [];
    if (trimmed === '')
        return null;
    const parts = trimmed.split(/\s+/);
    const comparators = [];
    for (const part of parts) {
        const match = COMPARATOR_RE.exec(part);
        if (!match)
            return null;
        const prefix = match[1] ?? '=';
        const version = toParsed(match, 2);
        if (!version)
            return null;
        if (prefix === '^' || prefix === '~') {
            // Caret and tilde only make sense as the whole range.
            if (parts.length !== 1)
                return null;
            const upper = prefix === '~'
                ? { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] }
                : version.major > 0
                    ? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
                    : version.minor > 0
                        ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
                        : { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
            comparators.push({ op: '>=', version }, { op: '<', version: upper });
        }
        else {
            comparators.push({ op: prefix, version });
        }
    }
    return comparators;
}
/** True for `*`, `x.y.z`, `^x.y.z`, `~x.y.z` and comparator sets like `>=1.0.0 <2.0.0`. */
export function isSemverRange(range) {
    return typeof range === 'string' && parseRange(range) !== null;
}
/** Whether `version` satisfies `range`. Pre-release versions are compared by plain precedence. */
export function satisfiesSemverRange(version, range) {
    const parsed = parseSemver(version);
    const comparators = parseRange(range);
    if (!parsed || !comparators)
        return false;
    return comparators.every(({ op, version: bound }) => {
        const cmp = compareParsed(parsed, bound);
        switch (op) {
            case '>=':
                return cmp >= 0;
            case '<=':
                return cmp <= 0;
            case '>':
                return cmp > 0;
            case '<':
                return cmp < 0;
            case '=':
                return cmp === 0;
        }
    });
}
