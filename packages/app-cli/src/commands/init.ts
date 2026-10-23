import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { APP_ID_PATTERN } from '@olan-app/schema';

import { booleanFlag, stringFlag } from '../args';
import type { Command } from '../command';
import { fail } from '../errors';
import { templatesDir, toPosix } from '../paths';
import { createIconPng } from '../png';

export const TEMPLATES = ['blank', 'list-detail', 'data-list', 'project-widget', 'project-tab', 'project-records', 'external-api', 'backend', 'remote'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Published package range written into new apps (unless `--link`). */
const PUBLISHED_RANGE = '^1.8.0';
/**
 * `minServerVersion` written into new apps: the oldest Olan server with Olan Apps (platform
 * `VERSION` 0.1.0; decision 2026-10-17). Olan's product version is still 0.x, so this is the real
 * minimum, not 1.0.0. Raise it only when templates start needing a newer server.
 */
export const MIN_SERVER_VERSION = '0.1.0';
const SKILL_TARGETS = ['.claude/skills/olan-app/SKILL.md', '.codex/skills/olan-app/SKILL.md'];

export interface InitOptions {
  name: string;
  template?: string;
  /** Target directory (default: the slug of `name` under `cwd`). */
  dir?: string;
  /** Reverse-domain app id (default `com.example.<slug>`). */
  id?: string;
  /** Directory holding `app-sdk` and `app-cli` (monorepo development): writes `file:` dependencies. */
  link?: string;
  cwd: string;
}

export interface InitResult {
  dir: string;
  appId: string;
  name: string;
  template: TemplateName;
  dependencies: { sdk: string; cli: string };
  files: string[];
  next: string[];
}

export function slugify(name: string): string {
  return name
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else if (entry.isFile()) out.push(toPosix(relative(base, path)));
  }
  return out;
}

/** Template path → project paths (`_gitignore` → `.gitignore`, `*.tmpl` → without the suffix). */
function targetsFor(path: string): string[] {
  if (path === 'template.json') return [];
  if (path === 'skill/SKILL.md') return SKILL_TARGETS;
  const renamed = path.replace(/(^|\/)_gitignore$/, '$1.gitignore').replace(/\.tmpl$/, '');
  return [renamed];
}

function substitute(text: string, file: string, values: Record<string, string>): string {
  const escape = file.endsWith('.json')
    ? (value: string) => JSON.stringify(value).slice(1, -1)
    : /\.(tsx?|mts)$/.test(file)
      ? (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      : (value: string) => value;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? escape(values[key]!) : match));
}

function readTemplateInfo(template: string): { description?: string; sdk?: string } {
  try {
    return JSON.parse(readFileSync(join(templatesDir(), template, 'template.json'), 'utf8')) as { description?: string; sdk?: string };
  } catch {
    return {};
  }
}

export function readTemplateDescription(template: string): string {
  return readTemplateInfo(template).description ?? '';
}

/** `olan-app init`: copies `_shared` and the template, fills in the app's name and id, draws an icon. */
export function initApp(options: InitOptions): InitResult {
  const name = options.name.trim();
  if (!name) fail('init.name_required', 'Pass the app name: `olan-app init "Geciken görevler"`');
  if (name.length > 80) fail('init.name_too_long', 'App names are limited to 80 characters');
  const template = (options.template ?? 'blank') as TemplateName;
  if (!TEMPLATES.includes(template)) fail('init.unknown_template', `Unknown template "${options.template}"`, { hint: `Templates: ${TEMPLATES.join(', ')}` });
  const slug = slugify(name) || 'olan-app';
  const appId = options.id ?? `com.example.${slug}`;
  if (!APP_ID_PATTERN.test(appId) || appId.length > 128) fail('init.invalid_id', `"${appId}" is not a valid app id`, { hint: 'Use a reverse domain name in lowercase, e.g. com.yourcompany.overdue-tasks (pass --id).' });
  const target = resolve(options.cwd, options.dir ?? slug);
  if (existsSync(target) && readdirSync(target).length > 0) fail('init.not_empty', `${target} exists and is not empty`, { hint: 'Choose another name or pass --dir <new directory>.' });

  const link = options.link ? resolve(options.cwd, options.link) : null;
  // A template may pin a newer range (template.json `sdk`) when it needs a later SDK and the CLI
  // release that mocks it; otherwise the current published range.
  const publishedRange = readTemplateInfo(template).sdk ?? PUBLISHED_RANGE;
  const dependency = (pkg: 'app-sdk' | 'app-cli') => {
    if (!link) return publishedRange;
    const rel = toPosix(relative(target, join(link, pkg)));
    return `file:${rel.startsWith('.') ? rel : `./${rel}`}`;
  };
  const values = {
    appName: name,
    appId,
    packageName: slug,
    template,
    minServerVersion: MIN_SERVER_VERSION,
    sdkDependency: dependency('app-sdk'),
    cliDependency: dependency('app-cli'),
  };

  const written: string[] = [];
  for (const source of ['_shared', template]) {
    const dir = join(templatesDir(), source);
    for (const file of listFiles(dir)) {
      for (const out of targetsFor(file)) {
        const path = join(target, out);
        mkdirSync(dirname(path), { recursive: true });
        // LF everywhere, also when the CLI itself was checked out with CRLF (Windows autocrlf).
        writeFileSync(path, substitute(readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n'), out, values));
        if (!written.includes(out)) written.push(out);
      }
    }
  }
  const icon = join(target, 'assets', 'icon.png');
  mkdirSync(dirname(icon), { recursive: true });
  writeFileSync(icon, createIconPng());
  written.push('assets/icon.png');

  const shownDir = toPosix(relative(options.cwd, target)) || '.';
  return {
    dir: toPosix(target),
    appId,
    name,
    template,
    dependencies: { sdk: values.sdkDependency, cli: values.cliDependency },
    files: written.sort(),
    next: [`cd ${shownDir}`, 'npm install', 'npx olan-app validate --strict', 'npx olan-app test', 'npx olan-app dev'],
  };
}

export const initCommand: Command = {
  name: 'init',
  summary: 'Create a new app from a template',
  usage: 'olan-app init <name> [--template blank|list-detail|data-list|project-widget|project-tab|project-records|external-api|backend|remote] [--backend] [--id <app id>] [--dir <dir>] [--link <packages dir>]',
  options: [
    ...TEMPLATES.map((template) => `--template ${template.padEnd(15)} ${readTemplateDescription(template)}`),
    '--backend         Same as --template backend: UI + backend code (server/index.ts, docs/backend.md)',
    '--id <id>         Reverse-domain app id (default com.example.<name>)',
    '--dir <dir>       Target directory (default: the name as a slug)',
    '--link <dir>      Use file: dependencies on <dir>/app-sdk and <dir>/app-cli (monorepo; also OLAN_APP_PACKAGES_DIR)',
  ],
  spec: { strings: ['template', 'id', 'dir', 'link'], booleans: ['backend'], aliases: { t: 'template' } },
  async run(args, context) {
    const template = stringFlag(args, 'template');
    if (booleanFlag(args, 'backend') && template !== undefined && template !== 'backend') {
      fail('init.template_conflict', `--backend creates the backend template; it cannot be combined with --template ${template}`, { hint: 'Start from --backend and copy screens over, or add "server" to the manifest by hand (docs/backend.md).' });
    }
    const result = initApp({
      name: args.positionals.join(' '),
      template: booleanFlag(args, 'backend') ? 'backend' : template,
      id: stringFlag(args, 'id'),
      dir: stringFlag(args, 'dir'),
      link: stringFlag(args, 'link') ?? context.env.OLAN_APP_PACKAGES_DIR,
      cwd: context.cwd,
    });
    return {
      result,
      human: [`Created ${result.name} (${result.appId}) from the ${result.template} template in ${result.dir}`, 'Next:', ...result.next.map((line) => `  ${line}`)],
    };
  },
};
