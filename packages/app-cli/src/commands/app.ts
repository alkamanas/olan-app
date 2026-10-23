import { stringFlag, type ParsedArgs } from '../args';
import type { Command } from '../command';
import { marketplaceFail, marketplaceRequest, requireMarketplaceFlag, requireSession } from '../marketplace';

/*
 * Store settings of a marketplace app (contract §22): `PATCH /api/v1/developer/apps/:appId` sets the
 * category, age rating, platforms and support/privacy links. For an app that is already live in the
 * public store the change goes to review first (202 `{ pendingChange }`); otherwise it applies at
 * once. A version cannot be released before the app has an age rating (`age_rating_required`).
 */

/** Age ratings the marketplace accepts (Olan itself is rated 13+; 16+ and 18+ are refused, guideline 5.4). */
export const AGE_RATINGS = ['4+', '9+', '13+'] as const;
const PLATFORMS = ['web', 'desktop', 'ios', 'android'] as const;

/** The developer app view (only what the human output reads; `--json` prints the whole answer). */
export interface StoreSettingsView {
  id: string;
  category?: string;
  ageRating?: string | null;
  platforms?: string[];
  visibility?: unknown;
  supportUrl?: string | null;
  privacyPolicyUrl?: string | null;
}

/** `PATCH …/apps/:appId` answer: 200 `{ app }`, or 202 `{ app, pendingChange }` for a live public app. */
export interface StoreSettingsAnswer {
  app: StoreSettingsView;
  pendingChange?: { id: string; state: string; createdAt: string } | null;
}

/** Validates `--age-rating`; 16+ and 18+ fail the way the marketplace would. */
export function ageRatingValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if ((AGE_RATINGS as readonly string[]).includes(value)) return value;
  if (value === '16+' || value === '18+') {
    marketplaceFail('age_rating_not_allowed', `Olan is rated 13+; apps rated ${value} are not accepted (guideline 5.4)`, 'Choose 4+, 9+ or 13+.');
  }
  return marketplaceFail('invalid_option', `--age-rating must be ${AGE_RATINGS.join(', ')}`);
}

/** Sends the store settings change and returns the answer and its human lines. */
export async function setStoreSettings(url: string, token: string, appId: string, change: Record<string, unknown>): Promise<{ answer: StoreSettingsAnswer; lines: string[] }> {
  const answer = await marketplaceRequest<StoreSettingsAnswer>(url, `/api/v1/developer/apps/${encodeURIComponent(appId)}`, { method: 'PATCH', token, json: change });
  const fields = Object.entries(change).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(',') : String(value)}`).join(', ');
  const lines = answer.pendingChange
    ? [`Store settings of ${appId} sent to review (${fields}): the app is live, so Olan App Review approves the change first (change ${answer.pendingChange.id}, in review).`]
    : [`Store settings of ${appId} saved on ${url}: ${fields}`];
  return { answer, lines };
}

function settingsLines(app: StoreSettingsView, url: string): string[] {
  const visibility = typeof app.visibility === 'string' ? app.visibility : app.visibility ? JSON.stringify(app.visibility) : 'public';
  return [
    `  Category: ${app.category ?? 'not set'}`,
    `  Age rating: ${app.ageRating ?? `not set (required before release: olan-app app set --marketplace ${url} ${app.id} --age-rating 4+|9+|13+)`}`,
    `  Platforms: ${app.platforms?.length ? app.platforms.join(', ') : 'not set'}`,
    `  Visibility: ${visibility}`,
    `  Support URL: ${app.supportUrl ?? 'not set'}`,
    `  Privacy policy URL: ${app.privacyPolicyUrl ?? 'not set'}`,
  ];
}

function changeFromArgs(args: ParsedArgs): Record<string, unknown> {
  const change: Record<string, unknown> = {};
  const ageRating = ageRatingValue(stringFlag(args, 'age-rating'));
  if (ageRating !== undefined) change.ageRating = ageRating;
  const category = stringFlag(args, 'category');
  if (category !== undefined) change.category = category;
  const platforms = stringFlag(args, 'platforms');
  if (platforms !== undefined) {
    const list = platforms.split(',').map((item) => item.trim()).filter(Boolean);
    const unknown = list.filter((item) => !(PLATFORMS as readonly string[]).includes(item));
    if (!list.length || unknown.length) marketplaceFail('invalid_option', `--platforms takes a comma-separated list of ${PLATFORMS.join(', ')}${unknown.length ? ` (not: ${unknown.join(', ')})` : ''}`);
    change.platforms = [...new Set(list)];
  }
  for (const [flag, key] of [['support-url', 'supportUrl'], ['privacy-url', 'privacyPolicyUrl']] as const) {
    const value = stringFlag(args, flag);
    if (value === undefined) continue;
    if (value !== '' && !/^https:\/\/[^/]+/i.test(value)) marketplaceFail('invalid_option', `--${flag} must be an https:// URL (or "" to clear it)`);
    change[key] = value === '' ? null : value;
  }
  return change;
}

const USAGE = [
  'olan-app app show --marketplace [url] <appId>',
  '       olan-app app set --marketplace [url] <appId> [--age-rating 4+|9+|13+] [--category <id>]',
  '                    [--platforms web,desktop,ios,android] [--support-url <https url>] [--privacy-url <https url>]',
].join('\n');

export const appCommand: Command = {
  name: 'app',
  summary: 'Show or change a marketplace app\'s store settings (age rating, category, platforms, links)',
  usage: USAGE,
  options: [
    'show                 The app\'s store settings on the marketplace',
    'set                  Change them; for an app already live in the store the change is reviewed first',
    '--age-rating <r>     4+, 9+ or 13+ (required before `olan-app release`; 16+ and 18+ are not accepted)',
    '--category <id>      productivity, project-management, sales, marketing, hr, finance, communication,',
    '                     developer-tools, ai or other',
    '--platforms <list>   Comma-separated: web, desktop, ios, android',
    '--support-url <url>  Support page (https; "" clears it)',
    '--privacy-url <url>  Privacy policy (https; "" clears it)',
    '--marketplace [url]  Marketplace address (default: OLAN_MARKETPLACE_URL, the session\'s, https://marketplace.olan.app)',
    '',
    'Needs `olan-app login --marketplace` (or OLAN_MARKETPLACE_SESSION) and the developer role in the app\'s',
    'developer account. Studio → Yayınla → the app → Mağaza sayfası changes the same fields. --json prints the',
    'marketplace answer unchanged ({ app } or, while in review, { app, pendingChange }).',
  ],
  spec: { optionalUrls: ['marketplace'], strings: ['age-rating', 'category', 'platforms', 'support-url', 'privacy-url'] },
  async run(args, context) {
    const [action, appId, extra] = args.positionals;
    if (action !== 'show' && action !== 'set') marketplaceFail('action_required', 'Choose an action: olan-app app show|set', 'olan-app app set --marketplace <appId> --age-rating 4+');
    if (!appId || extra !== undefined) marketplaceFail('app_required', `Which app? ${USAGE.split('\n')[action === 'show' ? 0 : 1]!.trim()}`);
    const change = action === 'set' ? changeFromArgs(args) : {};
    if (action === 'show' && ['age-rating', 'category', 'platforms', 'support-url', 'privacy-url'].some((flag) => stringFlag(args, flag) !== undefined)) {
      marketplaceFail('invalid_option', 'app show takes no settings; use `olan-app app set`');
    }
    if (action === 'set' && Object.keys(change).length === 0) {
      marketplaceFail('invalid_option', 'app set needs at least one setting', `olan-app app set --marketplace ${appId} --age-rating 4+`);
    }
    const flag = requireMarketplaceFlag(args.flags.marketplace, USAGE);
    const { url, session } = await requireSession(flag, context.env);

    if (action === 'show') {
      const shown = await marketplaceRequest<{ app: StoreSettingsView }>(url, `/api/v1/developer/apps/${encodeURIComponent(appId)}`, { token: session.token });
      return { result: shown, raw: true, human: [`${appId} on ${url}:`, ...settingsLines(shown.app, url)] };
    }
    const { answer, lines } = await setStoreSettings(url, session.token, appId, change);
    return { result: answer, raw: true, human: answer.pendingChange ? lines : [...lines, ...settingsLines(answer.app, url)] };
  },
};
