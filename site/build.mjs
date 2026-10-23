#!/usr/bin/env node
/* global process, console */
// Builds the static site for https://docs.olan.app from the @olan-app/sdk documentation.
//
//   node site/build.mjs [--root <dir>] [--out <dir>]
//
// <root> is the public olan-app repository layout (default: the directory above this script):
//   <root>/docs/*.md                       the SDK docs (one page each)
//   <root>/packages/app-sdk/README.md      the landing page
//   <root>/packages/app-sdk/llms.txt       copied to /llms.txt
// Output (default <root>/site/dist): /index.html, /<page>/index.html, /404.html, /llms.txt,
// /sitemap.xml, /robots.txt and a fingerprinted stylesheet. No client-side JavaScript.
// The output depends only on the inputs (no dates or random values), so rebuilding is a no-op.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import MarkdownIt from 'markdown-it';

const SITE_URL = 'https://docs.olan.app';
const GITHUB_URL = 'https://github.com/alkamanas/olan-app';
const NPM_PACKAGES = [
  ['@olan-app/sdk', 'Components, hooks and olan.* APIs'],
  ['@olan-app/cli', 'olan-app: init, build, validate, test, pack, publish'],
  ['@olan-app/schema', 'Manifest, UI tree and permission schemas'],
  ['@olan-app/runtime', 'Backend runtime for app server code'],
];

/** Sidebar order; same reading order as llms.txt. A docs file missing here goes under "More". */
const NAV = [
  ['Start', ['getting-started', 'examples']],
  ['Build the UI', ['components', 'hooks', 'navigation', 'surfaces', 'cards']],
  ['Data and permissions', ['api', 'database', 'permissions', 'manifest']],
  ['Servers and integrations', ['server', 'remote-requests', 'files', 'links', 'backend']],
  ['Test and ship', ['testing', 'cli', 'marketplace', 'review-guidelines']],
  ['Reference', ['errors']],
];

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { root: resolve(here, '..'), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' && value) { args.root = resolve(value); i += 1; }
    else if (flag === '--out' && value) { args.out = resolve(value); i += 1; }
    else throw new Error(`Unknown argument ${flag}. Usage: node build.mjs [--root <dir>] [--out <dir>]`);
  }
  args.out ??= join(args.root, 'site', 'dist');
  return args;
}

/** GitHub-compatible heading slugs, so `docs/server.md#rotating-the-app-key` keeps working. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text of an inline token (code spans keep their text, markup is dropped). */
function inlineText(token) {
  return (token.children ?? []).map((child) => (child.type === 'text' || child.type === 'code_inline' ? child.content : '')).join('');
}

function createRenderer(pages) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

  /** `./api.md`, `api.md`, `docs/api.md#x`, `../README.md`, `llms.txt` → site paths. */
  const rewriteHref = (href, env) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
    const match = /^(?:\.{1,2}\/)*(?:docs\/)?([A-Za-z0-9_-]+)\.md(#.*)?$/.exec(href);
    if (match) {
      const [, name, hash = ''] = match;
      if (name === 'README') return `/${hash}`;
      if (pages.has(name)) return `/${name}/${hash}`;
    }
    if (/^(?:\.{1,2}\/)*llms\.txt$/.test(href)) return '/llms.txt';
    env.unresolved.push(href);
    return href;
  };

  /** Plain-text references such as `server.md#assistant-tools-aitools` or `docs/api.md` become links. */
  const DOC_REF = /\b(?:docs\/)?([a-z][a-z0-9-]*)\.md(#[a-z0-9-]+)?/g;
  const linkifyDocRefs = (textToken, state) => {
    const text = textToken.content;
    const out = [];
    let last = 0;
    for (const match of text.matchAll(DOC_REF)) {
      if (!pages.has(match[1])) continue;
      if (match.index > last) out.push(Object.assign(new state.Token('text', '', 0), { content: text.slice(last, match.index) }));
      const open = new state.Token('link_open', 'a', 1);
      open.attrSet('href', `/${match[1]}/${match[2] ?? ''}`);
      out.push(open, Object.assign(new state.Token('text', '', 0), { content: match[0] }), new state.Token('link_close', 'a', -1));
      last = match.index + match[0].length;
    }
    if (!out.length) return [textToken];
    if (last < text.length) out.push(Object.assign(new state.Token('text', '', 0), { content: text.slice(last) }));
    return out;
  };

  md.core.ruler.push('olan_links_and_anchors', (state) => {
    const slug = slugger();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === 'heading_open') {
        const text = inlineText(tokens[i + 1]);
        token.attrSet('id', slug(text));
        if (token.tag === 'h1' && !state.env.title) state.env.title = text;
      }
      if (token.type === 'paragraph_open' && !state.env.description) {
        const text = inlineText(tokens[i + 1]).replace(/\s+/g, ' ').trim();
        if (text.length > 40) state.env.description = text.length > 180 ? `${text.slice(0, 177)}…` : text;
      }
      if (token.type !== 'inline' || !token.children) continue;
      const children = [];
      let inLink = 0;
      for (const child of token.children) {
        if (child.type === 'link_open') {
          inLink += 1;
          child.attrSet('href', rewriteHref(child.attrGet('href') ?? '', state.env));
        }
        if (child.type === 'link_close') inLink -= 1;
        if (child.type === 'text' && !inLink) children.push(...linkifyDocRefs(child, state));
        else children.push(child);
      }
      token.children = children;
    }
  });

  // Headings get a visible anchor link after the text.
  md.renderer.rules.heading_close = (tokens, idx) => {
    const open = tokens[idx - 2];
    const id = open?.attrGet('id');
    const anchor = id && open.tag !== 'h1' ? ` <a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a>` : '';
    return `${anchor}</${tokens[idx].tag}>\n`;
  };

  // `docs/server.md#calling-olan-back` written as code becomes a link to that page.
  const defaultCode = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const html = defaultCode(tokens, idx, options, env, self);
    const match = /^(?:\.\/)?docs\/([a-z0-9-]+)\.md(#[a-z0-9-]+)?$/.exec(tokens[idx].content);
    if (match && pages.has(match[1])) return `<a href="/${match[1]}/${match[2] ?? ''}">${html}</a>`;
    return html;
  };

  // Wide tables scroll inside their own box on small screens.
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  return (markdown) => {
    const env = { title: '', description: '', unresolved: [] };
    const html = md.render(markdown, env);
    return { html, ...env };
  };
}

function layout({ title, description, path, body, nav, css }) {
  const pageTitle = path === '/' ? 'Olan Apps developer documentation' : `${title} · Olan Apps docs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(description || 'Build Olan Apps with TypeScript and React: SDK, CLI, components, APIs and guides.')}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${SITE_URL}${path}">
<link rel="stylesheet" href="/${css}">
<link rel="icon" type="image/svg+xml" href="/assets/olan-mark.svg">
</head>
<body>
<input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
<header class="topbar">
  <label for="nav-toggle" class="menu-button" aria-label="Menu"><span></span></label>
  <a class="brand" href="/" aria-label="Olan Apps docs"><img class="logo logo-on-light" src="/assets/olan-logo-on-light.svg" alt="Olan" width="81" height="24"><img class="logo logo-on-dark" src="/assets/olan-logo-on-dark.svg" alt="" width="81" height="24">Apps <span class="brand-sub">docs</span></a>
  <nav class="top-links" aria-label="External">
    <a href="https://www.npmjs.com/package/@olan-app/sdk">npm</a>
    <a href="${GITHUB_URL}">GitHub</a>
  </nav>
</header>
<div class="shell">
  <aside class="sidebar">
    <nav aria-label="Documentation">${nav(path)}</nav>
  </aside>
  <main class="content">
    <article class="doc">
${body}
    </article>
    <footer class="footer">
      <p>The Olan Apps packages are open source under the MIT License:
      ${NPM_PACKAGES.map(([name]) => `<a href="https://www.npmjs.com/package/${name}">${name}</a>`).join(', ')}.
      Source and issues: <a href="${GITHUB_URL}">github.com/alkamanas/olan-app</a>.
      For coding agents: <a href="/llms.txt">llms.txt</a>.</p>
      <p><a href="https://olan.app">olan.app</a></p>
    </footer>
  </main>
</div>
</body>
</html>
`;
}

function landingIntro() {
  const rows = NPM_PACKAGES.map(([name, what]) => `<tr><td><a href="https://www.npmjs.com/package/${name}"><code>${name}</code></a></td><td>${escapeHtml(what)}</td></tr>`).join('\n');
  return `<section class="hero">
  <p class="eyebrow">Olan Apps</p>
  <h1 id="olan-apps">Build apps for Olan with TypeScript and React</h1>
  <p class="lead">Apps describe their UI with SDK components that Olan draws natively on web, desktop, iOS and Android.
  They run in a sandbox and reach Olan data only through permission-checked <code>olan.*</code> calls.</p>
  <pre class="quickstart"><code>npx @olan-app/cli init "My app"
cd my-app &amp;&amp; npm install
npx olan-app validate --strict &amp;&amp; npx olan-app test</code></pre>
  <p class="cta"><a class="button" href="/getting-started/">Get started</a>
  <a class="button secondary" href="${GITHUB_URL}">GitHub</a></p>
  <div class="table-wrap"><table class="packages"><thead><tr><th>Package (MIT)</th><th>What it is</th></tr></thead><tbody>
${rows}
  </tbody></table></div>
</section>
`;
}

/** Every site-relative href must name a page that exists and, with `#x`, an id on that page. */
function verifyLinks(out) {
  const html = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.name.endsWith('.html')) html.set(path, readFileSync(path, 'utf8'));
    }
  };
  walk(out);
  const ids = (file) => new Set([...html.get(file).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const broken = [];
  for (const [file, text] of html) {
    for (const [, href] of text.matchAll(/href="([^"]+)"/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/llms.txt') || href.startsWith('/style.') || href.startsWith('/assets/')) continue;
      const [path, hash] = href.split('#');
      const target = path === '' ? file : join(out, path, path.endsWith('/') ? 'index.html' : '');
      if (!html.has(target)) broken.push(`${file.slice(out.length)}: ${href}`);
      else if (hash && !ids(target).has(hash)) broken.push(`${file.slice(out.length)}: ${href} (no such heading)`);
    }
  }
  if (broken.length) throw new Error(`Broken links:\n  ${[...new Set(broken)].join('\n  ')}`);
}

export function buildSite({ root, out }) {
  const docsDir = join(root, 'docs');
  const readmePath = join(root, 'packages', 'app-sdk', 'README.md');
  const llmsPath = join(root, 'packages', 'app-sdk', 'llms.txt');
  for (const path of [docsDir, readmePath, llmsPath]) {
    if (!existsSync(path)) throw new Error(`Missing input ${path} (is --root the olan-app repository?)`);
  }
  const names = readdirSync(docsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  const pages = new Set(names);
  const listed = new Set(NAV.flatMap(([, items]) => items));
  for (const name of listed) if (!pages.has(name)) throw new Error(`NAV lists docs/${name}.md, which does not exist`);
  const extra = names.filter((n) => !listed.has(n));
  const sections = extra.length ? [...NAV, ['More', extra]] : NAV;

  const render = createRenderer(pages);
  const rendered = new Map();
  for (const name of names) rendered.set(name, render(readFileSync(join(docsDir, `${name}.md`), 'utf8')));

  const nav = (current) => [
    `<ul class="nav-list"><li><a href="/"${current === '/' ? ' aria-current="page"' : ''}>Overview</a></li></ul>`,
    ...sections.map(([label, items]) => `<p class="nav-label">${escapeHtml(label)}</p><ul class="nav-list">${items
      .map((name) => {
        const href = `/${name}/`;
        const title = rendered.get(name).title.replace(/`/g, '') || name;
        return `<li><a href="${href}"${current === href ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a></li>`;
      })
      .join('')}</ul>`),
  ].join('\n');

  const css = readFileSync(join(here, 'style.css'), 'utf8');
  const cssName = `style.${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, cssName), css);

  const unresolved = [];
  const write = (path, html) => {
    const file = path === '/' ? join(out, 'index.html') : join(out, path, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  };

  // Landing page: the SDK README below a short introduction; its h1 becomes an h2.
  const readme = render(readFileSync(readmePath, 'utf8').replace(/^# .*\n/, '## The SDK: `@olan-app/sdk`\n'));
  unresolved.push(...readme.unresolved.map((h) => `README.md: ${h}`));
  write('/', layout({ title: 'Olan Apps', description: '', path: '/', body: landingIntro() + readme.html, nav, css: cssName }));

  for (const name of names) {
    const page = rendered.get(name);
    unresolved.push(...page.unresolved.map((h) => `docs/${name}.md: ${h}`));
    write(`/${name}/`, layout({ title: page.title.replace(/`/g, '') || name, description: page.description, path: `/${name}/`, body: page.html, nav, css: cssName }));
  }
  if (unresolved.length) throw new Error(`Relative links the site cannot resolve:\n  ${unresolved.join('\n  ')}`);

  writeFileSync(join(out, '404.html'), layout({
    title: 'Page not found',
    description: 'This page does not exist.',
    path: '/404.html',
    body: '<h1 id="page-not-found">Page not found</h1>\n<p>This page does not exist. Start from the <a href="/">overview</a> or <a href="/getting-started/">Getting started</a>.</p>\n',
    nav,
    css: cssName,
  }));

  verifyLinks(out);
  // The Olan logo and mark (header and favicon).
  mkdirSync(join(out, 'assets'), { recursive: true });
  for (const name of readdirSync(join(here, 'assets'))) writeFileSync(join(out, 'assets', name), readFileSync(join(here, 'assets', name)));
  writeFileSync(join(out, 'llms.txt'), readFileSync(llmsPath));
  const urls = ['/', ...names.map((n) => `/${n}/`)];
  writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  return { pages: urls.length, out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = buildSite(parseArgs(process.argv.slice(2)));
    console.log(`built ${result.pages} pages into ${result.out}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
