import { stringFlag, type ParsedArgs } from '../args';
import type { Command, CommandContext, CommandOutput } from '../command';
import { CliError } from '../errors';
import { describeSubmission, marketplaceFail, marketplaceRequest, requireMarketplaceFlag, requireSession, versionPath, type SubmissionView } from '../marketplace';

/*
 * Release management of an approved marketplace version (contract §22, Phase 4c staged rollout):
 * `release` publishes it to a channel with a rollout percent, `rollout` widens a staged rollout
 * (10 → 50 → 100; it never narrows, it also resumes a halted one), `halt` stops offering it to new
 * servers (installed copies stay), `withdraw` takes back a submission still being checked or
 * reviewed. Each is one developer route; `--json` prints the marketplace answer unchanged.
 */

/** The version view of the release routes (only what the human output reads). */
interface ReleasedVersion {
  version: string;
  reviewState?: string;
  channel?: string | null;
  releaseState?: string | null;
  rollout?: { percent: number; haltedAt: string | null } | null;
}

type Action = 'release' | 'rollout' | 'halt' | 'withdraw';

const ROUTES: Record<Action, string> = { release: '/release', rollout: '/rollout', halt: '/rollout/halt', withdraw: '/withdraw' };

function percentValue(args: ParsedArgs): number | undefined {
  const raw = stringFlag(args, 'percent');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) marketplaceFail('invalid_option', '--percent must be an integer between 1 and 100');
  return value;
}

function describeVersion(appId: string, version: ReleasedVersion, url: string): string[] {
  const rollout = version.rollout;
  const state = version.releaseState === 'published'
    ? `released to ${version.channel ?? 'stable'} at ${rollout?.percent ?? 100}%${rollout?.haltedAt ? `, halted since ${rollout.haltedAt} (no new servers get it; \`olan-app rollout\` resumes)` : ''}`
    : `${version.releaseState ?? version.reviewState ?? 'unknown'}`;
  const lines = [`${appId} ${version.version} on ${url}: ${state}`];
  if (version.releaseState === 'published' && rollout && rollout.percent < 100 && !rollout.haltedAt) {
    lines.push(`  Widen it with \`olan-app rollout --marketplace ${appId} ${version.version} --percent ${rollout.percent < 50 ? 50 : 100}\`.`);
  }
  return lines;
}

async function runAction(action: Action, args: ParsedArgs, context: CommandContext): Promise<CommandOutput> {
  const usage = USAGE[action];
  const flag = requireMarketplaceFlag(args.flags.marketplace, usage);
  const [appId, version, extra] = args.positionals;
  if (!appId || !version || extra !== undefined) marketplaceFail('app_required', `Which app and version? ${usage}`);
  // Each command's spec admits only its own options (--channel: release; --percent: release, rollout).
  const channel = stringFlag(args, 'channel');
  const percent = percentValue(args);
  if (channel !== undefined && channel !== 'stable' && channel !== 'beta') marketplaceFail('invalid_option', '--channel must be stable or beta');
  if (action === 'rollout' && percent === undefined) marketplaceFail('invalid_option', 'rollout needs --percent N (it only widens, e.g. 10 → 50 → 100)', `olan-app rollout --marketplace ${appId} ${version} --percent 50`);

  const { url, session } = await requireSession(flag, context.env);
  const body: Record<string, unknown> = {};
  if (channel !== undefined) body.channel = channel;
  if (percent !== undefined) body.percent = percent;
  let answer: { version?: ReleasedVersion; submission?: SubmissionView };
  try {
    answer = await marketplaceRequest(url, `${versionPath(appId, version)}${ROUTES[action]}`, { method: 'POST', token: session.token, json: body });
  } catch (error) {
    // Name the exact command that sets the missing age rating (`--json` still prints the body unchanged).
    if (error instanceof CliError && (error.raw as { error?: string } | undefined)?.error === 'age_rating_required') {
      const hint = `Set the age rating first: \`olan-app app set --marketplace ${url} ${appId} --age-rating 4+|9+|13+\` (or Studio → Yayınla → the app → Mağaza sayfası), then run this command again.`;
      throw new CliError(error.issues.map((item, index) => (index === 0 ? { ...item, hint } : item)), error.result, error.raw);
    }
    throw error;
  }
  const human = answer.submission
    ? [`Withdrew ${appId} ${version} on ${url}`, ...describeSubmission(answer.submission, url)]
    : answer.version
      ? describeVersion(appId, answer.version, url)
      : [`${action}: ${appId} ${version} on ${url}`];
  return { result: answer, raw: true, human };
}

const USAGE: Record<Action, string> = {
  release: 'olan-app release --marketplace [url] <appId> <version> [--channel stable|beta] [--percent N]',
  rollout: 'olan-app rollout --marketplace [url] <appId> <version> --percent N',
  halt: 'olan-app halt --marketplace [url] <appId> <version>',
  withdraw: 'olan-app withdraw --marketplace [url] <appId> <version>',
};

const COMMON = [
  '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, the session\'s, https://marketplace.olan.app)',
  '',
  'Needs `olan-app login --marketplace` (or OLAN_MARKETPLACE_SESSION). --json prints the marketplace answer',
  'unchanged; a failure prints its { error, message } body. Exit 0 on success, 1 on failure.',
];

function command(action: Action, summary: string, options: string[], spec: Command['spec']): Command {
  return { name: action, summary, usage: USAGE[action], options: [...options, ...COMMON], spec, run: (args, context) => runAction(action, args, context) };
}

export const releaseCommand = command(
  'release',
  'Release an approved marketplace version to a channel, optionally as a staged rollout',
  ['--channel <name>     stable (default) or beta (only the organizations on the app\'s beta list)', '--percent N          Staged rollout: share of servers that get it (1-100, default 100)'],
  { optionalUrls: ['marketplace'], strings: ['channel', 'percent'] },
);

export const rolloutCommand = command(
  'rollout',
  'Widen a staged marketplace rollout (10 → 50 → 100; never narrows) or resume a halted one',
  ['--percent N          New share of servers (at least the current one; 100 = everyone)'],
  { optionalUrls: ['marketplace'], strings: ['percent'] },
);

export const haltCommand = command(
  'halt',
  'Halt a marketplace rollout: no new servers get the version (installed copies stay)',
  [],
  { optionalUrls: ['marketplace'] },
);

export const withdrawCommand = command(
  'withdraw',
  'Withdraw a marketplace submission that is still being checked or reviewed',
  [],
  { optionalUrls: ['marketplace'] },
);
