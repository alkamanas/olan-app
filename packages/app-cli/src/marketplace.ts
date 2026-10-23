import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliError, issue, type Issue } from './errors';

/*
 * Olan Marketplace from the CLI (contract §15, §22, §27). A developer signs in once with
 * `olan-app login --marketplace`: the CLI asks the Olan server they are signed in to for a
 * short-lived identity token and exchanges it for a marketplace developer session (`olan_dev_…`,
 * 30 days), stored in `~/.olan/marketplace.json`. `OLAN_MARKETPLACE_SESSION` replaces the file (CI).
 * The session token is never printed, logged or accepted on the command line.
 */

export const DEFAULT_MARKETPLACE_URL = 'https://marketplace.olan.app';
/** Polling interval while a submission is being checked or reviewed. */
export const POLL_INTERVAL_MS = 5_000;

export interface MarketplaceSession {
  url: string;
  token: string;
  expiresAt: string;
  userRef: string;
  email?: string | null;
  /** `olan_org_id` of the identity token: the person's organization on their Olan server. */
  organizationId?: string | null;
  /** The Olan server's marketplace registration id, when the server told us (for `--visibility org`). */
  serverId?: string | null;
  /** Olan server the identity came from. */
  server?: string;
}

export interface LoadedSession {
  session: Partial<MarketplaceSession> & { token: string };
  source: 'env' | 'file';
}

/** A submission as the marketplace's developer API returns it (only what the CLI reads). */
export interface SubmissionView {
  appId: string;
  version: string;
  state: 'checking' | 'checks_failed' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';
  nextAction?: string;
  /** `full` or `light` once the checks passed; `reviewReasons` say why a full review (e.g. `first_version`). */
  reviewLevel?: 'full' | 'light' | null;
  reviewReasons?: string[];
  rejection?: { rule: string | null; code: string | null; notes: string | null; findings: Finding[] } | null;
  checks?: SubmissionChecks | null;
  notes?: { body: string; author: string; createdAt: string }[];
  release?: { channel: string; percent: number } | null;
}

/** `submission.checks`: the automatic check report (`OlanAppCheckReport`), null while checking. */
export interface SubmissionChecks {
  version?: number;
  passed?: boolean;
  startedAt?: string;
  finishedAt?: string;
  usage?: { rpcMethods: string[]; permissionsUsed: string[]; permissionsUnused: string[]; httpHosts: string[] };
  checks?: { id: string; status?: 'passed' | 'warning' | 'failed' | 'skipped'; durationMs?: number; findings: Finding[] }[];
}

export interface Finding {
  code: string;
  severity?: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  hint?: string;
  rule?: string;
}

export function sessionPath(env: NodeJS.ProcessEnv): string {
  return join(env.USERPROFILE || env.HOME || homedir(), '.olan', 'marketplace.json');
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Throws a failure that `--json` prints as the marketplace-style `{ error, message, hint? }`. */
export function marketplaceFail(code: string, message: string, hint?: string): never {
  throw new CliError(issue(`marketplace.${code}`, message, { hint }), undefined, { error: code, message, ...(hint ? { hint } : {}) });
}

/** `OLAN_MARKETPLACE_SESSION` (the session JSON or the bare `olan_dev_…` token), else the session file. */
export function loadSession(env: NodeJS.ProcessEnv): LoadedSession | null {
  const fromEnv = env.OLAN_MARKETPLACE_SESSION?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith('{')) {
      let parsed: Partial<MarketplaceSession>;
      try {
        parsed = JSON.parse(fromEnv) as Partial<MarketplaceSession>;
      } catch {
        marketplaceFail('session_invalid', 'OLAN_MARKETPLACE_SESSION is not valid JSON', 'Set it to the contents of ~/.olan/marketplace.json or to the session token alone.');
      }
      if (typeof parsed.token !== 'string' || !parsed.token) marketplaceFail('session_invalid', 'OLAN_MARKETPLACE_SESSION has no token');
      return { session: { ...parsed, token: parsed.token }, source: 'env' };
    }
    return { session: { token: fromEnv }, source: 'env' };
  }
  const path = sessionPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MarketplaceSession>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    return { session: { ...parsed, token: parsed.token }, source: 'file' };
  } catch {
    return null;
  }
}

/**
 * Writes the session file with mode 0600. On Windows file modes do not apply; the file is
 * restricted to the current user with `icacls` on a best-effort basis (the user profile is
 * already private by default).
 */
export function saveSession(env: NodeJS.ProcessEnv, session: MarketplaceSession): string {
  const path = sessionPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  if (process.platform === 'win32' && env.USERNAME) {
    try {
      execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${env.USERNAME}:F`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    } catch {
      // best effort
    }
  }
  return path;
}

/** The Olan server named by OLAN_SERVER, else OLAN_API_URL (`olan app` sets both). */
export function serverFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.OLAN_SERVER?.trim() || env.OLAN_API_URL?.trim() || undefined;
}

/** The marketplace an Olan server uses (`marketplaceUrl` of its `/.well-known/olan`), or null. */
export async function serverMarketplaceUrl(server: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${normalizeUrl(server)}/.well-known/olan`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { marketplaceUrl?: unknown };
    return typeof body.marketplaceUrl === 'string' && /^https?:\/\/[^/]+/i.test(body.marketplaceUrl) ? body.marketplaceUrl : null;
  } catch {
    return null;
  }
}

export interface MarketplaceUrlOptions {
  /** The saved session (its marketplace is used before the server's). */
  session?: Partial<MarketplaceSession> | null;
  /** The Olan server (`--server`, else OLAN_SERVER / OLAN_API_URL). */
  server?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The marketplace address, first of: `--marketplace <url>`, OLAN_MARKETPLACE_URL, the saved
 * session's marketplace, the Olan server's `/.well-known/olan` `marketplaceUrl` (when a server is
 * known), https://marketplace.olan.app.
 */
export async function resolveMarketplaceUrl(flag: string | boolean | undefined, env: NodeJS.ProcessEnv, options: MarketplaceUrlOptions = {}): Promise<string> {
  let value = (typeof flag === 'string' ? flag : undefined) || env.OLAN_MARKETPLACE_URL?.trim() || options.session?.url;
  if (!value) {
    const server = options.server ?? serverFromEnv(env);
    if (server) value = (await serverMarketplaceUrl(server, options.fetchImpl)) ?? undefined;
  }
  value ||= DEFAULT_MARKETPLACE_URL;
  const url = normalizeUrl(value);
  if (!/^https?:\/\/[^/]+/i.test(url)) marketplaceFail('invalid_url', `${value} is not an http(s) URL`);
  return url;
}

const LOGIN_HINT = 'Sign in with `olan-app login --marketplace` (CI: set OLAN_MARKETPLACE_SESSION).';
export const CREATE_DEVELOPER_HINT = 'Create one with `olan-app developer create --marketplace --slug <slug> --name <name> --accept-agreement` (or accept an invite), then publish again.';

/** The session for `url`, or a failure that says how to sign in. */
export async function requireSession(flag: string | boolean | undefined, env: NodeJS.ProcessEnv): Promise<{ url: string; session: LoadedSession['session']; source: LoadedSession['source'] }> {
  const loaded = loadSession(env);
  const url = await resolveMarketplaceUrl(flag, env, { session: loaded?.session, server: loaded?.session.server });
  if (!loaded) marketplaceFail('session_missing', `You are not signed in to ${url}`, LOGIN_HINT);
  const { session } = loaded;
  if (session.url && normalizeUrl(session.url) !== url) {
    marketplaceFail('session_other_marketplace', `The saved session is for ${normalizeUrl(session.url)}, not ${url}`, `Run \`olan-app login --marketplace ${url}\`.`);
  }
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    marketplaceFail('session_expired', `The marketplace session expired at ${session.expiresAt}`, LOGIN_HINT);
  }
  return { url, session, source: loaded.source };
}

const HINTS: Record<string, string> = {
  developer_sign_in_required: `The marketplace session is missing, expired or signed out. ${LOGIN_HINT}`,
  identity_invalid: 'The Olan server\'s identity token did not verify; sign in to Olan again (`olan auth login`) and retry.',
  identity_untrusted_issuer: 'The marketplace does not trust your Olan server yet; sign in through olan.app, or have your administrator verify the server with the marketplace.',
  package_invalid: 'Fix the package issues above (`olan-app validate --strict`) and publish again.',
  version_exists: 'This version is already on the marketplace; bump "version" in olan-app.json.',
  version_not_increasing: 'Versions only go up: raise "version" in olan-app.json above the latest submitted version.',
  age_rating_required: 'Set the app\'s age rating (4+, 9+ or 13+) with `olan-app app set --marketplace <appId> --age-rating 4+` (or Studio → Yayınla → the app → Mağaza sayfası), then release again.',
  age_rating_not_allowed: 'Olan is rated 13+; apps rated 16+ or 18+ are not accepted (guideline 5.4).',
  app_owned_by_other_developer: 'Another developer account owns this app id: change "id" in olan-app.json, or pass --developer <slug> of the account that owns it.',
  app_id_reserved: 'com.olan.*, app.olan.* and olan.* ids belong to Olan\'s own developer account; choose another "id".',
  agreement_required: 'Accept the current developer agreement: `olan-app developer create … --accept-agreement` for a new account; for an existing one in Studio → Yayınla (developer account).',
  developer_not_found: 'You are not a member of that developer account; check --developer (`olan-app developer list` lists yours).',
  developer_exists: 'That developer name is taken (names starting with olan are reserved); choose another --slug.',
  developer_account_missing: CREATE_DEVELOPER_HINT,
  developer_role_required: 'Your role in the developer account does not allow this; ask an owner or admin.',
  package_too_large: 'The package is over the marketplace limit; remove large assets and pack again.',
  server_not_found: 'The serverId in --visibility is not registered with the marketplace (Olan → Yönetim → Uygulamalar → Marketplace).',
  server_not_verified: 'Organization-only apps need a server that proved ownership of its address to the marketplace.',
  organization_not_allowed: 'Sign in through that organization\'s Olan server as an administrator or developer (`olan-app login --marketplace`).',
  app_not_found: 'No app with this id in your developer accounts; check the id or publish it first.',
  version_not_found: 'No such version of the app; `olan-app status --marketplace <appId>` shows the latest.',
  rate_limited: 'Too many requests; wait a minute and retry.',
  rollout_invalid: 'A rollout only widens (e.g. 10 → 50 → 100) and only for a released version; `olan-app halt` stops new installs, a new version replaces it.',
  review_state_conflict: 'Only approved versions can be released; `olan-app status --marketplace <appId> <version>` shows the review state.',
  app_not_active: 'The app is suspended or removed on the marketplace; contact Olan App Review.',
  package_revoked: 'Olan revoked this version; publish a fixed version.',
  submission_not_found: 'This version has no submission (it was not submitted with `olan-app publish --marketplace`).',
  submission_state_conflict: 'Only a submission that is being checked or reviewed can be withdrawn or get a test report; `olan-app status --marketplace <appId> <version>` shows its state.',
  test_report_invalid: 'Generate the report again with `olan-app test --report <file>` and do not edit it.',
  test_report_signature_invalid: 'The report changed after it was signed; generate it again with `olan-app test --report <file>`.',
  test_report_mismatch: 'The report belongs to another package: run `olan-app test --report <file>` after packing, on the same sources you publish (same digest.package).',
  invalid_request: 'The marketplace refused the request parameters; check the command options (`olan-app <command> --help`).',
};

/** Turns a marketplace error body into CLI issues; `--json` prints the body unchanged. */
export function marketplaceError(status: number, body: Record<string, unknown> | null, url: string): CliError {
  const code = typeof body?.error === 'string' ? body.error : `http_${status}`;
  const message = typeof body?.message === 'string' ? body.message : `${url} answered ${status}`;
  const issues: Issue[] = [issue(`marketplace.${code}`, message, { hint: HINTS[code] ?? (status === 401 ? HINTS.developer_sign_in_required : undefined) })];
  if (code === 'package_invalid' && Array.isArray(body?.issues)) {
    for (const item of body.issues as { code?: string; path?: string; message?: string; hint?: string }[]) {
      issues.push(issue(item.code ?? 'package.invalid', item.message ?? 'The marketplace rejected the package', { file: item.path?.split('#')[0] || undefined, hint: item.hint }));
    }
  }
  return new CliError(issues, undefined, body ?? { error: code, message });
}

export interface RequestOptions {
  method?: string;
  token?: string;
  json?: unknown;
  form?: FormData;
  fetchImpl?: typeof fetch;
}

/** One marketplace call; non-2xx answers become `marketplaceError`s. */
export async function marketplaceRequest<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: FormData | string | undefined;
  if (options.form) body = options.form;
  else if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const target = `${base}${path}`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(target, { method: options.method ?? 'GET', headers, body, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    marketplaceFail('network', `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`, 'Check --marketplace (or OLAN_MARKETPLACE_URL) and your connection.');
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw marketplaceError(response.status, parsed, base);
  return parsed as T;
}

/**
 * The developer account to act for: `explicit` (--developer), else the only account the caller
 * belongs to; with several accounts the caller must choose (`example` shows how).
 */
export async function pickDeveloper(url: string, token: string, explicit: string | undefined, example: (slug: string) => string, log?: (line: string) => void): Promise<string> {
  if (explicit) return explicit;
  const me = await marketplaceRequest<{ developers: { slug: string }[] }>(url, '/api/v1/developer/me', { token });
  const slugs = (me.developers ?? []).map((entry) => entry.slug);
  if (slugs.length === 1) {
    log?.(`Developer account: ${slugs[0]}`);
    return slugs[0]!;
  }
  if (slugs.length === 0) marketplaceFail('developer_account_missing', 'You do not belong to a developer account on the marketplace', CREATE_DEVELOPER_HINT);
  return marketplaceFail('developer_required', `You belong to several developer accounts: choose one with --developer (${slugs.join(', ')})`, example(slugs[0]!));
}

/**
 * Whether one of the signed-in developer's accounts registered `publicKey` (`registered`), or null
 * when that cannot be told (no or expired session, marketplace unreachable). Best effort, 5 s per call.
 */
export async function keyRegistration(env: NodeJS.ProcessEnv, publicKey: string, fetchImpl: typeof fetch = fetch): Promise<{ registered: boolean; developer?: string } | null> {
  try {
    const loaded = loadSession(env);
    if (!loaded) return null;
    const { session } = loaded;
    if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return null;
    const url = normalizeUrl(env.OLAN_MARKETPLACE_URL?.trim() || session.url || '');
    if (!/^https?:\/\/[^/]+/i.test(url) || (session.url && normalizeUrl(session.url) !== url)) return null;
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetchImpl(`${url}${path}`, { headers: { accept: 'application/json', authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`${response.status}`);
      return (await response.json()) as T;
    };
    const me = await get<{ developers?: { slug: string }[] }>('/api/v1/developer/me');
    for (const developer of me.developers ?? []) {
      const { keys } = await get<{ keys?: { publicKey: string }[] }>(`/api/v1/developer/accounts/${encodeURIComponent(developer.slug)}/keys`);
      if (keys?.some((key) => key.publicKey === publicKey)) return { registered: true, developer: developer.slug };
    }
    return { registered: false };
  } catch {
    return null;
  }
}

/** The `--marketplace [url]` flag a marketplace-only command requires. */
export function requireMarketplaceFlag(flag: string | boolean | undefined, usage: string): string | true {
  if (flag === undefined || flag === false) marketplaceFail('target_required', 'This command talks to Olan Marketplace: pass --marketplace [url]', usage);
  return flag;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll interval: OLAN_MARKETPLACE_POLL_MS (tests), else 5 s. */
export function pollInterval(env: NodeJS.ProcessEnv): number {
  const value = Number(env.OLAN_MARKETPLACE_POLL_MS);
  return Number.isFinite(value) && value > 0 ? value : POLL_INTERVAL_MS;
}

export interface VersionStatus {
  version: { version: string; reviewState?: string; channel?: string | null; releaseState?: string | null } & Record<string, unknown>;
  submission: SubmissionView | null;
}

export function versionPath(appId: string, version: string): string {
  return `/api/v1/developer/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(version)}`;
}

/** Polls the version status while `pending(state)` holds (and `deadline` is not reached). */
export async function waitForSubmission(
  base: string,
  token: string,
  appId: string,
  version: string,
  options: { pending: (state: string) => boolean; intervalMs: number; deadline?: number; log?: (line: string) => void; fetchImpl?: typeof fetch },
): Promise<VersionStatus> {
  for (;;) {
    const status = await marketplaceRequest<VersionStatus>(base, versionPath(appId, version), { token, fetchImpl: options.fetchImpl });
    const state = status.submission?.state ?? '';
    if (!options.pending(state) || (options.deadline !== undefined && Date.now() >= options.deadline)) return status;
    options.log?.(`  ${state === 'checking' ? 'Automatic checks are running' : 'In review'}…`);
    await sleep(options.intervalMs);
  }
}

/** Every finding to show: the rejection's, else the failed checks' errors and warnings. */
export function submissionFindings(submission: SubmissionView): Finding[] {
  if (submission.rejection?.findings?.length) return submission.rejection.findings;
  return (submission.checks?.checks ?? []).flatMap((check) => check.findings).filter((finding) => finding.severity === 'error' || finding.severity === 'warning');
}

/** The real release command for a submission (`url` omitted when it is not known). */
export function releaseCommandFor(submission: Pick<SubmissionView, 'appId' | 'version'>, url?: string): string {
  return `olan-app release --marketplace${url ? ` ${url}` : ''} ${submission.appId} ${submission.version}`;
}

/** What to do next, by the marketplace's `nextAction`. */
export function nextActionText(submission: SubmissionView, url?: string): string {
  switch (submission.nextAction) {
    case 'wait':
      return submission.state === 'checking' ? 'wait: the automatic checks are running' : 'wait: Olan App Review is reviewing it';
    case 'fix_and_resubmit':
      return 'fix the findings and publish again with `olan-app publish --marketplace` (a rejected or failed version number may be reused)';
    case 'release':
      return `release it: \`${releaseCommandFor(submission, url)}\` (stable at 100% by default; --channel beta or --percent N for a staged rollout; or Studio → Yayınla)`;
    case 'resubmit':
      return 'publish again with `olan-app publish --marketplace`';
    case 'none':
      return 'nothing: it is released';
    default:
      return submission.nextAction ?? '';
  }
}

/** `  Checks: passed (manifest passed, size passed, …)` — one line per report. */
function checksLine(checks: SubmissionChecks | null | undefined): string[] {
  if (!checks?.checks?.length) return [];
  const verdict = checks.passed === false ? 'failed' : 'passed';
  return [`  Checks: ${verdict} (${checks.checks.map((check) => `${check.id} ${check.status ?? (check.findings.some((finding) => finding.severity === 'error') ? 'failed' : 'passed')}`).join(', ')})`];
}

/**
 * The summary of a submission: state, checks per id, review level and reasons, the next action
 * (with the real command), the release asked for on approval.
 */
export function submissionHeader(submission: SubmissionView, url?: string): string[] {
  const lines = [`  State: ${submission.state}`, ...checksLine(submission.checks)];
  if (submission.reviewLevel) {
    lines.push(`  Review: ${submission.reviewLevel}${submission.reviewReasons?.length ? ` (${submission.reviewReasons.join(', ')})` : ''}`);
  }
  if (submission.nextAction) lines.push(`  Next: ${nextActionText(submission, url)}`);
  if (submission.release) lines.push(`  Release on approval: ${submission.release.channel} ${submission.release.percent}%`);
  return lines;
}

/** Human lines for a submission: the header, then the rejection and findings with their path. */
export function describeSubmission(submission: SubmissionView, url?: string): string[] {
  const lines = submissionHeader(submission, url);
  const rejection = submission.rejection;
  if (rejection && (rejection.rule || rejection.code || rejection.notes)) {
    lines.push(`  Rejected: ${[rejection.rule ? `guideline ${rejection.rule}` : null, rejection.code].filter(Boolean).join(' · ')}${rejection.notes ? `: ${rejection.notes}` : ''}`);
  }
  for (const finding of submissionFindings(submission)) {
    lines.push(`  ${finding.severity ?? 'error'} ${finding.path ? `${finding.path} ` : ''}${finding.code}: ${finding.message}${finding.rule ? ` (guideline ${finding.rule})` : ''}`);
    if (finding.hint) lines.push(`    hint: ${finding.hint}`);
  }
  for (const note of submission.notes ?? []) lines.push(`  Reviewer note: ${note.body}`);
  return lines;
}

/** Failure issues for `checks_failed` / `rejected` (human mode; `--json` prints the state itself). */
export function submissionIssues(submission: SubmissionView): Issue[] {
  const rejection = submission.rejection;
  const head = submission.state === 'checks_failed'
    ? issue('marketplace.checks_failed', `${submission.appId} ${submission.version} did not pass the automatic checks`, { hint: 'Fix the findings below and publish again (the same version number may be reused).' })
    : issue('marketplace.rejected', `${submission.appId} ${submission.version} was rejected${rejection?.rule ? ` under guideline ${rejection.rule}` : ''}${rejection?.code ? ` (${rejection.code})` : ''}${rejection?.notes ? `: ${rejection.notes}` : ''}`, {
      hint: 'Address the review notes and publish again (the same version number may be reused).',
    });
  return [
    head,
    ...submissionFindings(submission).filter((finding) => (finding.severity ?? 'error') === 'error').map((finding) => issue(finding.code, finding.message, { file: finding.path?.split('#')[0] || undefined, hint: finding.hint })),
  ];
}
