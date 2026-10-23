import { fail } from './errors';

export interface ArgSpec {
  /** Flags without a value (`--strict`). */
  booleans?: readonly string[];
  /** Flags with a value (`--port 5178` or `--port=5178`). */
  strings?: readonly string[];
  /**
   * Flags with an optional URL value (`--marketplace` or `--marketplace https://…`): the next
   * argument is taken only when it is an http(s) URL, so `--marketplace <appId>` stays a positional.
   */
  optionalUrls?: readonly string[];
  /** Short aliases (`-o` → `out`). */
  aliases?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags every command accepts. */
export const GLOBAL_BOOLEANS = ['json', 'help'] as const;
export const GLOBAL_STRINGS = ['cwd'] as const;

/**
 * A small strict parser: unknown flags fail with `cli.unknown_option`, so a typo never runs a
 * command with a silently ignored option. `--` ends flag parsing.
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const booleans = new Set<string>([...GLOBAL_BOOLEANS, ...(spec.booleans ?? [])]);
  const strings = new Set<string>([...GLOBAL_STRINGS, ...(spec.strings ?? [])]);
  const optionalUrls = new Set<string>(spec.optionalUrls ?? []);
  const aliases: Record<string, string> = { h: 'help', C: 'cwd', ...(spec.aliases ?? {}) };
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      name = aliases[arg.slice(1)] ?? arg.slice(1);
    }
    if (name.startsWith('no-') && booleans.has(name.slice(3)) && inline === undefined) {
      flags[name.slice(3)] = false;
      continue;
    }
    if (optionalUrls.has(name)) {
      const next = argv[index + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && /^https?:\/\//i.test(next)) flags[name] = argv[++index]!;
      else flags[name] = true;
      continue;
    }
    if (booleans.has(name)) {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') fail('cli.invalid_option', `--${name} does not take a value`);
      flags[name] = inline === undefined ? true : inline === 'true';
      continue;
    }
    if (strings.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) fail('cli.missing_value', `--${name} needs a value`);
      flags[name] = value;
      continue;
    }
    fail('cli.unknown_option', `Unknown option ${arg}`, { hint: 'Run `olan-app <command> --help` for the options of a command.' });
  }
  return { positionals, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanFlag(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags[name];
  return typeof value === 'boolean' ? value : fallback;
}

export function integerFlag(args: ParsedArgs, name: string, fallback: number, min = 0, max = 65535): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) fail('cli.invalid_option', `--${name} must be an integer between ${min} and ${max}`);
  return value;
}
