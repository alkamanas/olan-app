# Olan App Review Guidelines (summary)

Every app submitted to Olan Marketplace follows these rules, public and organization-only apps alike. Rule numbers are stable: automatic check findings (`rule`), rejections (`rejection.rule` in `olan-app status --json`) and `validate --strict` findings (`(guideline 2.1)`) cite them.

## How review works

- **Automatic checks first** (minutes; marketplace.md#automatic-checks). Any `error` finding ends the submission as `checks_failed` without a human review: fix it and publish again.
- **A person reviews every version**; nothing is approved automatically, organization-only apps included. **Full review**: the first version, a version that asks for a new permission or host, an unverified developer, security findings (1.x). **Light review**: everything else (`reviewLevel`, `reviewReasons`).
- **Store page changes** (listing text, age rating, category, links) of a live public app go live after a quick review (7.x; `olan-app app set` prints "in review"); for organization-only apps they apply at once.
- **Approval signs** the package with the Olan Marketplace key; Olan can stop a signed app on every server (revocation list).
- **A rejection names the rule.** A rejected or `checks_failed` version was never signed, so its version number may be submitted again; an approved or released number may not.

## Rules

| Rule | What it means | Typical findings | Typical fix |
|---|---|---|---|
| 1.1 No obfuscation | Minified code is fine; deliberately obscured code, encrypted or encoded payloads and code decoded at run time are not | `obfuscation.*` | Ship the plain output of `olan-app build` |
| 1.2 No dynamic code | No `eval`, `new Function`, dynamic `import()` or downloaded code: the behaviour is in the reviewed package | `forbidden.eval`, `forbidden.function_constructor`, `forbidden.dynamic_import` | Static imports; data, not code, from the network |
| 1.3 No native binaries | Only JavaScript, JSON, images and text (`.so`, `.dex`, `.jar`, `.wasm`, `.hbc`, `.node`, `.exe`, `.dylib` are refused) | `files.native_binary`, `files.type_not_allowed` | Remove them from `assets/` |
| 1.4 Only `olan.*` | No direct `fetch`, `XMLHttpRequest`, `WebSocket`, DOM, `localStorage`, `navigator` or sandbox escapes; device APIs (location, camera, contacts) are not available | `forbidden.fetch`, `forbidden.dom`, `forbidden.browser_storage`, `surfaces.unknown_method` | `olan.http.fetch`, `olan.storage`, SDK components (api.md) |
| 1.5 No mining or abuse | The app does not use the device or the Olan server for anything but its purpose | `forbidden.crypto_mining` | Remove it |
| 2.1 Least privilege | Every permission backs a visible feature; no unused permissions; `*:delete` never deletes without asking the person | `permissions.missing`, `permissions.unused` | Declare what you call, drop the rest; `olan.ui.confirm` before deleting (examples.md#confirm-before-a-destructive-action) |
| 2.2 Honest data-use declaration | The store page's data declaration (data, purposes, third parties) matches what the app does | Reviewer | Update the listing in Studio → Yayınla |
| 2.3 Justified network access | `http:<host>` only for hosts the app's job needs, each named in the declaration; no personal data leaves Olan without consent | `permissions.http_missing`, `permissions.http_unused`, `permissions.http_hosts` (info) | Grant only the hosts you fetch; explain each in the listing |
| 2.4 KVKK and GDPR | Apps that process personal data give a privacy policy URL and honour deletion and export requests; sensitive data (health, ID numbers) needs a separate justification | Reviewer | `olan-app app set --marketplace <appId> --privacy-url <https url>` |
| 3.1 Every surface opens | Each declared surface opens with sample data without errors | `surfaces.*` | `olan-app validate --strict`; render an `EmptyState` rather than nothing |
| 3.2 Headless tests | Your `olan-app test` suites pass; a signed test report (key registered with the account) shows reviewers your results, failures included | `interaction.developer_tests_unavailable`, `interaction.developer_tests_reported` (info) | `olan-app test --report r.json`, `publish --marketplace --test-report r.json` (marketplace.md#signed-test-reports) |
| 3.3 No crash on interaction | Pressing buttons and submitting forms raises no error; failures show the person a clear message | `interaction.app_error` | Catch failures; show a toast or an `EmptyState` |
| 4.1 Labelled controls | Every button, menu, menu item, action and form field has a label | `a11y.button_label_missing`, `a11y.field_label_missing`, `a11y.action_label_missing`, `a11y.menu_item_label_missing` | Give each a `label`, even with an icon |
| 4.2 Image descriptions | Meaningful images have alternative text | `a11y.image_alt_missing` | Add `alt` |
| 5.1 Not misleading | Name, description, screenshots and the app tell the same story | Reviewer; `manifest.description_template` (warning) | Write your own `description` |
| 5.2 Not impersonating Olan | No Olan name, logo or design imitation; `com.olan.*`, `app.olan.*`, `olan.*` ids are Olan's | `app_id_reserved` | Choose your own id and branding |
| 5.3 User content | Apps that show user or AI-generated content offer filtering, reporting and blocking | Reviewer | Add those controls |
| 5.4 Correct age rating | 4+, 9+ or 13+ matching the content; Olan is rated 13+, so 16+ and 18+ apps are not accepted. Required before release | `age_rating_required`, `age_rating_not_allowed` | `olan-app app set --marketplace <appId> --age-rating 4+` (or Studio) |
| 6.1 License notices kept | Notices of bundled third-party code stay in the package | `licenses.notices_missing` (info) | `olan-app build` keeps them; more in `assets/NOTICE` |
| 6.2 Copyleft reviewed | GPL, AGPL, LGPL, SSPL code is reviewed separately | `licenses.copyleft` (warning) | Explain it in the review notes, or replace it |
| 7.1 Accurate store page | Screenshots are from the real app; the description is complete in TR or EN | Reviewer | Studio → Yayınla → store page |
| 7.2 Working support and privacy links | Both open and belong to the app | Reviewer | `olan-app app set --marketplace <appId> --support-url … --privacy-url …` |
| 8.1 Organization-only apps | The same rules and a person reviews every version; only visibility differs and store page changes apply without review. The submitter signs in through that organization's verified Olan server as an admin or developer | `organization_not_allowed`, `server_not_verified` | `olan-app login --marketplace --server <that server>` |

Every app page has "Bildir" (report); Olan may revoke a version or the whole app after a report and tells the developer why. Legal terms (developer agreement, data processing) are separate documents.
