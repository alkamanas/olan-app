/**
 * One machine-readable problem. Every command reports failures as a list of these, both in
 * `--json` output (`{ ok: false, errors }`) and as `file:line:column code message` lines.
 */
export interface Issue {
  /** Stable dotted code (`manifest.entry_required`, `build.error`, `tree.unknown_prop`, …). */
  code: string;
  message: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  line?: number;
  column?: number;
  /** How to fix it. */
  hint?: string;
  /** Olan App Review Guidelines rule the finding cites (`validate --strict` review checks). */
  rule?: string;
}

/** A failed command: thrown by command implementations, printed by the CLI entry point. */
export class CliError extends Error {
  readonly issues: Issue[];
  /** Partial result to print alongside the errors (e.g. test counts). */
  readonly result?: unknown;
  /**
   * With `--json`, printed as is instead of the `{ ok: false, … }` envelope (marketplace commands
   * print the marketplace's own `{ error, message, … }` body or final state, contract §22).
   */
  readonly raw?: unknown;

  constructor(issues: Issue | Issue[], result?: unknown, raw?: unknown) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.map((issue) => issue.message).join('; ') || 'The command failed');
    this.name = 'CliError';
    this.issues = list;
    this.result = result;
    this.raw = raw;
  }
}

export function issue(code: string, message: string, extra: Omit<Issue, 'code' | 'message'> = {}): Issue {
  const out: Issue = { code, message };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function fail(code: string, message: string, extra: Omit<Issue, 'code' | 'message'> = {}): never {
  throw new CliError(issue(code, message, extra));
}

/** `file:line:column` prefix for human output. */
export function formatLocation(item: Issue): string {
  if (!item.file) return '';
  let text = item.file;
  if (item.line !== undefined) text += `:${item.line}`;
  if (item.line !== undefined && item.column !== undefined) text += `:${item.column}`;
  return text;
}

export function formatIssue(item: Issue): string {
  const location = formatLocation(item);
  const lines = [`${location ? `${location} ` : ''}${item.code}: ${item.message}${item.rule ? ` (guideline ${item.rule})` : ''}`];
  if (item.hint) lines.push(`  hint: ${item.hint}`);
  return lines.join('\n');
}

export function toIssue(error: unknown, code = 'cli.internal'): Issue[] {
  if (error instanceof CliError) return error.issues;
  const message = error instanceof Error ? error.message : String(error);
  return [issue(code, message)];
}
