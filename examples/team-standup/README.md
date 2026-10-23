# Team Standup

The Olan Apps Phase 3 example (`com.olan.examples.team-standup`): in-context surfaces, a chat card,
signed events and assistant tools served by the app's own server (`remote`).

| Where | What |
|---|---|
| `app` | Projects with open and overdue task counts |
| `chat.action` "Standup'a ekle" | Turns a chat message into a task of the chosen project ("Göreve çevir", `tasks:write`) |
| `chat.command` `/standup` | Posts "Bugünün standup'ı" into the chat ("Kartı gönder", `chat:write`); the card's "Tamamladım" button goes to the app server, which answers the card with a "Tamamlandı" badge |
| `calendar.event.action` "Standup notu" | "Not ekle" writes a note on the event (`calendar:write`); "Takip etkinliği oluştur ve sil" creates and deletes a follow-up event (`calendar:delete`); "Bu etkinliği sil" tries to delete the event itself, which Olan refuses for Olan meetings and project calendar events (toast "Bu kayıt korunuyor: system_record", audited) |
| `mail.action` "Standup'a ekle" | Turns the open email into a task of the chosen project: title = subject, description = sender + the email's text (`olan.mail.getMessage`, `mail:read`; without it only the sender) ("Göreve çevir", `tasks:write`) |
| `mail.sidebar` "Standup" | Panel beside the email: "Konu: …", sender, the first lines of its text and the attachment count (`mail:read`), and the same "Göreve çevir"; follows the panel to the next email |
| `meeting.panel` "Standup" | Panel in the meeting room: "Toplantı: …", the participant count (`olan.meetings.get`, `meetings:read`), the open tasks of the meeting's project (or the chosen one) and "Görev ekle" (a task from the meeting) |
| `events` | `project.task.created`, `chat.message.created` (+ the always-sent `app.*`) to `remote.url/events` |
| `ai.tools` | `standup_summary` (read-only, `projects:read`), exposed to the assistant as `app_teamstandup_standup_summary`: runs at once. `standup_add_task` (`projects:read`, `tasks:write`, not read-only), `app_teamstandup_standup_add_task`: the assistant shows an `app_tool` confirmation card and the app server runs it only after "Onayla" |

`remote.url` is `http://127.0.0.1:4417/olan`, `remote.jwksUrl` `http://127.0.0.1:4417/.well-known/jwks.json`:
a local Olan delivers to them only for development installations with `OLAN_APPS_REMOTE_ALLOW_PRIVATE=1`.

```sh
npm install
npm run validate                 # olan-app validate --strict
npm test                         # olan-app test: surfaces (mock host) and the app server (in-process, fake issuer)
npx olan-app pack --dev-sign     # dist/com.olan.examples.team-standup-0.2.0.olanapp for a local Olan trusting your dev key
```

## The app server (`remote-server/`)

```sh
node remote-server/server.ts     # Node ≥ 22.18 (24 recommended): runs the TypeScript directly
```

| Env | Default | |
|---|---|---|
| `PORT` | `4417` | Listens on `127.0.0.1` |
| `OLAN_ISSUERS` | `http://localhost:4000` | Comma-separated Olan servers it accepts (`olan-issuer`); add `http://127.0.0.1:5180` for `olan-app events send` / `tools call` |
| `STANDUP_DATA_DIR` | `remote-server/.data` | `app-key.json` (the app's Ed25519 key, made on the first start, reused) and `received.jsonl` |

Routes:

- `GET /.well-known/jwks.json`: the app's public key (`private_key_jwt` client assertions).
- `POST /olan/events`: verified with `@olan-app/sdk/server` (issuer allowlist → `kid` → Ed25519 → ±5 min),
  each `webhook-id` processed once.
- `POST /olan/ai-tools/standup_summary`: input `{ projectId? }`; reads `GET <issuer>/api/v2/projects[/:id]`
  with the embedded token (on 401 once more with `getInstallationToken({ userId })`); answers
  `{ result: { today, projects: [{ id, name, open, overdue, completedToday, tasks }] }, summary: "<n> açık, <m> gecikmiş görev" }`,
  or `project_not_found`.
- `POST /olan/ai-tools/standup_add_task`: input `{ projectId, title, description? }`; reads the project, then
  `POST <issuer>/api/v2/projects/:id/tasks` in its default (else first) work package with a creation key taken from the call id
  (a repeated call creates the task once); answers `{ result: { projectId, taskId, title }, summary: "\"<title>\" <project> projesine eklendi" }`,
  or `invalid_input`, `project_not_found`, `no_work_package`, `permission_denied`.
- `POST /olan/card-actions`: `done` → the completed card and a toast.

Test controls (the end-to-end test uses them; no secrets, no message content beyond event `data`):

| Route | |
|---|---|
| `GET /health` | `{ ok, jwksUrl, keyId }` |
| `GET /__test/log` | `{ entries }`, the parsed `received.jsonl`: `event` (`webhookId, type, installationId, attempt, timestamp, data`), `rejected` (`path, status, error`: `invalid_signature`, `timestamp_out_of_range`, `issuer_not_allowed`, `unknown_key`, `missing_header`, …), `duplicate`, `failed_on_purpose`, `tool_call` (`callId, tool, channel, userId`), `card_action` (`name, messageId`), `app_identity` |
| `POST /__test/fail` | `{ count, status? = 500, type? }`: the next `count` verified event deliveries (only of `type`, when given) answer `status` and are not marked seen, so Olan's retry is processed |
| `POST /__test/reset` | Clears the log and pending failures |
| `POST /__test/app-identity` | `{ issuer, installationId, path }`: an app-identity token (no person), then `GET <issuer><path>` with it → `{ tokenOk, status, body }` (a project the app was not added to answers 403) |

Try it against the CLI's local issuer:

```sh
OLAN_ISSUERS=http://127.0.0.1:5180 node remote-server/server.ts &
npx olan-app events send project.task.created
npx olan-app tools call standup_summary --input '{"projectId":"p0"}'
npx olan-app tools call standup_add_task --input '{"projectId":"p0","title":"Demo"}'
curl http://127.0.0.1:4417/__test/log
```

Agents: read `AGENTS.md`. Docs: `node_modules/@olan-app/sdk/docs/` (`server.md`, `surfaces.md`, `cards.md`).
