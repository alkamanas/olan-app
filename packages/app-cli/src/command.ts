import type { ArgSpec, ParsedArgs } from './args';
import type { Issue } from './errors';

export interface CommandContext {
  /** Directory the command runs in (`--cwd`, else the process cwd). */
  cwd: string;
  json: boolean;
  /** Human-readable progress (suppressed with `--json`). */
  log(line: string): void;
  /** Lines the person must see even with `--json` (a sign-in address); always stderr. */
  notify?(line: string): void;
  env: NodeJS.ProcessEnv;
}

export interface CommandOutput {
  result: unknown;
  /** Non-fatal findings; printed after the result and included in `--json` output. */
  warnings?: Issue[];
  /** Lines printed in human mode instead of the default summary. */
  human?: string[];
  /** Keep the process alive (dev server, MCP server) until this settles. */
  wait?: Promise<void>;
  /** With `--json`, print `result` as is instead of the `{ ok, command, result }` envelope. */
  raw?: boolean;
  /** Print nothing (stdout belongs to a protocol, e.g. MCP over stdio). */
  silent?: boolean;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Option lines for `--help`. */
  options?: string[];
  spec: ArgSpec;
  run(args: ParsedArgs, context: CommandContext): Promise<CommandOutput>;
}
