import { resolve } from 'node:path';

import { parseArgs, stringFlag } from './args';
import type { Command, CommandContext } from './command';
import { appCommand } from './commands/app';
import { buildCommand } from './commands/build';
import { devCommand } from './commands/dev';
import { developerCommand } from './commands/developer';
import { docsCommand } from './commands/docs';
import { initCommand } from './commands/init';
import { keygenCommand } from './commands/keygen';
import { keysCommand } from './commands/keys';
import { loginCommand } from './commands/login';
import { mcpCommand } from './commands/mcp';
import { packCommand } from './commands/pack';
import { publishCommand } from './commands/publish';
import { haltCommand, releaseCommand, rolloutCommand, withdrawCommand } from './commands/release';
import { eventsCommand, requestsCommand, toolsCommand } from './commands/remote';
import { revocationsCommand } from './commands/revocations';
import { signCommand } from './commands/sign';
import { statusCommand } from './commands/status';
import { testCommand } from './commands/test';
import { tryCommand } from './commands/try';
import { validateCommand } from './commands/validate';
import { CliError, formatIssue, issue, toIssue, type Issue } from './errors';
import { CLI_VERSION } from './version';

export const COMMANDS: Command[] = [
  initCommand,
  devCommand,
  buildCommand,
  validateCommand,
  testCommand,
  packCommand,
  keygenCommand,
  loginCommand,
  developerCommand,
  publishCommand,
  tryCommand,
  statusCommand,
  appCommand,
  releaseCommand,
  rolloutCommand,
  haltCommand,
  withdrawCommand,
  keysCommand,
  signCommand,
  revocationsCommand,
  eventsCommand,
  requestsCommand,
  toolsCommand,
  mcpCommand,
  docsCommand,
];

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const defaultIo = (): CliIo => ({
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
});

export function helpText(command?: Command): string {
  if (command) {
    return [`${command.usage}`, '', command.summary, ...(command.options?.length ? ['', ...command.options.map((line) => `  ${line}`)] : []), '', 'Every command accepts --json and --cwd <dir>.', ''].join('\n');
  }
  return [
    `olan-app ${CLI_VERSION}: build, test and ship Olan Apps`,
    '',
    'Usage: olan-app <command> [options] [--json] [--cwd <dir>]',
    '',
    ...COMMANDS.map((entry) => `  ${entry.name.padEnd(11)} ${entry.summary}`),
    '',
    'Agent loop: write src/app.tsx → olan-app validate --strict → olan-app test → fix → repeat.',
    'Docs: node_modules/@olan-app/sdk/docs (or `olan-app docs <query>`), node_modules/@olan-app/sdk/llms.txt',
    '`olan-app <command> --help` shows the options of a command.',
    '',
  ].join('\n');
}

/**
 * Runs one CLI invocation and returns the exit code (0 ok, 1 failure, 2 usage). With `--json`
 * stdout gets exactly one object: `{ ok, command, result, warnings? }` or
 * `{ ok: false, command, errors, warnings?, result? }`.
 */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  const json = argv.includes('--json');
  const first = argv.find((arg) => !arg.startsWith('-'));
  if (argv.includes('--version') || argv[0] === 'version') {
    io.stdout(json ? `${JSON.stringify({ ok: true, command: 'version', result: { version: CLI_VERSION } })}\n` : `${CLI_VERSION}\n`);
    return 0;
  }
  const command = COMMANDS.find((entry) => entry.name === first);
  if (!command) {
    if (!first || first === 'help') {
      io.stdout(helpText(first === 'help' ? COMMANDS.find((entry) => entry.name === argv[argv.indexOf('help') + 1]) : undefined));
      return 0;
    }
    const errors: Issue[] = [issue('cli.unknown_command', `Unknown command "${first}"`, { hint: `Commands: ${COMMANDS.map((entry) => entry.name).join(', ')}` })];
    if (json) io.stdout(`${JSON.stringify({ ok: false, command: first, errors })}\n`);
    else io.stderr(`${errors.map(formatIssue).join('\n')}\n`);
    return 2;
  }

  const rest = [...argv];
  rest.splice(rest.indexOf(command.name), 1);
  const report = (errors: Issue[], warnings: Issue[] = [], result?: unknown) => {
    if (json) {
      io.stdout(`${JSON.stringify({ ok: false, command: command.name, errors, ...(warnings.length ? { warnings } : {}), ...(result !== undefined ? { result } : {}) }, null, 2)}\n`);
    } else {
      io.stderr(`${errors.map(formatIssue).join('\n')}\n${warnings.length ? `${warnings.map((item) => `warning ${formatIssue(item)}`).join('\n')}\n` : ''}`);
      io.stderr(`olan-app ${command.name}: ${errors.length} error${errors.length === 1 ? '' : 's'}\n`);
    }
  };

  let args;
  try {
    args = parseArgs(rest, command.spec);
  } catch (error) {
    report(toIssue(error));
    return 2;
  }
  if (args.flags.help) {
    io.stdout(helpText(command));
    return 0;
  }
  const context: CommandContext = {
    cwd: resolve(io.cwd, stringFlag(args, 'cwd') ?? '.'),
    json,
    log: (line) => {
      if (!json) io.stderr(`${line}\n`);
    },
    notify: (line) => io.stderr(`${line}\n`),
    env: io.env,
  };
  try {
    const output = await command.run(args, context);
    if (!output.silent) {
      if (json && output.raw) {
        io.stdout(`${JSON.stringify(output.result, null, 2)}\n`);
      } else if (json) {
        // Long-running commands (dev) stream JSON lines after this envelope, so it is one line too.
        const envelope = { ok: true, command: command.name, result: output.result, ...(output.warnings?.length ? { warnings: output.warnings } : {}) };
        io.stdout(`${output.wait ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const lines = output.human ?? [JSON.stringify(output.result, null, 2)];
        if (lines.length) io.stdout(`${lines.join('\n')}\n`);
        if (output.warnings?.length) io.stderr(`${output.warnings.map((item) => `warning ${formatIssue(item)}`).join('\n')}\n`);
      }
    }
    if (output.wait) await output.wait;
    return 0;
  } catch (error) {
    if (json && error instanceof CliError && error.raw !== undefined) {
      io.stdout(`${JSON.stringify(error.raw, null, 2)}\n`);
      return 1;
    }
    if (!(error instanceof CliError) && !json) io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    const result = error instanceof CliError ? (error.result as { warnings?: Issue[] } | undefined) : undefined;
    const warnings = result?.warnings ?? [];
    report(toIssue(error), warnings, result);
    return 1;
  }
}

/** The `olan-app` binary. */
export async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
  // The command is finished (dev returns only after Ctrl+C): let the event loop drain and exit with
  // `exitCode`. Calling process.exit() right away aborts Node 24 on Windows after fetches to `localhost`
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit 0xC0000409) while the connection
  // attempts are still closing. A forked backend runtime (@olan-app/runtime) may leave a timer behind,
  // so a fallback exit (unref'd: it never keeps the process alive by itself) runs once output is flushed.
  setTimeout(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  }, EXIT_FALLBACK_MS).unref();
}

/** How long a finished command may wait for leftover handles before it exits anyway. */
const EXIT_FALLBACK_MS = 1500;
