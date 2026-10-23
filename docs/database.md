# App database (`olan.db`)

Each app can have its own database on the Olan server: collections of JSON rows with declared
fields, indexed queries, cursors and per-row revisions. Declare the collections in the manifest's
`data` and request the `db` permission. Needs `@olan-app/sdk` ^1.1.0 (`"sdk": "^1.1.0"`).

`olan.db` is for the app's records (decisions, checklists, pins). For a few per-user preferences
keep using `olan.storage` (api.md); for Olan's own records (tasks) use `olan.projects`.

## Declaring collections

```jsonc
// olan-app.json
"permissions": ["db"],
"data": {
  "version": 1,                                  // integer; increase it whenever the schema changes
  "collections": {
    "decisions": {
      "scope": "organization",                   // shared in the organization (with rules)
      "fields": {
        "title":     { "type": "string", "required": true, "maxLength": 200, "indexed": true },
        "status":    { "type": "string", "enum": ["open", "done"], "indexed": true },
        "projectId": { "type": "ref:project", "indexed": true },
        "taskId":    { "type": "ref:task" },
        "decidedOn": { "type": "date", "indexed": true },
        "score":     { "type": "number", "integer": true, "min": 0, "max": 10 },
        "meta":      { "type": "json" }
      },
      "rules": { "read": "any", "update": "any", "delete": "owner" }
    },
    "pins": { "scope": "user", "fields": { "decisionId": { "type": "string", "maxLength": 64, "indexed": true } } }
  }
}
```

| `type` | Value | Options | Indexable |
|---|---|---|---|
| `string` | string | `maxLength` (default 1000, ≤ 10000), `enum` (≤ 100 values, each ≤ 100 characters) | yes, when `maxLength` ≤ 512 or it has `enum` |
| `number` | finite number | `integer`, `min`, `max` | yes |
| `boolean` | `true` / `false` | – | yes (`eq`/`in` only) |
| `date` | `"YYYY-MM-DD"` (a real calendar day) | – | yes |
| `datetime` | ISO date-time **with offset** (`Z` or `+03:00`); stored as UTC `toISOString()` | – | yes |
| `json` | any JSON, ≤ 16 KiB serialised | – | no |
| `ref:project`, `ref:task`, `ref:user` | UUID string (stored lower-case) | – | yes (`eq`/`in` only) |

Every field also takes `required` (default `false`), `indexed` (default `false`) and `label`
(≤ 80, shown in Studio and exports). A field that is not `required` may be missing or `null`
(both mean "no value"; `null` is not stored). Refs only check the UUID format; Olan does not
check that the project/task/user exists, and does not clean up when it is deleted.

Limits: ≤ 20 collections; ≤ 64 fields and ≤ 5 indexed fields per collection; collection names
`^[a-z][a-z0-9_]{0,39}$`; field names `^[A-Za-z][A-Za-z0-9_]{0,63}$`; `id`, `createdAt`,
`updatedAt`, `createdBy`, `revision` are reserved; a row's data ≤ 64 KiB as JSON. There are no
composite or unique indexes. `createdAt`, `updatedAt` and `createdBy` are always indexed.

### Scope and rules

- `"scope": "user"`: each person sees only the rows they created. No `rules`.
- `"scope": "organization"`: rows are shared by everyone who uses the installation, subject to
  `rules` — `read`, `update`, `delete`, each `"any"` or `"owner"` (the row's creator). Default
  `{ "read": "any", "update": "any", "delete": "owner" }`. In a personal installation (installed
  by one user for themselves) an organization collection belongs to that user.
- A row the rules hide does not appear in `get`/`query`/`count`; changing or deleting it fails
  with `forbidden_record`. Admins see every row only through export and the admin data browser,
  never inside the app.

### Changing the schema

Increase `data.version` with every change. When a new version is installed, Olan compares it
with the stored schema:

- Applied automatically: new collections, new optional fields, adding or removing `indexed`,
  a larger `maxLength`/`max`, a smaller `min`, new `enum` values, `required: true → false`,
  `rules`, `label`.
- Refused until migrations arrive (Phase 3): removing a collection (`data.collection_removed`)
  or field (`data.field_removed`), changing a type (`data.type_changed`) or scope
  (`data.scope_changed`), adding a required field or making one required
  (`data.required_added`), narrowing a constraint (`data.constraint_tightened`).
- A changed schema with the same `version` is `data.version_not_bumped`; a lower one
  `data.version_downgrade`.

When the app is removed, its data is kept for 30 days and comes back if it is installed again
(with a compatible schema); admins can export it (NDJSON) or delete it earlier.

## API

```ts
import { olan, isOlanError, type DbRow } from '@olan-app/sdk';

type Decision = { title: string; status?: 'open' | 'done'; projectId?: string; score?: number };
const decisions = olan.db.collection<Decision>('decisions');

const row = await decisions.insert({ title: 'Ship 1.1', status: 'open' });
// row: { id, data: { title, status }, revision: 1, createdAt, updatedAt, createdBy }
const same = await decisions.get(row.id);                        // DbRow<Decision> | null
const { rows, nextCursor } = await decisions.query({
  where: { status: 'open', decidedOn: { gte: '2026-01-01' } },
  orderBy: { field: 'decidedOn', direction: 'desc' },
  limit: 20,
});
const changed = await decisions.update(row.id, { status: 'done', score: null }, { revision: row.revision });
await decisions.delete(row.id, { revision: changed.revision });  // revision optional
const open = await decisions.count({ status: 'open' });
```

| Call | Returns | Notes |
|---|---|---|
| `collection<T>(name)` | `DbCollection<T>` | `name` from `data.collections`; unknown → `invalid_params` |
| `insert(data)` | `DbRow<T>` | `data` is the whole row (validated) |
| `get(id)` | `DbRow<T> \| null` | `null` when missing or hidden by rules |
| `query({ where?, orderBy?, limit?, cursor? })` | `{ rows: DbRow<T>[]; nextCursor: string \| null }` | see below |
| `update(id, patch, { revision })` | `DbRow<T>` | shallow merge; `null` clears a field; `revision` must be current |
| `delete(id, { revision? })` | `void` | with `revision`, only if unchanged |
| `count(where?)` | `number` | same `where` as `query` |

```ts
interface DbRow<T> { id: string; data: T; revision: number; createdAt: string; updatedAt: string; createdBy: string }
type DbScalar = string | number | boolean | null;
type DbCondition = DbScalar | { eq?: DbScalar; in?: DbScalar[]; gt?: DbScalar; gte?: DbScalar; lt?: DbScalar; lte?: DbScalar };
type DbWhere = Record<string, DbCondition>;               // fields are combined with AND
interface DbOrderBy { field: string; direction?: 'asc' | 'desc' }
interface DbQuery { where?: DbWhere; orderBy?: DbOrderBy; limit?: number; cursor?: string }
```

### Queries

- `where` only on indexed fields and `createdAt`, `updatedAt`, `createdBy`; at most 5 fields.
  A plain value means `eq`; `{ field: null }` finds rows without a value; `in` takes ≤ 50 values
  (`null` allowed); `gt`/`gte`/`lt`/`lte` may be combined on one field for a range. `boolean`,
  `ref:*` and `createdBy` allow only `eq`/`in`. Values must match the field type (dates as
  `YYYY-MM-DD`, date-times with an offset). Anything else is `invalid_params`.
- `orderBy`: one indexed field, `createdAt` or `updatedAt`; `direction` defaults to `'asc'`.
  Without `orderBy` rows come newest first (`{ field: 'createdAt', direction: 'desc' }`). Ties are
  broken by `id`; rows without a value come last in both directions. Strings sort by Unicode
  code point (`'B' < 'a'`), not alphabetically for a language.
- `limit` 1–100, default 50. `nextCursor` is `null` on the last page; pass it as `cursor` with the
  **same** `where` and `orderBy` (a different query → `invalid_params`). Cursors are opaque.
- No full-text search, joins or aggregates; filter on indexed fields and finish in JavaScript.

## Hooks

`useCollection(name, query?, deps?)` → `{ rows, nextCursor, loading, error, refetch, loadMore }` and
`useRecord(name, id | null)` → `{ data, error, loading, refetch }` (hooks.md). Mutations through
`olan.db.collection(name)` in the app reload the hooks reading that collection; there are no live
subscriptions, so other people's changes appear after `refetch`.

## Errors

| Code | When | What to do |
|---|---|---|
| `validation_failed` | The row does not match the schema. `message` names the first problem: `"data.title: row.required"` (`row.unknown_field`, `row.required`, `row.type`, `row.max_length`, `row.range`, `row.enum`, `row.not_integer`, `row.json_too_large`, `row.too_large`) | Fix the form values; show the field |
| `conflict` | `update`/`delete` with an old `revision` (someone changed the row) | `get` the row again, re-apply the change, retry |
| `not_found` | `update`/`delete` of a row that does not exist (or belongs to another user in a `user` collection) | Refetch the list |
| `forbidden_record` | The collection's `rules` do not allow this user to change/delete the row | Catch it and explain ("only the person who added it can delete it"); see below |
| `quota_exceeded` | The installation's row or size limit is reached (default 100 000 rows, 100 MiB) | Tell the user to contact an admin; delete old rows |
| `invalid_params` | Unknown collection, non-indexed `where`/`orderBy` field, bad `limit` or cursor | Fix the call |
| `permission_denied` | `db` is not granted | Add `"db"` to `permissions` |

```ts
async function markDone(row: DbRow<Decision>) {
  try {
    return await decisions.update(row.id, { status: 'done' }, { revision: row.revision });
  } catch (error) {
    if (!isOlanError(error, 'conflict')) throw error;
    const fresh = await decisions.get(row.id);          // someone else changed it: retry once
    return fresh && decisions.update(fresh.id, { status: 'done' }, { revision: fresh.revision });
  }
}
```

`createdBy` is the central Olan user id, the same as `useUser().id` (hooks.md). With `owner`
rules, show the action only on the user's own rows, and still handle the refusal (the row or the
rules may change in between):

```tsx
const me = useUser();
const canDelete = row.createdBy === me.id;   // rules.delete: 'owner'

async function remove(row: DbRow<Decision>) {
  try {
    await decisions.delete(row.id, { revision: row.revision });
  } catch (error) {
    if (!isOlanError(error, 'forbidden_record')) throw error;
    await olan.ui.toast({ text: 'Bu kararı yalnızca ekleyen kişi silebilir', tone: 'warning' });
  }
}
```

If everyone should be able to do it, use `"any"` for that rule instead; for "my rows only", use
a `"scope": "user"` collection.

## Testing

`olan-app test` and `validate --strict` run the app against an in-memory database with the same
rules and error codes (`@olan-app/sdk/memory-db`). Seed it with `fixtures/db.json`:

```json
{ "decisions": [{ "id": "d1", "data": { "title": "İlk karar", "status": "open" } }] }
```

Missing `id`, `createdBy` (the default user `00000000-0000-4000-8000-000000000001`), timestamps
and `revision` (1) are filled in; another `"createdBy"` makes a row someone else wrote. Row ids may
be any unique string. Rows must match the schema, and `ref:*` values must be UUIDs, while the
mock's built-in project and task ids are not (`p0`, `p0-t0`): an app that stores project/task ids
needs `fixtures/projects.json` with UUID ids (testing.md, "Fixtures").
