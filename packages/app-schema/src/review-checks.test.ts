import { describe, expect, it } from 'vitest';
import { validateManifest, type OlanAppManifest } from './manifest.js';
import { lintUiTree, reviewPermissions, runStaticReviewChecks, scanBundleUsage, sortFindings, type ReviewFinding } from './review-checks.js';
import type { UiNode } from './ui.js';
import { MAX_PACKAGE_BYTES } from './versions.js';

function manifest(overrides: Record<string, unknown> = {}): OlanAppManifest {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'com.example.review',
    name: 'Review',
    version: '1.0.0',
    sdk: '^1.0.0',
    entry: 'dist/app.js',
    surfaces: { app: { title: 'Review' } },
    permissions: ['projects:read'],
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.manifest;
}

/** Shaped like a minified production bundle: SDK API table + React feature detection + app code. */
const SDK_PRELUDE = [
  'var Sy={list(u={}){return B("projects.list",u)},tasks(u,i={}){return B("projects.tasks",{projectId:u,...i})}},',
  'gy={async fetch(u,c={}){let s=await B("http.fetch",{url:u,...c});return s}},',
  'Gn=Object.freeze({projects:Sy,http:gy});',
  'function Rp(n){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){if(!window.dispatchEvent(n))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",n);return}}',
  'var mc=typeof MessageChannel<"u"?new MessageChannel:null;mc&&mc.port2.postMessage(null);',
  'function wt(n){return n.__olanTransport?n.__olanTransport:{post:c=>n.postMessage(c),onMessage(c){n.addEventListener("message",c)}}}',
  'var Lx="https://react.dev/errors/";',
].join('');

function run(code: string, extra: { manifest?: OlanAppManifest; files?: Record<string, Uint8Array | string>; sizeBytes?: number } = {}) {
  return runStaticReviewChecks({ manifest: extra.manifest ?? manifest(), files: { 'olan-app.json': '{}', 'dist/app.js': code, ...(extra.files ?? {}) }, sizeBytes: extra.sizeBytes ?? 1000 });
}

const codes = (findings: ReviewFinding[], severity?: string) => findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);

describe('runStaticReviewChecks', () => {
  it('passes a clean bundle: SDK internals and React feature detection are not findings', () => {
    const result = run(`${SDK_PRELUDE}function App(){return Gn.projects.tasks("p0")}`);
    expect(codes(result.findings, 'error')).toEqual([]);
    expect(codes(result.findings, 'warning')).toEqual([]);
    expect(result.usage).toEqual({ rpcMethods: ['projects.tasks'], permissionsUsed: ['projects:read'], permissionsUnused: [], httpHosts: [] });
  });

  it('flags dynamic code, direct network, DOM and storage with their rules', () => {
    const result = run(
      `${SDK_PRELUDE};function a(){eval("1")};var f=new Function("return 1");setTimeout("x()",5);import("./x.js");fetch("https://evil.example/x");document.body;localStorage.setItem("a","b");new XMLHttpRequest;new WebSocket("wss://x")`,
    );
    const errors = result.findings.filter((f) => f.severity === 'error');
    const byCode = Object.fromEntries(errors.map((f) => [f.code, f.rule]));
    expect(byCode).toMatchObject({
      'forbidden.eval': '1.2',
      'forbidden.function_constructor': '1.2',
      'forbidden.string_timer': '1.2',
      'forbidden.dynamic_import': '1.2',
      'forbidden.fetch': '1.4',
      'forbidden.dom': '1.4',
      'forbidden.browser_storage': '1.4',
      'forbidden.xhr': '1.4',
      'forbidden.websocket': '1.4',
    });
    const evalFinding = errors.find((f) => f.code === 'forbidden.eval')!;
    expect(evalFinding.path).toMatch(/^dist\/app\.js#1:\d+$/);
    expect(evalFinding.message).toContain('eval("1")');
  });

  it('does not mistake method definitions and member calls for globals', () => {
    const result = run(`${SDK_PRELUDE}var o={fetch(u){return u},async import(x){return x}};o.fetch(1);client.eval(2);function fetch2(){}`);
    expect(codes(result.findings, 'error')).toEqual([]);
  });

  it('warns about obfuscation and errors on mining', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `_0x${(0x1a2b + i).toString(16)}`).join(',');
    const result = run(`${SDK_PRELUDE}var ${ids};var s="${'\\x41'.repeat(16)}";var m="stratum+tcp://pool.example:3333"`);
    expect(codes(result.findings, 'warning')).toEqual(expect.arrayContaining(['obfuscation.hex_identifiers', 'obfuscation.escaped_strings']));
    expect(result.findings.find((f) => f.code === 'forbidden.crypto_mining')).toMatchObject({ severity: 'error', rule: '1.5' });
  });

  it('checks file types, native binaries and SVG content', () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const result = run(SDK_PRELUDE, {
      files: {
        'lib/native.so': elf,
        'assets/icon.png': elf,
        'page.html': '<html></html>',
        'dist/app.js.map': '{}',
        'LICENSE': 'MIT License',
        'NOTICE.md': 'notices',
        'assets/logo.svg': '<svg onload="alert(1)"></svg>',
      },
    });
    const files = result.findings.filter((f) => f.check === 'files');
    expect(files.map((f) => [f.code, f.path, f.severity])).toEqual([
      ['files.native_binary', 'assets/icon.png', 'error'],
      ['files.native_binary', 'lib/native.so', 'error'],
      ['files.svg_active_content', 'assets/logo.svg', 'error'],
      ['files.type_not_allowed', 'page.html', 'error'],
      ['files.source_map', 'dist/app.js.map', 'warning'],
    ]);
    expect(files.find((f) => f.path === 'lib/native.so')?.rule).toBe('1.3');
  });

  it('checks the package and entry sizes', () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const result = run(big, { sizeBytes: MAX_PACKAGE_BYTES + 1 });
    expect(codes(result.findings.filter((f) => f.check === 'size'))).toEqual(['size.package_too_large', 'size.entry_large', 'size.summary']);
  });

  it('compares requested permissions with what the bundle calls', () => {
    const m = manifest({ permissions: ['projects:read', 'storage', 'http:api.example.com'] });
    const result = run(`${SDK_PRELUDE}Gn.projects.list();Gn.db.collection("x").insert({});Gn.chat.messages("c")`, { manifest: m });
    const permissions = result.findings.filter((f) => f.check === 'permissions');
    expect(permissions.map((f) => [f.code, f.severity, f.rule])).toEqual([
      ['permissions.missing', 'error', '2.1'],
      ['permissions.missing', 'error', '2.1'],
      ['permissions.http_unused', 'warning', '2.1'],
      ['permissions.unused', 'warning', '2.1'],
    ]);
    expect(permissions[0]!.message).toContain('olan.chat.messages needs the "chat:read"');
    expect(permissions[1]!.message).toContain('olan.db needs the "db"');
    expect(result.usage.permissionsUnused).toEqual(['http:api.example.com', 'storage']);
  });

  it('treats http.fetch without hosts as an error and lists requested hosts for review', () => {
    expect(codes(run(`${SDK_PRELUDE}Gn.http.fetch("https://api.example.com/v1")`).findings, 'error')).toEqual(['permissions.http_missing']);
    const withHost = run(`${SDK_PRELUDE}Gn.http.fetch("https://api.example.com/v1")`, { manifest: manifest({ permissions: ['http:api.example.com', 'http:other.example.com'] }) });
    expect(codes(withHost.findings, 'error')).toEqual([]);
    const info = withHost.findings.find((f) => f.code === 'permissions.http_hosts')!;
    expect(info.message).toContain('api.example.com, other.example.com');
    expect(info.message).toContain('Not found in the bundle\'s URL literals: other.example.com');
    expect(withHost.usage.httpHosts).toEqual(['api.example.com']);
    // Run-time fetches to a host that is not granted.
    const runtime = reviewPermissions({ manifest: manifest({ permissions: ['http:api.example.com'] }), rpcMethods: ['http.fetch'], fetchedHosts: ['evil.example.com'] });
    expect(runtime.findings.find((f) => f.code === 'permissions.http_missing')?.message).toContain('evil.example.com');
  });

  it('finds licenses and asks for review of copyleft ones', () => {
    const result = run(`/*! lodash | MIT License */\n/** @license GPL-3.0-or-later */\n${SDK_PRELUDE}`);
    const licenses = result.findings.filter((f) => f.check === 'licenses');
    expect(licenses.find((f) => f.code === 'licenses.copyleft')).toMatchObject({ severity: 'warning', rule: '6.2' });
    expect(licenses.find((f) => f.code === 'licenses.found')?.message).toMatch(/GPL .*MIT/);
    expect(licenses.some((f) => f.code === 'licenses.notices_missing')).toBe(false);
    // React without any notice: informational.
    expect(codes(run(SDK_PRELUDE).findings)).toContain('licenses.notices_missing');
  });

  it('is deterministic', () => {
    const code = `${SDK_PRELUDE};eval("1");fetch("x");document.title`;
    expect(run(code)).toEqual(run(code));
    const findings = run(code).findings;
    expect(sortFindings([...findings].reverse())).toEqual(findings);
  });
});

describe('scanBundleUsage', () => {
  it('reads olan.* call chains and URL literals', () => {
    const usage = scanBundleUsage(`${SDK_PRELUDE}k.projects.tasks(a);k.ui.toast({});k.navigation.push;k.db.collection("x");k.http.fetch(\`https://\${h}/x\`);"http://Rates.Example.com:8080/v1"`);
    expect(usage.rpcMethods).toEqual(['db.*', 'http.fetch', 'navigation.push', 'projects.tasks', 'ui.toast']);
    expect(usage.urlHosts).toEqual(['rates.example.com:8080']);
  });

  it('reads backend code with the backend method names', () => {
    const code = 'var o={db:{collection(n){return q("db.query",{collection:n})}}};t.secrets.get("k");t.calendar.events({});t.db.collection("r").count({});t.ui.toast({});t.meetings.get("m")';
    expect(scanBundleUsage(code, { backend: true }).rpcMethods).toEqual(['calendar.events', 'db.*', 'meetings.get', 'secrets.get']);
    // The UI scan does not know backend-only names.
    expect(scanBundleUsage(code).rpcMethods).toEqual(['db.*', 'ui.toast']);
  });
  it('reads olan.project.<area>.<method> calls (Phase 6)', () => {
    const code = 'k.project.links.upsert(p,{});k.project . statuses . define(p,[]);k.project.config.get(p);k.project.unknown.thing(p);var o={links:{upsert(a){return q("project.links.upsert",a)}}}';
    expect(scanBundleUsage(code).rpcMethods).toEqual(['project.config.get', 'project.links.upsert', 'project.statuses.define']);
    expect(scanBundleUsage('t.project.approvals.request(p,{})', { backend: true }).rpcMethods).toEqual(['project.approvals.request']);
  });
});

describe('backend usage (dist/server.js)', () => {
  /** Shaped like examples/ops-inbox: the UI only calls its backend, which uses db, http and an event. */
  const opsManifest = () =>
    manifest({
      permissions: ['db', 'projects:read', 'http:ops.example.com'],
      data: { version: 1, collections: { records: { scope: 'organization', fields: { title: { type: 'string', required: true } }, rules: { read: 'any', update: 'owner', delete: 'owner' } } } },
      server: { entry: 'server/index.ts', events: { 'project.task.created': 'onTaskCreated' } },
    });
  const ui = `${SDK_PRELUDE}function App(){return Gn.backend.call("summary")}`;
  const backend = 'var __olanBackendModule=(()=>{var s={db:{collection(n){return h("db.insert",{collection:n})}}};const OPS="https://ops.example.com/digest";async function d(){await t.db.collection("records").count({});await t.http.fetch(OPS,{method:"POST"});await t.secrets.get("apiToken")}})();';

  it('counts permissions only the backend uses (no "unused" for db, projects:read, http:ops.example.com)', () => {
    const result = run(ui, { manifest: opsManifest(), files: { 'dist/server.js': backend } });
    expect(result.findings.filter((f) => f.check === 'permissions' && f.severity !== 'info')).toEqual([]);
    expect(result.usage).toEqual({
      rpcMethods: ['db.*', 'http.fetch', 'secrets.get'],
      permissionsUsed: ['db', 'http:ops.example.com', 'projects:read'],
      permissionsUnused: [],
      httpHosts: ['ops.example.com'],
    });
    expect(result.findings.find((f) => f.code === 'permissions.http_hosts')?.message).not.toContain('Not found');
    // Without the backend bundle the same manifest looks over-privileged (what 1.5.0 reported).
    const uiOnly = run(ui, { manifest: opsManifest() });
    expect(uiOnly.usage.permissionsUnused).toEqual(['db', 'http:ops.example.com']);
  });

  it('points findings about methods only the backend calls at dist/server.js', () => {
    const files = { 'dist/server.js': `${backend};t.calendar.events({});t.projects.createTask("p",{})` };
    const result = run(`${ui};Gn.projects.createTask("p",{})`, { manifest: opsManifest(), files });
    const missing = result.findings.filter((f) => f.code === 'permissions.missing');
    expect(missing.map((f) => [f.message.slice(0, 22), f.path])).toEqual([
      ['olan.projects.createTa', 'dist/app.js'],
      ['olan.calendar.events n', 'dist/server.js'],
    ]);
    const noHost = reviewPermissions({ manifest: manifest({ permissions: [] }), rpcMethods: [], server: { rpcMethods: ['http.fetch'], path: 'dist/server.js' } });
    expect(noHost.findings.find((f) => f.code === 'permissions.http_missing')?.path).toBe('dist/server.js');
  });

  it('ignores dist/server.js when the manifest declares no server', () => {
    const result = run(ui, { manifest: manifest({ permissions: ['db'] }), files: { 'dist/server.js': backend } });
    expect(result.usage.permissionsUnused).toEqual(['db']);
  });

  it('counts event subscriptions and assistant tools as uses', () => {
    const remote = manifest({
      permissions: ['chat:read', 'projects:read', 'tasks:write', 'storage'],
      remote: { url: 'https://app.example.com/olan', jwksUrl: 'https://app.example.com/jwks.json' },
      events: ['chat.message.created'],
      ai: { tools: [{ name: 'add_task', title: 'Görev ekle', description: 'Adds a task.', input: { type: 'object' }, permissions: ['projects:read', 'tasks:write'] }] },
    });
    expect(run(SDK_PRELUDE, { manifest: remote }).usage).toMatchObject({ permissionsUsed: ['chat:read', 'projects:read', 'tasks:write'], permissionsUnused: ['storage'] });
  });

  it('counts chat:write as used when an app server posts the cards of its chat.card surface', () => {
    // Shaped like Markanera's İçerik: the server posts approval cards with its installation token; the bundle never calls chat.postCard.
    const cards = (overrides: Record<string, unknown> = {}) => manifest({
      permissions: ['chat:read', 'chat:write'],
      surfaces: { app: { title: 'İçerik' }, 'chat.card': { title: 'Gönderi onayı' } },
      remote: { url: 'https://app.example.com/olan', jwksUrl: 'https://app.example.com/olan/jwks.json', requests: true },
      ...overrides,
    });
    const used = run(`${SDK_PRELUDE}function App(){return Gn.chat.conversations()}`, { manifest: cards() });
    expect(used.findings.filter((f) => f.code === 'permissions.unused')).toEqual([]);
    expect(used.usage).toMatchObject({ permissionsUsed: ['chat:read', 'chat:write'], permissionsUnused: [] });
    // Without an app server, or without the card surface, nothing posts cards that the bundle does not show.
    const noRemote = run(`${SDK_PRELUDE}function App(){return Gn.chat.conversations()}`, { manifest: cards({ remote: undefined }) });
    expect(noRemote.usage.permissionsUnused).toEqual(['chat:write']);
    const noCard = run(`${SDK_PRELUDE}function App(){return Gn.chat.conversations()}`, { manifest: cards({ surfaces: { app: { title: 'İçerik' } } }) });
    expect(noCard.usage.permissionsUnused).toEqual(['chat:write']);
  });
});

describe('lintUiTree', () => {
  const node = (id: number, type: string, props: Record<string, unknown>, children: number[] = []): UiNode => ({ id, type, props: props as UiNode['props'], children });

  it('reports unlabelled controls, missing alt text and keys', () => {
    const findings = lintUiTree(
      [
        node(1, 'Screen', { title: 'Home', actions: [{ key: 'a', label: '', onPress: { $handler: 1 } }] }, [2, 3, 4, 5, 6, 7]),
        node(2, 'Button', { label: ' ', onPress: { $handler: 2 } }),
        node(3, 'TextField', { name: 'title', label: '' }),
        node(4, 'Menu', { icon: 'more', items: [{ key: 1, label: 'Sil' }], onSelect: { $handler: 3 } }),
        node(5, 'Image', { src: 'assets/a.png' }),
        node(6, 'List', { items: [{ key: 'x', title: 'A' }, { key: 'x', title: 'B' }, { title: 'C' }] }),
        node(7, 'Button', { label: 'Kaydet', onPress: { $handler: 4 } }),
      ],
      'app',
    );
    expect(findings.map((f) => [f.code, f.severity, f.rule ?? null])).toEqual([
      ['a11y.action_label_missing', 'error', '4.1'],
      ['a11y.button_label_missing', 'error', '4.1'],
      ['a11y.field_label_missing', 'error', '4.1'],
      ['a11y.menu_label_missing', 'warning', '4.1'],
      ['a11y.image_alt_missing', 'warning', '4.2'],
      ['a11y.list_key_missing', 'warning', null],
      ['a11y.duplicate_key', 'warning', null],
    ]);
    expect(findings[1]!.message).toContain('Screen "Home" > Button');
    expect(findings.every((f) => f.path === 'app' && f.check === 'accessibility')).toBe(true);
  });

  it('reports a Tabs item without a label and an empty Tabs label, not a missing one', () => {
    const items = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
    const codes = (props: Record<string, unknown>) => lintUiTree([node(1, 'Tabs', { value: 'a', onChange: { $handler: 1 }, ...props })]).map((f) => f.code);
    expect(codes({ items })).toEqual([]);
    expect(codes({ items, label: 'İçerik bölümleri' })).toEqual([]);
    expect(codes({ items, label: ' ' })).toEqual(['a11y.tab_label_missing']);
    expect(codes({ items: [...items, { key: 'c', label: '' }] })).toEqual(['a11y.tab_label_missing']);
  });

  it('accepts a labelled tree', () => {
    expect(lintUiTree([node(1, 'Screen', { title: 'A' }, [2]), node(2, 'Button', { label: 'Tamam', onPress: { $handler: 1 } })])).toEqual([]);
  });
});
