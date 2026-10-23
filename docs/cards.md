# Chat cards

An app posts a static card into a chat as itself (name and icon of the app). A card is the UI tree
format without handlers, so it renders on web, desktop and mobile without running the app:

```ts
import type { AppCard } from '@olan-app/sdk';

const card: AppCard = {
  version: 1,
  root: 1,
  fallbackText: 'Standup: 3 görev açık',          // 1–500: notifications, search, previews
  nodes: [
    { id: 1, type: 'Card', props: { title: 'Standup', subtitle: '17 Ekim' }, children: [2, 4, 5] },
    { id: 2, type: 'Text', props: {}, children: [3] },
    { id: 3, type: '#text', props: { text: '3 görev açık' }, children: [] },
    { id: 4, type: 'Button', props: { label: 'Aç', action: { kind: 'open', payload: { day: '2026-10-17' } } }, children: [] },
    { id: 5, type: 'Button', props: { label: 'Bitti', variant: 'primary', action: { kind: 'submit', name: 'done' } }, children: [] },
  ],
};
const { messageId } = await olan.chat.postCard({ conversationId, card });   // chat:write
await olan.chat.updateCard(messageId, { ...card, fallbackText: 'Standup bitti' });
```

- Components: `Card`, `Stack`, `Text` (with `#text` children or `text`), `Badge`, `Table`,
  `Button`, `EmptyState`; props as in components.md. No inputs and no handlers (`$handler`,
  `onPress`, `Card.actions`, `EmptyState.action`, `Table.onSelectRow`).
- `Button` has `action` instead of `onPress`:
  - `{ kind: 'open', payload? }` opens the app's `chat.card` surface with
    `{ conversationId, messageId, payload }` (declare `chat.card` in `surfaces`).
  - `{ kind: 'submit', name, payload? }` calls the app's server (`POST {remote.url}/card-actions`,
    server.md); it needs `remote`. The answer may replace the card and show a toast.
- Limits: JSON ≤ 16 KiB, ≤ 100 nodes, depth ≤ 8, each `payload` ≤ 2 KiB. Invalid cards fail with
  `validation_failed`; the message lists `card.*` / `tree.*` codes (errors.md#cards).
- Where: a conversation the person is in (from a chat surface: `useSurfaceParams().conversationId`).
  From the app's server with the app identity: only conversations the app was added to (server.md).
- `updateCard` changes only cards this installation posted. Apps never receive events for their own
  cards. Cards do not trigger push notifications; they count as unread.
- Rate limits: 60 cards per minute per installation, 10 per conversation.

Record cards (SDK 1.7): the same format is the card an app draws on a task or issue
(`olan.project.links.upsert`, api.md) and attaches to an approval request. Its buttons may only
`{ kind: 'open', payload? }`, which opens the app's `record.card` surface with
`{ projectId, linkId, target, externalId, payload }`; `validateRecordCard(card)` checks it.

`validateCard(card, { remote })` from `@olan-app/schema` runs the same checks; `olan-app test`
validates every `postCard` like the server (`app.host.cards` lists what the app posted).
