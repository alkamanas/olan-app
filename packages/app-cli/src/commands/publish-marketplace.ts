import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { booleanFlag, stringFlag, type ParsedArgs } from '../args';
import type { CommandContext, CommandOutput } from '../command';
import { CliError, issue, type Issue } from '../errors';
import {
  describeSubmission,
  marketplaceFail,
  marketplaceRequest,
  pickDeveloper,
  pollInterval,
  requireSession,
  submissionHeader,
  submissionIssues,
  versionPath,
  waitForSubmission,
  type SubmissionView,
} from '../marketplace';
import { requireProjectDir } from '../project';
import { checkTestReport, readPackageIdentity, readTestReport } from '../test-report';
import { ageRatingValue, setStoreSettings, type StoreSettingsAnswer } from './app';
import { packApp } from './pack';

/** `POST /api/v1/developer/packages` and `…/apps/:appId/versions` answer (contract §22). */
export interface MarketplaceSubmitResponse {
  app: { id: string } & Record<string, unknown>;
  version: { version: string } & Record<string, unknown>;
  createdApp: boolean;
  submission: SubmissionView;
}

/** `submission.testReport` as the marketplace shows it after `PUT …/test-report`. */
export interface TestReportView {
  status: 'verified' | 'unregistered_key';
  keyFingerprint: string;
  summary: { passed: number; failed: number; skipped: number; durationMs: number };
  failed?: { name: string; error?: string }[];
}

/** How long `publish --marketplace` waits for the automatic checks before handing over to `status`. */
const CHECKS_WAIT_MS = 30 * 60_000;

function visibilityValue(value: string | undefined, session: { serverId?: string | null; organizationId?: string | null }): string | undefined {
  if (value === undefined || value === 'public') return value;
  if (/^organization:[^/]+\/.+$/.test(value)) return value;
  if (value === 'org' || value === 'organization') {
    if (!session.serverId || !session.organizationId) {
      marketplaceFail('visibility_org_unknown', 'The saved session does not know your Olan server\'s marketplace id or your organization', 'Pass --visibility organization:<serverId>/<organizationId>, or sign in again with `olan-app login --marketplace` from a server registered with the marketplace.');
    }
    return `organization:${session.serverId}/${session.organizationId}`;
  }
  return marketplaceFail('invalid_option', '--visibility must be public, org or organization:<serverId>/<organizationId>');
}

function describeTestReport(report: TestReportView | null | undefined): string[] {
  if (!report) return [];
  const { summary } = report;
  return [
    `  Test report: ${report.status === 'verified' ? 'verified' : `signed with key ${report.keyFingerprint}, which the developer account has not registered (\`olan-app keys register --marketplace\`)`}; ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
  ];
}

/**
 * `olan-app publish --marketplace`: packs (unless `--file`), submits the package with the developer
 * session (new app → `POST /api/v1/developer/packages?developer=`, existing app →
 * `POST /api/v1/developer/apps/:appId/versions`), attaches `--test-report` (`PUT …/test-report`)
 * and, by default, waits for the automatic checks.
 */
export async function publishToMarketplace(args: ParsedArgs, context: CommandContext): Promise<CommandOutput> {
  const { url, session } = await requireSession(args.flags.marketplace, context.env);
  const token = session.token;
  const channel = stringFlag(args, 'channel');
  if (channel !== undefined && channel !== 'stable' && channel !== 'beta') marketplaceFail('invalid_option', '--channel must be stable or beta');
  const percentRaw = stringFlag(args, 'percent');
  const percent = percentRaw === undefined ? undefined : Number(percentRaw);
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 1 || percent > 100)) marketplaceFail('invalid_option', '--percent must be an integer between 1 and 100');
  if (percent !== undefined && !channel) marketplaceFail('invalid_option', '--percent needs --channel (the release that happens on approval)');
  const visibility = visibilityValue(stringFlag(args, 'visibility'), session);
  if (booleanFlag(args, 'dev-sign')) marketplaceFail('invalid_option', '--dev-sign is for --org; the marketplace signs approved packages itself');
  const ageRating = ageRatingValue(stringFlag(args, 'age-rating'));
  const reportFlag = stringFlag(args, 'test-report');
  const report = reportFlag ? readTestReport(resolve(context.cwd, reportFlag)) : undefined;

  const fileFlag = stringFlag(args, 'file');
  let file: string;
  if (fileFlag) {
    file = resolve(context.cwd, fileFlag);
    if (!existsSync(file)) marketplaceFail('file_missing', `${file} does not exist`, 'Run `olan-app pack` first or drop --file.');
  } else {
    const projectDir = requireProjectDir(context.cwd);
    // Unsigned: the marketplace signs what it approves. (A signature does not change digest.package.)
    const packed = await packApp(projectDir, { signKey: false });
    file = resolve(projectDir, packed.file);
    context.log(`Packed ${packed.file}`);
  }
  let identity;
  try {
    identity = readPackageIdentity(file);
  } catch {
    return marketplaceFail('package_unreadable', `${basename(file)} is not an Olan app package (no readable olan-app.json)`, 'Pack it with `olan-app pack` or drop --file.');
  }
  const manifest = { id: identity.appId, version: identity.appVersion };

  // The report must belong to this exact package: check before uploading anything.
  if (report !== undefined) {
    const checked = checkTestReport(report, identity);
    if (!checked.ok) {
      const hint = checked.code === 'test_report_mismatch'
        ? 'Generate the report after packing, from the sources you publish: `olan-app test --report <file>` (it packs the same way publish does).'
        : 'Generate it again with `olan-app test --report <file>` and do not edit it.';
      marketplaceFail(checked.code, `${reportFlag}: ${checked.message}`, hint);
    }
  }

  let existing = true;
  try {
    await marketplaceRequest(url, `/api/v1/developer/apps/${encodeURIComponent(manifest.id)}`, { token });
  } catch (error) {
    if (!(error instanceof CliError && (error.raw as { error?: string } | undefined)?.error === 'app_not_found')) throw error;
    existing = false;
  }
  const warnings: Issue[] = [];
  const query = new URLSearchParams();
  if (!existing) {
    const developer = await pickDeveloper(url, token, stringFlag(args, 'developer'), (slug) => `olan-app publish --marketplace --developer ${slug}`);
    context.log(`${manifest.id} is new on the marketplace: creating it in developer account ${developer}`);
    query.set('developer', developer);
  }
  if (visibility) {
    if (existing) warnings.push(issue('marketplace.visibility_ignored', '--visibility applies when an app is created; change it in Studio → Yayınla → the app → Mağaza sayfası'));
    else query.set('visibility', visibility);
  }
  if (channel) query.set('channel', channel);
  if (percent !== undefined) query.set('percent', String(percent));
  const path = existing ? `/api/v1/developer/apps/${encodeURIComponent(manifest.id)}/versions` : '/api/v1/developer/packages';
  const form = new FormData();
  form.append('package', new Blob([readFileSync(file)], { type: 'application/zip' }), basename(file));
  context.log(`Submitting ${manifest.id} ${manifest.version} to ${url}…`);
  const submitted = await marketplaceRequest<MarketplaceSubmitResponse>(url, `${path}${query.size ? `?${query}` : ''}`, { method: 'POST', token, form });
  const version = submitted.version.version;

  let result: MarketplaceSubmitResponse & { testReport?: TestReportView | null; storeSettings?: StoreSettingsAnswer } = submitted;
  if (report !== undefined) {
    try {
      const attached = await marketplaceRequest<{ submission: SubmissionView & { testReport?: TestReportView | null } }>(url, `${versionPath(manifest.id, version)}/test-report`, { method: 'PUT', token, json: report });
      result = { ...submitted, submission: attached.submission, testReport: attached.submission.testReport ?? null };
      context.log(`Attached the test report (${attached.submission.testReport?.status ?? 'attached'})`);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // The package is submitted; only the report is missing. `--json` prints both.
      const failed = { ...submitted, testReport: error.raw ?? null };
      throw new CliError(
        [...error.issues, issue('marketplace.test_report_not_attached', `${manifest.id} ${version} was submitted without the test report`, { hint: 'Fix the report and attach it in Studio → Yayınla → the version (Rapor ekle).' })],
        undefined,
        failed,
      );
    }
  }

  // The age rating is a store setting of the app (required before release), set once the app exists.
  const settingsLines: string[] = [];
  if (ageRating !== undefined) {
    try {
      const { answer, lines } = await setStoreSettings(url, token, manifest.id, { ageRating });
      result = { ...result, storeSettings: answer };
      settingsLines.push(...lines.map((line) => `  ${line}`));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      throw new CliError(
        [...error.issues, issue('marketplace.age_rating_not_set', `${manifest.id} ${version} was submitted, but its age rating was not saved`, { hint: `Set it with \`olan-app app set --marketplace ${url} ${manifest.id} --age-rating ${ageRating}\` (or Studio → Yayınla → the app → Mağaza sayfası).` })],
        undefined,
        { ...result, storeSettings: error.raw ?? null },
      );
    }
  }

  const wait = args.flags.wait !== false;
  if (wait && result.submission?.state === 'checking') {
    context.log('Waiting for the automatic checks (Ctrl+C stops waiting; the submission continues)…');
    const status = await waitForSubmission(url, token, manifest.id, version, {
      pending: (state) => state === 'checking',
      intervalMs: pollInterval(context.env),
      deadline: Date.now() + CHECKS_WAIT_MS,
      log: context.log,
    });
    // The upload answer with the submission as it is now (same shape as `submission` of the upload).
    if (status.submission) result = { ...result, submission: status.submission };
  }
  const submission = result.submission;
  if (submission && (submission.state === 'checks_failed' || submission.state === 'rejected')) {
    context.log([`${manifest.id} ${version} on ${url}`, ...submissionHeader(submission, url)].join('\n'));
    throw new CliError(submissionIssues(submission), undefined, result);
  }
  const followUp = `olan-app status --marketplace ${manifest.id} ${version}`;
  return {
    result,
    raw: true,
    warnings,
    human: [
      `Submitted ${manifest.id} ${version} to ${url}${result.createdApp ? ` (new app${query.get('developer') ? ` in ${query.get('developer')}` : ''})` : ''}`,
      ...(submission ? describeSubmission(submission, url) : []),
      ...describeTestReport(result.testReport),
      ...settingsLines,
      ...(submission && (submission.state === 'checking' || submission.state === 'in_review') ? [`  Follow it with \`${followUp}\` (--wait-decision waits for the review).`] : []),
    ],
  };
}
