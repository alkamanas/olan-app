// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args';
import { runCli, type CliIo } from '../src/cli';
import { initApp, MIN_SERVER_VERSION, TEMPLATES } from '../src/commands/init';
import { CliError } from '../src/errors';
import { CLI_VERSION } from '../src/version';
import { TMP_ROOT, manifest, tempProject } from './helpers';

const PACKAGE_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };

async function run(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), cwd: options.cwd ?? TMP_ROOT, env: options.env ?? {} };
  const code = await runCli(argv, io);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as { ok: boolean; command: string; result?: any; errors?: any[]; warnings?: any[] } };
}

describe('parseArgs', () => {
  it('parses positionals, booleans, strings, --x=y, aliases, --no-x and --', () => {
    const parsed = parseArgs(['init', 'Ad', '--template=blank', '-C', 'dir', '--no-build', '--strict', '--json', '--', '--literal'], {
      booleans: ['strict', 'build'],
      strings: ['template'],
    });
    expect(parsed.positionals).toEqual(['init', 'Ad', '--literal']);
    expect(parsed.flags).toEqual({ template: 'blank', cwd: 'dir', build: false, strict: true, json: true });
  });

  it('rejects unknown options, missing values and values for booleans', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as CliError).issues[0]!.code;
      }
      return null;
    };
    expect(codeOf(() => parseArgs(['--nope']))).toBe('cli.unknown_option');
    expect(codeOf(() => parseArgs(['--port'], { strings: ['port'] }))).toBe('cli.missing_value');
    expect(codeOf(() => parseArgs(['--port', '--json'], { strings: ['port'] }))).toBe('cli.missing_value');
    expect(codeOf(() => parseArgs(['--strict=yes'], { booleans: ['strict'] }))).toBe('cli.invalid_option');
  });
});

describe('runCli', () => {
  it('keeps CLI_VERSION equal to package.json', async () => {
    expect(CLI_VERSION).toBe(PACKAGE_JSON.version);
    const out = await run(['--version', '--json']);
    expect(out.json()).toEqual({ ok: true, command: 'version', result: { version: CLI_VERSION } });
  });

  it('prints help and exits 0', async () => {
    const out = await run([]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('validate');
    const validate = await run(['validate', '--help']);
    expect(validate.stdout).toContain('--strict');
  });

  it('answers unknown commands and options with exit code 2 and a JSON envelope', async () => {
    const unknown = await run(['frobnicate', '--json']);
    expect(unknown.code).toBe(2);
    expect(unknown.json()).toMatchObject({ ok: false, command: 'frobnicate', errors: [{ code: 'cli.unknown_command' }] });
    const option = await run(['build', '--bogus', '--json']);
    expect(option.code).toBe(2);
    expect(option.json()).toMatchObject({ ok: false, command: 'build', errors: [{ code: 'cli.unknown_option' }] });
  });

  it('reports a missing project as project.not_found (exit 1)', async () => {
    const out = await run(['validate', '--json'], { cwd: resolve(TMP_ROOT, '..', '..') });
    expect(out.code).toBe(1);
    expect(out.json()).toMatchObject({ ok: false, command: 'validate', errors: [{ code: 'project.not_found' }] });
  });

  it('prints file:line code: message and hint lines without --json', async () => {
    const project = tempProject('human', { 'olan-app.json': manifest({ colour: 'red' }), 'src/app.tsx': 'export default 1;' });
    try {
      const out = await run(['validate', '--no-typecheck'], { cwd: project.dir });
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(/^olan-app\.json:\d+:\d+ manifest\.unknown_field: /m);
      expect(out.stderr).toContain('olan-app validate: ');
    } finally {
      project.remove();
    }
  });
});

describe('init', () => {
  it.each(TEMPLATES)('the %s template has the agent files, tests and minServerVersion 0.1.0', (template) => {
    const project = tempProject(`init-${template}`);
    try {
      const result = initApp({ name: `Deneme ${template}`, template, cwd: project.dir, dir: 'app' });
      const dir = join(project.dir, 'app');
      for (const file of [
        'AGENTS.md',
        'CLAUDE.md',
        '.claude/skills/olan-app/SKILL.md',
        '.codex/skills/olan-app/SKILL.md',
        '.gitignore',
        'README.md',
        'olan-app.json',
        'package.json',
        'tsconfig.json',
        'tests/tsconfig.json',
        'tests/app.test.ts',
        'src/app.tsx',
        'assets/icon.png',
      ]) {
        expect(result.files, file).toContain(file);
        expect(existsSync(join(dir, file)), file).toBe(true);
      }
      expect(result.files).not.toContain('template.json');
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md');
      const claudeSkill = readFileSync(join(dir, '.claude/skills/olan-app/SKILL.md'), 'utf8');
      expect(claudeSkill).toBe(readFileSync(join(dir, '.codex/skills/olan-app/SKILL.md'), 'utf8'));
      expect(claudeSkill).toMatch(/^---\nname: olan-app\ndescription: .+\n---\n/);
      const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(agents).toContain(`com.example.deneme-${template}`);
      expect(agents).not.toMatch(/\{\{\w+\}\}/);
      for (const needle of ['validate --strict', 'olan-app test', 'named components', 'react-native', 'projects:write', 'http:<host>', 'useNavigation', 'renderApp', 'fixtures/']) {
        expect(agents, needle).toContain(needle);
      }
      const manifestJson = JSON.parse(readFileSync(join(dir, 'olan-app.json'), 'utf8')) as Record<string, unknown>;
      expect(manifestJson.minServerVersion).toBe(MIN_SERVER_VERSION);
      expect(MIN_SERVER_VERSION).toBe('0.1.0');
      expect(agents).not.toContain('Do not add `minServerVersion`');
      expect(manifestJson.id).toBe(`com.example.deneme-${template}`);
      expect(readFileSync(join(dir, 'tests/app.test.ts'), 'utf8')).toContain("from '@olan-app/cli/testing'");
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('olan-app.key.json');
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      expect(pkg.dependencies['@olan-app/sdk']).toBe('^1.8.0');
      expect(pkg.devDependencies['@olan-app/cli']).toBe('^1.8.0');
      expect(manifestJson.sdk).toBe('^1.8.0');
      if (template === 'data-list') expect(manifestJson).toMatchObject({ sdk: '^1.8.0', permissions: ['db'], data: { version: 1 } });
      // Every icon a template uses is an Olan icon name (components.md#icons); unknown ones fall back silently.
      const iconList = readFileSync(resolve(fileURLToPath(new URL('../../app-sdk/docs/components.md', import.meta.url))), 'utf8').split('## Icons')[1]!;
      const icons = new Set(/`([^`]+)`\s*$/.exec(iconList.trim())![1]!.split(/\s+/));
      const used = [...readFileSync(join(dir, 'src/app.tsx'), 'utf8').matchAll(/\bicon(?:=|:\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
      for (const icon of used) expect(icons.has(icon), `${template}: icon "${icon}"`).toBe(true);
    } finally {
      project.remove();
    }
  });

  it('writes file: dependencies with --link and OLAN_APP_PACKAGES_DIR', async () => {
    const project = tempProject('init-link');
    try {
      const packages = join(project.dir, 'packages');
      const viaFlag = await run(['init', 'Bağlı', '--link', packages, '--json'], { cwd: project.dir });
      expect(viaFlag.json().result.dependencies).toEqual({ sdk: 'file:../packages/app-sdk', cli: 'file:../packages/app-cli' });
      const pkg = JSON.parse(readFileSync(join(project.dir, 'bagli', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      expect(pkg.dependencies['@olan-app/sdk']).toBe('file:../packages/app-sdk');

      const viaEnv = await run(['init', 'Env app', '--dir', 'nested/env', '--json'], { cwd: project.dir, env: { OLAN_APP_PACKAGES_DIR: packages } });
      expect(viaEnv.json().result.dependencies.cli).toBe('file:../../packages/app-cli');
    } finally {
      project.remove();
    }
  });

  it('refuses bad names, ids, templates and non-empty directories', async () => {
    const project = tempProject('init-errors', { 'taken/file.txt': 'x' });
    try {
      const codes = async (argv: string[]) => (await run([...argv, '--json'], { cwd: project.dir })).json().errors?.[0]?.code;
      expect(await codes(['init'])).toBe('init.name_required');
      expect(await codes(['init', 'A', '--id', 'Bad Id'])).toBe('init.invalid_id');
      expect(await codes(['init', 'A', '--template', 'chat-bot'])).toBe('init.unknown_template');
      expect(await codes(['init', 'Taken'])).toBe('init.not_empty');
    } finally {
      project.remove();
    }
  });
});
