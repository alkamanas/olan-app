import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { issue, type Issue } from './errors';
import { displayPath } from './paths';

const DIAGNOSTIC = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export interface TypeCheckResult {
  /** `false` when the project has no tsconfig.json or TypeScript is not installed. */
  ran: boolean;
  issues: Issue[];
  /** Why it did not run. */
  skipped?: string;
}

/** Parses `tsc --pretty false` output into issues (continuation lines join the message). */
export function parseTscOutput(projectDir: string, output: string): Issue[] {
  const issues: Issue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line);
    if (match) {
      const [, file, row, column, , code, message] = match;
      issues.push(issue(`typescript.${code}`, message!, { file: displayPath(projectDir, resolve(projectDir, file!)), line: Number(row), column: Number(column) }));
    } else if (line.startsWith('  ') && issues.length > 0) {
      issues[issues.length - 1]!.message += `\n${line.trim()}`;
    } else if (/^error TS\d+:/.test(line)) {
      const code = /^error (TS\d+):/.exec(line)![1];
      issues.push(issue(`typescript.${code}`, line.replace(/^error TS\d+:\s*/, '')));
    }
  }
  return issues;
}

/**
 * The extra projects checked after `tsconfig.json` when present: the tests and the app's own Node
 * server (`app-server/`, `olan-app init --template remote`), which get Node types; the app does not.
 */
export const EXTRA_TSCONFIGS = [join('tests', 'tsconfig.json'), join('app-server', 'tsconfig.json')] as const;

/**
 * Runs the project's own TypeScript (`tsc --noEmit`) on `tsconfig.json` and, when present,
 * `tests/tsconfig.json` and `app-server/tsconfig.json`.
 */
export function typeCheck(projectDir: string): TypeCheckResult {
  const main = typeCheckProject(projectDir, 'tsconfig.json');
  if (!main.ran) return main;
  const extra = EXTRA_TSCONFIGS.map((config) => typeCheckProject(projectDir, config));
  // A file several projects include (tests import app-server/) is reported once.
  const seen = new Set<string>();
  const issues = [...main.issues, ...extra.flatMap((result) => result.issues)].filter((item) => {
    const key = `${item.code}\u0000${item.file ?? ''}\u0000${item.line ?? ''}\u0000${item.column ?? ''}\u0000${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ran: true, issues };
}

function typeCheckProject(projectDir: string, config: string): TypeCheckResult {
  const tsconfig = join(projectDir, config);
  if (!existsSync(tsconfig)) return { ran: false, issues: [], skipped: `no ${config}` };
  let tsc: string;
  try {
    tsc = createRequire(join(projectDir, 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    return { ran: false, issues: [], skipped: 'typescript is not installed (npm install -D typescript)' };
  }
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', tsconfig, '--pretty', 'false'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const issues = parseTscOutput(projectDir, output);
  if (run.status !== 0 && issues.length === 0) {
    issues.push(issue('typescript.failed', output.trim() || `tsc exited with ${run.status ?? run.signal}`));
  }
  return { ran: true, issues };
}
