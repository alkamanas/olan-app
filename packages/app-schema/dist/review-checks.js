import { BACKEND_HOST_METHODS, SERVER_BUNDLE_PATH } from './backend.js';
import { eventPermission } from './events.js';
import { COMPONENT_TYPES } from './ui.js';
import { isImpliedPermission, parsePermission } from './permissions.js';
import { RPC_METHODS, permissionsForMethod, REQUIRED_PERMISSION } from './rpc.js';
import { MAX_PACKAGE_BYTES } from './versions.js';
/** Report order of the checks. */
export const REVIEW_CHECK_IDS = Object.freeze([
    'manifest',
    'size',
    'files',
    'permissions',
    'forbidden-apis',
    'surfaces',
    'interaction',
    'accessibility',
    'licenses',
]);
/** Entry bundles above this size get a `size.entry_large` warning (2 MiB). */
export const ENTRY_BUNDLE_WARN_BYTES = 2 * 1024 * 1024;
/** File types a package may contain (plus extensionless `LICENSE*`, `NOTICE*`, `COPYING*`). */
export const ALLOWED_PACKAGE_EXTENSIONS = Object.freeze(['.js', '.json', '.png', '.svg', '.jpg', '.jpeg', '.webp', '.txt', '.md']);
/** Native code and bytecode: never allowed (rule 1.3). */
export const NATIVE_BINARY_EXTENSIONS = Object.freeze([
    '.so', '.dex', '.jar', '.wasm', '.hbc', '.node', '.exe', '.dylib', '.dll', '.class', '.apk', '.aab', '.ipa', '.o', '.a', '.elf', '.bin', '.msi', '.bat', '.cmd', '.sh', '.ps1',
]);
const META_FILES = new Set(['digest.json', 'signature.json']);
const LEGAL_FILE = /^(?:LICEN[CS]E|NOTICE|COPYING|AUTHORS|THIRD[-_]PARTY[-_]NOTICES?)(?:[-_.][\w.-]*)?$/i;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
function asText(data) {
    return typeof data === 'string' ? data : decoder.decode(data);
}
function asBytes(data) {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}
function byteLength(data) {
    return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
}
function extension(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
function baseName(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}
function kib(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}
/** `line:column` (1-based) of a character offset. */
function position(text, offset) {
    let line = 1;
    let lineStart = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
        line++;
        lineStart = i + 1;
    }
    return `${line}:${offset - lineStart + 1}`;
}
function snippet(text, offset, length) {
    const raw = text.slice(Math.max(0, offset - 24), Math.min(text.length, offset + length + 24));
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 96);
}
function sortUnique(values) {
    return [...new Set(values)].sort();
}
/** Sorts findings deterministically: check order, severity, code, path, message. */
export function sortFindings(findings) {
    const checkIndex = (id) => {
        const index = REVIEW_CHECK_IDS.indexOf(id);
        return index === -1 ? REVIEW_CHECK_IDS.length : index;
    };
    const cmp = (a, b) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);
    return [...findings].sort((a, b) => checkIndex(a.check) - checkIndex(b.check) ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        cmp(a.code, b.code) ||
        cmp(a.path, b.path) ||
        cmp(a.message, b.message));
}
/** Drops findings with the same check, code, severity, path and message. */
export function dedupeFindings(findings) {
    const seen = new Set();
    return findings.filter((finding) => {
        const key = JSON.stringify([finding.check, finding.code, finding.severity, finding.path ?? '', finding.message]);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function finding(check, code, severity, message, extra = {}) {
    return {
        check,
        code,
        severity,
        message,
        ...(extra.path !== undefined ? { path: extra.path } : {}),
        ...(extra.hint !== undefined ? { hint: extra.hint } : {}),
        ...(extra.rule !== undefined ? { rule: extra.rule } : {}),
    };
}
/**
 * Whether the `name(` at `openParen` starts a definition (`fetch(url) {` method shorthand or
 * `function fetch(…) {`) rather than a call: the matching `)` is followed by `{`.
 */
function isDefinitionAt(text, openParen) {
    let depth = 0;
    let quote = null;
    const limit = Math.min(text.length, openParen + 4000);
    for (let i = openParen; i < limit; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\')
                i++;
            else if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`')
            quote = ch;
        else if (ch === '(')
            depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) {
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j]))
                    j++;
                return text[j] === '{';
            }
        }
    }
    return false;
}
// ---------------------------------------------------------------------------
// size
// ---------------------------------------------------------------------------
function sizeChecks(input, entry) {
    const out = [];
    const total = Object.entries(input.files)
        .filter(([path]) => !META_FILES.has(path))
        .reduce((sum, [, data]) => sum + byteLength(data), 0);
    const entryData = entry ? input.files[entry] : undefined;
    const entryBytes = entryData === undefined ? 0 : byteLength(entryData);
    if (input.sizeBytes !== undefined && input.sizeBytes > MAX_PACKAGE_BYTES) {
        out.push(finding('size', 'size.package_too_large', 'error', `The package is ${kib(input.sizeBytes)}; the limit is ${kib(MAX_PACKAGE_BYTES)}.`, { hint: 'Remove unused assets and dependencies.' }));
    }
    if (entry && entryBytes > ENTRY_BUNDLE_WARN_BYTES) {
        out.push(finding('size', 'size.entry_large', 'warning', `The entry bundle is ${kib(entryBytes)} (over ${kib(ENTRY_BUNDLE_WARN_BYTES)}); it loads slowly on mobile.`, {
            path: entry,
            hint: 'Drop large dependencies; the SDK components replace UI libraries.',
        }));
    }
    const parts = [input.sizeBytes !== undefined ? `package ${kib(input.sizeBytes)}` : null, `files ${kib(total)} uncompressed`, entry ? `entry ${kib(entryBytes)}` : null].filter(Boolean);
    out.push(finding('size', 'size.summary', 'info', `Size: ${parts.join(', ')}.`));
    return out;
}
// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
function startsWith(bytes, signature, at = 0) {
    if (bytes.byteLength < at + signature.length)
        return false;
    return signature.every((value, index) => bytes[at + index] === value);
}
/** Name of the native format the bytes start with, or null. */
function nativeFormat(bytes) {
    if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]))
        return 'ELF';
    if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]))
        return 'Mach-O';
    if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]))
        return 'Mach-O universal or Java class';
    if (startsWith(bytes, [0x4d, 0x5a]) && bytes.byteLength >= 0x40) {
        const offset = (bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16)) >>> 0;
        if (startsWith(bytes, [0x50, 0x45, 0x00, 0x00], offset))
            return 'Windows PE';
    }
    if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d]))
        return 'WebAssembly';
    if (startsWith(bytes, [0x64, 0x65, 0x78, 0x0a]))
        return 'Android DEX';
    if (startsWith(bytes, [0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]))
        return 'Hermes bytecode';
    return null;
}
function fileChecks(input, entry) {
    const out = [];
    const paths = Object.keys(input.files).sort();
    if (entry && !(entry in input.files)) {
        out.push(finding('files', 'files.entry_missing', 'error', `The manifest entry ${entry} is not in the package.`, { path: entry, hint: 'Build the app with `olan-app pack`.' }));
    }
    for (const path of paths) {
        if (META_FILES.has(path))
            continue;
        const data = input.files[path];
        const ext = extension(path);
        const name = baseName(path);
        const native = nativeFormat(asBytes(data));
        if (NATIVE_BINARY_EXTENSIONS.includes(ext) || native) {
            out.push(finding('files', 'files.native_binary', 'error', `${path} is native code or bytecode${native ? ` (${native})` : ''}; apps run only as JavaScript in the sandbox.`, {
                path,
                rule: '1.3',
                hint: 'Remove the file; native binaries, WebAssembly and bytecode are not allowed.',
            }));
            continue;
        }
        const allowed = ALLOWED_PACKAGE_EXTENSIONS.includes(ext) || (ext === '' && LEGAL_FILE.test(name));
        if (!allowed) {
            if (ext === '.map') {
                out.push(finding('files', 'files.source_map', 'warning', `${path} is a source map; the host never loads it.`, { path, hint: 'Leave source maps out of the package.' }));
            }
            else {
                out.push(finding('files', 'files.type_not_allowed', 'error', `${path}: the file type ${ext || '(no extension)'} is not allowed in a package.`, {
                    path,
                    rule: '1.3',
                    hint: `Allowed: ${ALLOWED_PACKAGE_EXTENSIONS.join(' ')} and LICENSE/NOTICE files.`,
                }));
            }
            continue;
        }
        if (ext === '.svg') {
            const text = asText(data);
            if (/<script\b|\bon[a-z]+\s*=|javascript:|<foreignObject\b/i.test(text)) {
                out.push(finding('files', 'files.svg_active_content', 'error', `${path} contains scripts, event handlers or embedded HTML.`, { path, rule: '1.4', hint: 'Export the SVG as plain shapes.' }));
            }
        }
    }
    return out;
}
const DYNAMIC_HINT = 'Apps may not generate or load code at run time; bundle everything with `olan-app build`.';
const NETWORK_HINT = 'Use olan.http.fetch with an `http:<host>` permission; the sandbox has no network of its own.';
const DOM_HINT = 'Apps have no DOM, browser storage or browser APIs; use SDK components and olan.storage / olan.db.';
/*
 * Calibrated against production bundles of the examples (`olan-app pack`): React and the SDK
 * runtime use `typeof window`, `window.dispatchEvent`, `process.emit`, `MessageChannel`,
 * `x.postMessage(…)`, `addEventListener` and `Reflect.construct`; none of those match here.
 */
const API_PATTERNS = [
    // 1.2 dynamic code
    { code: 'forbidden.eval', pattern: /(?<![\w$.])eval\s*\(/g, severity: 'error', rule: '1.2', what: 'eval()', hint: DYNAMIC_HINT, call: true },
    { code: 'forbidden.eval', pattern: /\(\s*0\s*,\s*eval\s*\)|(?<![\w$.])eval\s*\)\s*\(|\[\s*["'`]eval["'`]\s*\]/g, severity: 'error', rule: '1.2', what: 'indirect eval', hint: DYNAMIC_HINT },
    { code: 'forbidden.function_constructor', pattern: /\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*["'`]|\.constructor\s*\(\s*["'`]/g, severity: 'error', rule: '1.2', what: 'the Function constructor', hint: DYNAMIC_HINT },
    { code: 'forbidden.string_timer', pattern: /(?<![\w$.])set(?:Timeout|Interval)\s*\(\s*["'`]/g, severity: 'error', rule: '1.2', what: 'setTimeout/setInterval with a string', hint: DYNAMIC_HINT },
    { code: 'forbidden.dynamic_import', pattern: /(?<![\w$.])import\s*\(/g, severity: 'error', rule: '1.2', what: 'dynamic import()', hint: DYNAMIC_HINT, call: true },
    { code: 'forbidden.import_scripts', pattern: /(?<![\w$.])importScripts\s*\(/g, severity: 'error', rule: '1.2', what: 'importScripts()', hint: DYNAMIC_HINT, call: true },
    { code: 'forbidden.webassembly', pattern: /\bWebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|compileStreaming|Module|Instance)\b/g, severity: 'error', rule: '1.2', what: 'WebAssembly', hint: DYNAMIC_HINT },
    // 1.4 only olan.* APIs
    { code: 'forbidden.fetch', pattern: /(?<![\w$.])fetch\s*\(/g, severity: 'error', rule: '1.4', what: 'the global fetch()', hint: NETWORK_HINT, call: true },
    { code: 'forbidden.fetch', pattern: /\b(?:globalThis|self|window)\s*\.\s*fetch\b|\[\s*["'`]fetch["'`]\s*\]/g, severity: 'error', rule: '1.4', what: 'the global fetch()', hint: NETWORK_HINT },
    { code: 'forbidden.xhr', pattern: /\bXMLHttpRequest\b/g, severity: 'error', rule: '1.4', what: 'XMLHttpRequest', hint: NETWORK_HINT },
    { code: 'forbidden.websocket', pattern: /\bWebSocket\b|\bEventSource\b|\bRTCPeerConnection\b|\bWebTransport\b/g, severity: 'error', rule: '1.4', what: 'WebSocket/EventSource/WebRTC', hint: NETWORK_HINT },
    { code: 'forbidden.beacon', pattern: /\bsendBeacon\s*\(/g, severity: 'error', rule: '1.4', what: 'navigator.sendBeacon()', hint: NETWORK_HINT },
    { code: 'forbidden.dom', pattern: /(?<![\w$.])document\s*\.\s*[A-Za-z_$]|\bwindow\s*\.\s*(?:document|location|open|parent|top|opener|frames|alert|confirm|prompt)\b/g, severity: 'error', rule: '1.4', what: 'the DOM (document/window)', hint: DOM_HINT },
    { code: 'forbidden.browser_storage', pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b|(?<![\w$.])caches\s*\.\s*open\b/g, severity: 'error', rule: '1.4', what: 'browser storage', hint: DOM_HINT },
    { code: 'forbidden.workers', pattern: /\bnew\s+(?:Shared)?Worker\s*\(|\bserviceWorker\b/g, severity: 'error', rule: '1.4', what: 'Workers', hint: DOM_HINT },
    { code: 'forbidden.navigator', pattern: /(?<![\w$.])navigator\s*\.\s*[A-Za-z_$]/g, severity: 'warning', rule: '1.4', what: 'navigator', hint: DOM_HINT },
    { code: 'forbidden.location', pattern: /(?<![\w$.])location\s*\.\s*(?:href|assign|replace|reload)\b/g, severity: 'warning', rule: '1.4', what: 'location', hint: 'Use olan.navigation for screens and ui.share for links.' },
    { code: 'forbidden.post_message', pattern: /\b(?:self|globalThis|parent|top)\s*\.\s*postMessage\s*\(/g, severity: 'warning', rule: '1.4', what: 'postMessage on the worker scope', hint: 'Talk to the host only through the SDK.' },
    { code: 'forbidden.require', pattern: /(?<![\w$.])require\s*\(\s*["'`]/g, severity: 'warning', rule: '1.4', what: 'require()', hint: 'The sandbox has no modules; bundle dependencies with `olan-app build`.' },
    // 1.5 crypto mining
    { code: 'forbidden.crypto_mining', pattern: /coinhive|coin-hive|cryptonight|stratum\+tcp|xmrig|webminer|minero\.cc|cryptoloot|coinimp|jsecoin/gi, severity: 'error', rule: '1.5', what: 'crypto mining code', hint: 'Mining is not allowed in Olan Apps.' },
    // 1.1 obfuscation heuristics (minification is fine)
    { code: 'obfuscation.hex_identifiers', pattern: /\b_0x[0-9a-f]{4,}\b/gi, severity: 'warning', rule: '1.1', what: 'obfuscator-style _0x identifiers', hint: 'Upload readable (minified is fine) code; obfuscated apps are rejected.', minCount: 10 },
    { code: 'obfuscation.escaped_strings', pattern: /(?:\\x[0-9a-fA-F]{2}){12,}/g, severity: 'warning', rule: '1.1', what: 'long hex-escaped strings', hint: 'Upload readable (minified is fine) code; obfuscated apps are rejected.' },
    { code: 'obfuscation.char_codes', pattern: /fromCharCode\s*\(\s*(?:0x[0-9a-f]+|\d+)\s*(?:,\s*(?:0x[0-9a-f]+|\d+)\s*){7,}\)/gi, severity: 'warning', rule: '1.1', what: 'strings built from character codes', hint: 'Upload readable (minified is fine) code; obfuscated apps are rejected.' },
    { code: 'obfuscation.encoded_blob', pattern: /["'`][A-Za-z0-9+/]{4096,}={0,2}["'`]/g, severity: 'warning', rule: '1.1', what: 'a large encoded blob', hint: 'Ship assets as files; reviewers cannot inspect encoded payloads.' },
    { code: 'obfuscation.debugger', pattern: /(?<![\w$.])debugger\b/g, severity: 'warning', rule: '1.1', what: 'debugger statements', hint: 'Remove debugger statements (anti-debugging is treated as obfuscation).' },
];
function forbiddenApiChecks(path, text) {
    const found = new Map();
    for (const pattern of API_PATTERNS) {
        pattern.pattern.lastIndex = 0;
        let count = 0;
        let first = -1;
        let length = 0;
        for (let match = pattern.pattern.exec(text); match; match = pattern.pattern.exec(text)) {
            if (match[0].length === 0)
                pattern.pattern.lastIndex++;
            if (pattern.call && isDefinitionAt(text, match.index + match[0].length - 1))
                continue;
            if (pattern.call && /\bfunction\s*\*?\s*$/.test(text.slice(Math.max(0, match.index - 12), match.index)))
                continue;
            count++;
            if (first === -1) {
                first = match.index;
                length = match[0].length;
            }
            if (count > 10_000)
                break;
        }
        if (count === 0 || count < (pattern.minCount ?? 1))
            continue;
        const key = `${pattern.code}`;
        const previous = found.get(key);
        if (previous) {
            previous.count += count;
            if (first < previous.first) {
                previous.first = first;
                previous.length = length;
            }
        }
        else {
            found.set(key, { pattern, count, first, length });
        }
    }
    return [...found.values()].map(({ pattern, count, first, length }) => finding('forbidden-apis', pattern.code, pattern.severity, `${path} uses ${pattern.what} (${count} occurrence${count === 1 ? '' : 's'}; first: \`${snippet(text, first, length)}\`).`, { path: `${path}#${position(text, first)}`, rule: pattern.rule, hint: pattern.hint }));
}
// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------
const API_NAMESPACES = ['projects', 'users', 'chat', 'storage', 'db', 'settings', 'http', 'ui', 'navigation', 'files'];
const apiCallPattern = (namespaces) => new RegExp(`\\.(${namespaces.join('|')})\\s*\\.\\s*([A-Za-z_$][\\w$]*)(\\s*\\()?`, 'g');
const API_CALL = apiCallPattern(API_NAMESPACES);
/** Phase 6: `olan.project.<area>.<method>(` (`project.links.upsert`, `project.statuses.define`, …). */
const PROJECT_API_CALL = /\.project\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
/** Backend code (`@olan-app/sdk/backend`): `olan.<namespace>.<method>` names are `BACKEND_HOST_METHODS`. */
const BACKEND_API_CALL = apiCallPattern([...new Set(BACKEND_HOST_METHODS.map((method) => method.slice(0, method.indexOf('.'))))]);
/** Hosts in React's own error links, not requests of the app. */
const IGNORED_URL_HOSTS = new Set(['react.dev', 'reactjs.org', 'fb.me']);
/** Stand-in method for `olan.db.collection(…)` use (which `db.*` method runs is not visible statically). */
export const DB_ANY_METHOD = 'db.*';
/**
 * What a bundle calls, from property chains that survive minification (`x.projects.tasks(`,
 * `x.db.collection(`, `x.http.fetch(`). The SDK's own API table is written as object literals
 * (`{list(u){return rpc("projects.list",u)}}`), so it does not count as use. An app that
 * destructures the API (`const { projects } = olan`) is not seen; the run-time pass covers it.
 *
 * `{ backend: true }` scans backend code (`dist/server.js`): its `olan.*` methods are
 * `BACKEND_HOST_METHODS`, which carry the RPC names (and permissions) of the UI methods, plus
 * `secrets.get` (no permission).
 */
export function scanBundleUsage(code, options = {}) {
    const methods = new Set();
    const pattern = options.backend ? BACKEND_API_CALL : API_CALL;
    const known = options.backend ? BACKEND_HOST_METHODS : RPC_METHODS;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
        const [, namespace, name, paren] = match;
        if (namespace === 'db') {
            if (name === 'collection' && paren)
                methods.add(DB_ANY_METHOD);
            continue;
        }
        const method = `${namespace}.${name}`;
        if (known.includes(method))
            methods.add(method);
    }
    PROJECT_API_CALL.lastIndex = 0;
    for (let match = PROJECT_API_CALL.exec(code); match; match = PROJECT_API_CALL.exec(code)) {
        const method = `project.${match[1]}.${match[2]}`;
        if (known.includes(method))
            methods.add(method);
    }
    const hosts = new Set();
    const urlLiteral = /["'`]https?:\/\/([^/"'`\s?#\\]+)/gi;
    for (let match = urlLiteral.exec(code); match; match = urlLiteral.exec(code)) {
        const host = normalizeHost(match[1]);
        if (host && !IGNORED_URL_HOSTS.has(host.replace(/:\d+$/, '')))
            hosts.add(host);
    }
    return { rpcMethods: sortUnique(methods), urlHosts: sortUnique(hosts) };
}
/**
 * `scanBundleUsage` over a package's files: the entry bundle and, with a manifest `server`, the
 * backend bundle (backend methods map 1:1 to RPC names). Pass the result to `reviewPermissions`
 * (`rpcMethods`, `urlHosts`, `server`) so permissions only backend code needs are not "unused".
 */
export function scanPackageUsage(manifest, files) {
    const entry = manifest.entry;
    const entryUsage = scanBundleUsage(entry && files[entry] !== undefined ? asText(files[entry]) : '');
    const serverCode = manifest.server ? files[SERVER_BUNDLE_PATH] : undefined;
    return { ...entryUsage, server: serverCode === undefined ? null : { ...scanBundleUsage(asText(serverCode), { backend: true }), path: SERVER_BUNDLE_PATH } };
}
function normalizeHost(authority) {
    if (/[${}@]/.test(authority))
        return null;
    const lower = authority.toLowerCase();
    const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(lower);
    if (!match || !match[1].includes('.'))
        return match?.[1] === 'localhost' ? lower : null;
    return match[2] ? `${match[1]}:${match[2]}` : match[1];
}
/** `host` or `host:port` of an http(s) URL as `http:<host>` permissions name it, or null. */
export function urlPermissionHost(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return null;
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
    catch {
        return null;
    }
}
function permissionsFor(method) {
    if (method === DB_ANY_METHOD)
        return ['db'];
    return permissionsForMethod(method);
}
/**
 * Compares requested permissions with what the app uses: requested but unused → warning (2.1);
 * used but not requested → error (2.1); `olan.http.fetch` without any `http:<host>` or to a host
 * not granted → error (2.3); every requested host is listed for the reviewer (2.3). Backend code
 * (`input.server`) and declared uses (event subscriptions, assistant tools) count as use too.
 */
export function reviewPermissions(input) {
    const out = [];
    const requested = [...input.manifest.permissions];
    const serverMethods = new Set(input.server?.rpcMethods ?? []);
    const methods = sortUnique([...input.rpcMethods, ...serverMethods]);
    const used = new Set();
    const httpRequested = requested.filter((permission) => parsePermission(permission)?.kind === 'http');
    const usesHttp = methods.includes('http.fetch');
    const uiMethods = new Set(input.rpcMethods);
    // A method only the backend calls is reported at the backend bundle.
    const pathOf = (method) => (serverMethods.has(method) && !uiMethods.has(method) ? (input.server?.path ?? SERVER_BUNDLE_PATH) : input.path);
    // Declared uses: the backend's `server.events` and the app server's `events` need their event's
    // permission (manifest validation requires it), assistant tools run with theirs, and an app server
    // (`remote`) posts and updates the cards its `chat.card` surface draws with its installation token
    // (`chat.postCard` / `chat.updateCard` need `chat:write`), which no bundle shows.
    const postsCardsFromServer = Boolean(input.manifest.remote) && Object.hasOwn(input.manifest.surfaces ?? {}, 'chat.card');
    const declared = [
        ...[...(input.manifest.events ?? []), ...Object.keys(input.manifest.server?.events ?? {})].map(eventPermission),
        ...(input.manifest.ai?.tools ?? []).flatMap((tool) => tool.permissions ?? []),
        ...(postsCardsFromServer ? ['chat:write'] : []),
    ];
    for (const permission of declared)
        if (permission && requested.includes(permission))
            used.add(permission);
    for (const method of methods) {
        const path = pathOf(method);
        if (method === 'http.fetch')
            continue;
        if (method !== DB_ANY_METHOD && REQUIRED_PERMISSION[method] == null)
            continue;
        const options = permissionsFor(method);
        // Implied permissions (`remote.request` → `remote`) come from the manifest, never from `permissions`.
        if (options.every(isImpliedPermission))
            continue;
        const granted = options.filter((permission) => requested.includes(permission));
        if (granted.length > 0) {
            for (const permission of granted)
                used.add(permission);
        }
        else {
            const label = method === DB_ANY_METHOD ? 'olan.db' : `olan.${method}`;
            out.push(finding('permissions', 'permissions.missing', 'error', `${label} needs the "${options[0]}" permission, which olan-app.json does not request.`, {
                ...(path ? { path } : {}),
                rule: '2.1',
                hint: `Add "${options[0]}" to "permissions" in olan-app.json, or remove the call.`,
            }));
        }
    }
    if (input.manifest.data && !requested.includes('db')) {
        out.push(finding('permissions', 'permissions.missing', 'error', 'olan-app.json declares "data" (an app database) but not the "db" permission.', { path: 'olan-app.json#data', rule: '2.1', hint: 'Add "db" to "permissions" (or remove "data").' }));
    }
    // Network.
    const urlHosts = sortUnique([...(input.urlHosts ?? []), ...(input.server?.urlHosts ?? [])]);
    const fetched = sortUnique(input.fetchedHosts ?? []);
    const grantedHosts = new Set(httpRequested.map((permission) => parsePermission(permission).host));
    if (usesHttp && httpRequested.length === 0) {
        const path = pathOf('http.fetch');
        out.push(finding('permissions', 'permissions.http_missing', 'error', 'The app calls olan.http.fetch but requests no `http:<host>` permission, so every request is blocked.', {
            ...(path ? { path } : {}),
            rule: '2.3',
            hint: 'Add "http:<host>" for each host the app calls.',
        }));
    }
    for (const host of fetched) {
        if (!grantedHosts.has(host)) {
            out.push(finding('permissions', 'permissions.http_missing', 'error', `The app fetched https://${host} without the "http:${host}" permission.`, { path: 'olan-app.json#permissions', rule: '2.3', hint: `Add "http:${host}" to "permissions".` }));
        }
    }
    if (usesHttp || fetched.length > 0) {
        for (const permission of httpRequested)
            used.add(permission);
    }
    if (httpRequested.length > 0 && (usesHttp || fetched.length > 0)) {
        const hosts = [...grantedHosts].sort();
        const unreferenced = hosts.filter((host) => !urlHosts.includes(host) && !fetched.includes(host));
        out.push(finding('permissions', 'permissions.http_hosts', 'info', `The app may send requests to: ${hosts.join(', ')}.${unreferenced.length ? ` Not found in the bundle's URL literals: ${unreferenced.join(', ')} (the URL may be built at run time).` : ''}`, {
            path: 'olan-app.json#permissions',
            rule: '2.3',
            hint: 'The listing must explain why the app needs each host.',
        }));
    }
    const unused = [];
    for (const permission of requested) {
        if (used.has(permission))
            continue;
        const parsed = parsePermission(permission);
        if (!parsed)
            continue;
        if (parsed.kind === 'static') {
            // Permissions no olan.* method needs (e.g. settings:read) cannot be judged from calls.
            const unlocks = RPC_METHODS.some((method) => permissionsForMethod(method).includes(permission));
            if (!unlocks)
                continue;
            if (permission === 'db' && input.manifest.data && methods.includes(DB_ANY_METHOD))
                continue;
        }
        unused.push(permission);
        out.push(finding('permissions', parsed.kind === 'http' ? 'permissions.http_unused' : 'permissions.unused', 'warning', `"${permission}" is requested but nothing in the app uses it.`, {
            path: 'olan-app.json#permissions',
            rule: '2.1',
            hint: 'Request only the permissions the app needs; remove it from "permissions".',
        }));
    }
    return {
        findings: out,
        usage: {
            rpcMethods: methods,
            permissionsUsed: requested.filter((permission) => used.has(permission)).sort(),
            permissionsUnused: unused.sort(),
            httpHosts: sortUnique([...urlHosts, ...fetched]),
        },
    };
}
// ---------------------------------------------------------------------------
// licenses
// ---------------------------------------------------------------------------
const LICENSE_TEXTS = [
    [/GNU AFFERO GENERAL PUBLIC LICENSE|\bAGPL(?:-?[0-9.]+)?(?:-only|-or-later|\+)?\b/i, 'AGPL'],
    [/GNU (?:LESSER|LIBRARY) GENERAL PUBLIC LICENSE|\bLGPL(?:-?[0-9.]+)?(?:-only|-or-later|\+)?\b/i, 'LGPL'],
    [/GNU GENERAL PUBLIC LICENSE|(?<![AL])\bGPL(?:-?[0-9.]+)?(?:-only|-or-later|\+)?\b/i, 'GPL'],
    [/Server Side Public License|\bSSPL(?:-[0-9.]+)?\b/i, 'SSPL'],
    [/European Union Public Licen[cs]e|\bEUPL(?:-[0-9.]+)?\b/i, 'EUPL'],
    [/Mozilla Public License|\bMPL-?2\.0\b/i, 'MPL-2.0'],
    [/Apache License|\bApache-2\.0\b/i, 'Apache-2.0'],
    [/\bMIT\b|[Pp]ermission is hereby granted, free of charge/, 'MIT'],
    [/\bISC\b|[Pp]ermission to use, copy, modify, and\/or distribute this software/, 'ISC'],
    [/\bBSD\b|\bBSD-[0-9]-Clause\b|[Rr]edistribution and use in source and binary forms/, 'BSD'],
    [/\b0BSD\b|\bUnlicense\b|CC0-1\.0/i, 'Public domain (0BSD/Unlicense/CC0)'],
];
/** Licenses whose obligations reach the whole app (rule 6.2: manual review). */
export const COPYLEFT_LICENSES = Object.freeze(['AGPL', 'GPL', 'LGPL', 'SSPL', 'EUPL']);
function licensesIn(text) {
    const out = [];
    for (const [pattern, name] of LICENSE_TEXTS)
        if (pattern.test(text))
            out.push(name);
    return out;
}
const isNotice = (comment) => comment.startsWith('/*!') || /@license|@preserve|SPDX-License-Identifier|\bLicen[cs]ed? under\b|\bcopyright\b/i.test(comment);
/**
 * License notices in a JS file: `/*! … *\/` and `@license` comments, SPDX identifiers. The scan is
 * textual, so a `/*` inside a string (`accept: ["image/*"]`) starts a false "comment" that runs to
 * the next `*\/`, e.g. the end of esbuild's `legalComments: 'eof'` block: the text from the last
 * `/*` of such a match is checked as well.
 */
function licenseNotices(text) {
    const notices = [];
    const block = /\/\*[\s\S]*?\*\//g;
    for (let match = block.exec(text); match; match = block.exec(text)) {
        const comment = match[0];
        const inner = comment.lastIndexOf('/*');
        const tail = inner > 0 ? comment.slice(inner) : null;
        if (tail && isNotice(tail))
            notices.push(tail.slice(0, 4000));
        else if (isNotice(comment))
            notices.push(comment.slice(0, 4000));
        if (notices.length > 500)
            break;
    }
    const line = /\/\/[^\n]*(?:@license|SPDX-License-Identifier)[^\n]*/g;
    for (let match = line.exec(text); match; match = line.exec(text))
        notices.push(match[0]);
    return notices;
}
function licenseChecks(input, entry) {
    const out = [];
    const found = new Map();
    const note = (license, path) => {
        const set = found.get(license) ?? new Set();
        set.add(path);
        found.set(license, set);
    };
    let noticeCount = 0;
    let thirdParty = false;
    for (const path of Object.keys(input.files).sort()) {
        if (META_FILES.has(path))
            continue;
        const ext = extension(path);
        const name = baseName(path);
        if (LEGAL_FILE.test(name) && (ext === '' || ext === '.txt' || ext === '.md')) {
            const text = asText(input.files[path]).slice(0, 200_000);
            noticeCount++;
            const names = licensesIn(text);
            for (const license of names.length ? names : ['unrecognised'])
                note(license, path);
            continue;
        }
        if (ext !== '.js')
            continue;
        const text = asText(input.files[path]);
        if (path === entry && /react\.dev\/errors|react-reconciler|__SECRET_INTERNALS|ReactCurrentOwner/.test(text))
            thirdParty = true;
        for (const notice of licenseNotices(text)) {
            const spdx = /SPDX-License-Identifier:\s*([^\s*]+(?:\s+(?:OR|AND|WITH)\s+[^\s*]+)*)/.exec(notice)?.[1];
            const names = licensesIn(spdx ?? notice);
            if (names.length === 0)
                continue;
            noticeCount++;
            for (const license of names)
                note(license, path);
        }
    }
    for (const [license, paths] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const list = [...paths].sort();
        if (COPYLEFT_LICENSES.includes(license)) {
            out.push(finding('licenses', 'licenses.copyleft', 'warning', `${license} code or notice found in ${list.join(', ')}; copyleft terms may apply to the whole app.`, {
                path: list[0],
                rule: '6.2',
                hint: 'A reviewer checks copyleft licenses by hand; replace the dependency or document compliance.',
            }));
        }
    }
    if (found.size > 0) {
        const summary = [...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([license, paths]) => `${license} (${[...paths].sort().join(', ')})`);
        out.push(finding('licenses', 'licenses.found', 'info', `Licenses found: ${summary.join('; ')}.`, { rule: '6.1' }));
    }
    if (thirdParty && noticeCount === 0) {
        out.push(finding('licenses', 'licenses.notices_missing', 'info', 'The bundle includes third-party code (React, MIT) but the package carries no license notices.', {
            ...(entry ? { path: entry } : {}),
            rule: '6.1',
            hint: 'MIT and similar licenses require their notice in copies: build with olan-app 1.4 or later (it keeps license comments at the end of dist/app.js), or add a NOTICE or THIRD_PARTY_NOTICES file under assets/.',
        }));
    }
    return out;
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Every static check on a package's files: `size`, `files`, `forbidden-apis` (every .js file),
 * `permissions` (static usage of the entry bundle and of `dist/server.js`) and `licenses`. Sorted, deterministic.
 */
export function runStaticReviewChecks(input) {
    const entry = input.manifest.entry;
    const findings = [];
    findings.push(...sizeChecks(input, entry));
    findings.push(...fileChecks(input, entry));
    for (const path of Object.keys(input.files).sort()) {
        if (extension(path) !== '.js')
            continue;
        findings.push(...forbiddenApiChecks(path, asText(input.files[path])));
    }
    const usage = scanPackageUsage(input.manifest, input.files);
    const permissions = reviewPermissions({ manifest: input.manifest, rpcMethods: usage.rpcMethods, urlHosts: usage.urlHosts, server: usage.server, ...(entry ? { path: entry } : {}) });
    findings.push(...permissions.findings);
    findings.push(...licenseChecks(input, entry));
    return { findings: sortFindings(dedupeFindings(findings)), usage: permissions.usage };
}
// ---------------------------------------------------------------------------
// accessibility
// ---------------------------------------------------------------------------
/** Components whose `label` names an input for screen readers. */
const FIELD_COMPONENTS = new Set(['TextField', 'Select', 'DatePicker', 'Switch', 'MultiSelect']);
const KNOWN_TYPES = new Set(COMPONENT_TYPES);
function blank(value) {
    return typeof value !== 'string' || value.trim().length === 0;
}
function records(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item)) : [];
}
function duplicateKeys(list) {
    const seen = new Set();
    const dupes = [];
    for (const item of records(list)) {
        const key = item.key;
        if (typeof key !== 'string' && typeof key !== 'number')
            continue;
        const id = `${typeof key}:${key}`;
        if (seen.has(id) && !dupes.includes(key))
            dupes.push(key);
        seen.add(id);
    }
    return dupes;
}
/**
 * Accessibility lint of a rendered tree (mirrors `olan-app validate --strict`): unlabelled
 * Buttons, fields and actions → error (4.1); a Menu with only an icon → warning (4.1); an Image
 * without `alt` → warning (4.2); List items without a key and repeated keys → warning.
 * `where` (a surface) becomes the findings' `path`.
 */
export function lintUiTree(nodes, where) {
    const out = [];
    const table = new Map(nodes.map((node) => [node.id, node]));
    const parents = new Map();
    for (const node of nodes)
        for (const child of node.children ?? [])
            parents.set(child, node.id);
    const describe = (id) => {
        const parts = [];
        let current = id;
        while (current !== undefined && parts.length < 12) {
            const node = table.get(current);
            if (!node)
                break;
            const p = node.props ?? {};
            const label = typeof p.label === 'string' ? p.label : typeof p.title === 'string' ? p.title : typeof p.text === 'string' ? p.text : '';
            parts.unshift(label ? `${node.type} "${label.slice(0, 40)}"` : node.type);
            current = parents.get(current);
        }
        return parts.join(' > ');
    };
    const add = (code, severity, message, rule, hint) => out.push(finding('accessibility', code, severity, message, { ...(where ? { path: where } : {}), ...(rule ? { rule } : {}), hint }));
    for (const node of nodes) {
        const p = (node.props ?? {});
        const at = describe(node.id);
        if (node.type === 'Button' && blank(p.label)) {
            add('a11y.button_label_missing', 'error', `A Button has no label (${at}).`, '4.1', 'Give every Button a visible label; icons alone are not accessible.');
        }
        if (FIELD_COMPONENTS.has(node.type) && blank(p.label)) {
            add('a11y.field_label_missing', 'error', `A ${node.type} has no label (${at}).`, '4.1', 'Every input needs a visible label; a placeholder is not a label.');
        }
        if (node.type === 'Menu') {
            if (blank(p.label))
                add('a11y.menu_label_missing', 'warning', `A Menu has only an icon (${at}).`, '4.1', 'Add label="…": screen readers and tests find menus by label.');
            if (records(p.items).some((item) => blank(item.label)))
                add('a11y.menu_item_label_missing', 'error', `A Menu item has no label (${at}).`, '4.1', 'Every menu item needs a label.');
        }
        if ((node.type === 'Screen' || node.type === 'Card') && records(p.actions).some((action) => blank(action.label))) {
            add('a11y.action_label_missing', 'error', `A ${node.type} action has no label (${at}).`, '4.1', 'Actions are buttons; give each a label, even with an icon.');
        }
        if (node.type === 'EmptyState' && p.action && typeof p.action === 'object' && blank(p.action.label)) {
            add('a11y.action_label_missing', 'error', `An EmptyState action has no label (${at}).`, '4.1', 'Give the action a label.');
        }
        if (node.type === 'Tabs' && records(p.items).some((item) => blank(item.label))) {
            add('a11y.tab_label_missing', 'error', `A Tabs item has no label (${at}).`, '4.1', 'Every tab needs a visible label.');
        }
        if (node.type === 'Tabs' && p.label !== undefined && blank(p.label)) {
            add('a11y.tab_label_missing', 'error', `A Tabs has an empty label (${at}).`, '4.1', 'Name the tab group (label="İçerik bölümleri") or leave label out for the host default.');
        }
        if (node.type === 'Avatar' && blank(p.name)) {
            add('a11y.avatar_name_missing', 'error', `An Avatar has no name (${at}).`, '4.1', 'Give the Avatar the person\'s or brand\'s name: screen readers read it and it gives the initials.');
        }
        if (node.type === 'Banner' && p.action && typeof p.action === 'object' && blank(p.action.label)) {
            add('a11y.action_label_missing', 'error', `A Banner action has no label (${at}).`, '4.1', 'Give the action a label.');
        }
        if (node.type === 'Image' || (!KNOWN_TYPES.has(node.type) && typeof p.src === 'string')) {
            if (blank(p.alt))
                add('a11y.image_alt_missing', 'warning', `An image has no alt text (${at}).`, '4.2', 'Describe the image in `alt` (use alt="" only for decoration).');
        }
        if (node.type === 'List') {
            const missing = records(p.items).filter((item) => item.key === undefined || item.key === null || item.key === '').length;
            if (missing > 0)
                add('a11y.list_key_missing', 'warning', `${missing} List item(s) have no key (${at}).`, undefined, 'Every List item needs a unique `key` (string or number), e.g. the record id.');
        }
        for (const [prop, label] of [['items', 'List/Menu/Tabs item'], ['rows', 'Table row'], ['actions', 'action']]) {
            const dupes = duplicateKeys(p[prop]);
            if (dupes.length > 0)
                add('a11y.duplicate_key', 'warning', `${label} keys repeat: ${dupes.map(String).join(', ')} (${at}).`, undefined, 'Keys identify rows in events (`onSelect({ key })`); make them unique.');
        }
    }
    return out;
}
