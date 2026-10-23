import { booleanFlag } from '../args';
import type { Command } from '../command';
import { CliError, issue } from '../errors';
import {
  describeSubmission,
  marketplaceFail,
  marketplaceRequest,
  pollInterval,
  requireSession,
  submissionHeader,
  submissionIssues,
  versionPath,
  waitForSubmission,
  type VersionStatus,
} from '../marketplace';

/** States that make `status` exit 1 (contract §22): the version will not be published as submitted. */
const FAILED = new Set(['checks_failed', 'rejected', 'withdrawn']);

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show a marketplace submission: checks, review state, rejection and next action',
  usage: 'olan-app status --marketplace [url] <appId> [version] [--wait-decision]',
  options: [
    '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, the session\'s, https://marketplace.olan.app)',
    '--wait-decision      Poll every 5 s while the version is being checked or reviewed',
    '',
    'Without a version: the app\'s newest version. Exit 0: approved, checking, in_review;',
    'exit 1: checks_failed, rejected, withdrawn. --json prints the marketplace answer { version, submission } unchanged.',
  ],
  spec: { optionalUrls: ['marketplace'], booleans: ['wait-decision'] },
  async run(args, context) {
    const flag = args.flags.marketplace;
    if (flag === undefined || flag === false) marketplaceFail('target_required', 'status reads Olan Marketplace: pass --marketplace [url]', 'olan-app status --marketplace <appId> [version]');
    const [appId, requested] = args.positionals;
    if (!appId) marketplaceFail('app_required', 'Which app? olan-app status --marketplace <appId> [version]');
    const { url, session } = await requireSession(flag, context.env);

    let version: string;
    if (requested) version = requested;
    else {
      // The developer app view lists versions newest first.
      const { app } = await marketplaceRequest<{ app: { versions?: { version: string }[] } }>(url, `/api/v1/developer/apps/${encodeURIComponent(appId)}`, { token: session.token });
      const latest = app.versions?.[0]?.version;
      if (!latest) marketplaceFail('version_not_found', `${appId} has no submitted version yet`, 'Submit one with `olan-app publish --marketplace`.');
      version = latest;
    }

    const status = booleanFlag(args, 'wait-decision')
      ? await waitForSubmission(url, session.token, appId, version, { pending: (state) => state === 'checking' || state === 'in_review', intervalMs: pollInterval(context.env), log: context.log })
      : await marketplaceRequest<VersionStatus>(url, versionPath(appId, version), { token: session.token });

    // A version released after approval needs nothing more, whatever an older marketplace says.
    const submission = status.submission?.nextAction === 'release' && status.version.releaseState === 'published' ? { ...status.submission, nextAction: 'none' } : status.submission;
    const release =status.version.channel ? `, ${status.version.channel}${status.version.releaseState ? ` (${status.version.releaseState})` : ''}` : '';
    if (submission && FAILED.has(submission.state)) {
      // The summary (checks, review, next step) goes to stderr ahead of the failure; findings follow as issues.
      context.log([`${appId} ${version} on ${url}${release}`, ...submissionHeader(submission, url)].join('\n'));
      const issues = submission.state === 'withdrawn'
        ? [issue('marketplace.withdrawn', `${appId} ${version} was withdrawn`, { hint: 'Publish again with `olan-app publish --marketplace`.' })]
        : submissionIssues(submission);
      throw new CliError(issues, undefined, status);
    }
    if (!submission && status.version.reviewState === 'rejected') {
      throw new CliError(issue('marketplace.rejected', `${appId} ${version} was rejected${status.version.reviewNotes ? `: ${String(status.version.reviewNotes)}` : ''}`), undefined, status);
    }
    // An approved version waiting for release: say so if the app still lacks the age rating release needs.
    const extra: string[] = [];
    if (submission?.nextAction === 'release' && !context.json) {
      const app = await marketplaceRequest<{ app: { ageRating?: string | null } }>(url, `/api/v1/developer/apps/${encodeURIComponent(appId)}`, { token: session.token }).catch(() => null);
      if (app && !app.app.ageRating) {
        extra.push(`  Age rating: not set; release needs one first: \`olan-app app set --marketplace ${url} ${appId} --age-rating 4+|9+|13+\``);
      }
    }
    return {
      result: status,
      raw: true,
      human: [
        `${appId} ${version} on ${url}${release}`,
        ...(submission ? describeSubmission(submission, url) : [`  Review: ${status.version.reviewState ?? 'unknown'} (submitted outside the developer flow)`]),
        ...extra,
      ],
    };
  },
};
