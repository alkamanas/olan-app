# Components

Import every component from `@olan-app/sdk`. These 23 are the only ones that exist (SDK 1.5 added
`Tabs`, `Switch`, `MultiSelect`, `Stat`, `Banner`, `Image`, `Avatar` and `ProgressBar`; apps using
them declare `"sdk": "^1.5.0"`); Olan draws each
with its own native control (web, desktop, iOS, Android). All props are optional unless marked
**required**. Props not listed here are rejected (`tree.unknown_prop`), including `style`,
`className`, `color` and `id`.

Handler props (`onPress`, `onSelect`, `onChange`, `onSubmit`, …) may be async; a rejected promise is
reported as an app error. Event payloads are listed with each handler.

Shared value sets:

| Type | Values |
|---|---|
| `Tone` | `'default' \| 'muted' \| 'accent' \| 'danger' \| 'success' \| 'warning'` |
| `Spacing` | `'none' \| 'xs' \| 'sm' \| 'md' \| 'lg'` |
| `Key` | `string \| number` (non-empty string) |
| `IconName` | a name from the icon list at the end of this page |
| `Action` | `{ key: Key; label: string; icon?: IconName; onPress: () => void }` |

Children: `Screen`, `Stack`, `Card` and `Form` take any components; `Text` takes only text; every
other component takes no children (`tree.children_not_allowed`).

## Screen

Title bar plus body. **Required root** of the `app` and `settings` surfaces (`validate --strict`
warns `ui.root_not_screen`); also the recommended root of modal and panel surfaces (`chat.*`,
`mail.*`, `calendar.event.action`, `meeting.panel`, SDK 1.7 `task.action`, `issue.action`, `record.card`), where its title and actions are the header.
`project.widget` uses `Card` (or `EmptyState`) instead. `project.tab` and `project.settings` (SDK 1.6)
also start with `Screen`: its title heads the tab or the settings sheet.

| Prop | Type | Notes |
|---|---|---|
| `title` | `string` | Title bar text |
| `subtitle` | `string` | |
| `actions` | `Action[]` | Buttons in the title bar |
| `loading` | `boolean` | Shows a loading indicator |
| `scroll` | `boolean` | Body scrolls (default: host decides) |
| children | any | |

```tsx
<Screen title="Projeler" loading={q.loading} actions={[{ key: 'refresh', label: 'Yenile', icon: 'refresh', onPress: () => q.refetch() }]}>
  …
</Screen>
```

## Stack

Lays children out in a column (default) or a row.

| Prop | Type |
|---|---|
| `direction` | `'vertical' \| 'horizontal'` |
| `gap` | `Spacing` |
| `align` | `'start' \| 'center' \| 'end' \| 'stretch'` |
| `justify` | `'start' \| 'center' \| 'end' \| 'between'` |
| `wrap` | `boolean` |
| `padding` | `Spacing` |
| children | any |

## Card

A grouped block. The usual root of a `project.widget` surface.

| Prop | Type |
|---|---|
| `title` | `string` |
| `subtitle` | `string` |
| `actions` | `Action[]` |
| `padding` | `Spacing` |
| children | any |

## Text

| Prop | Type | Notes |
|---|---|---|
| `text` | `string` | Or pass the text as children: `<Text>Merhaba {name}</Text>` |
| `variant` | `'title' \| 'heading' \| 'body' \| 'caption' \| 'label'` | |
| `tone` | `Tone` | |
| `weight` | `'regular' \| 'medium' \| 'semibold' \| 'bold'` | |
| `truncate` | `boolean` | One line with an ellipsis |

Children may only be strings, numbers, booleans/null (ignored) or arrays of them — no elements.

## Badge

| Prop | Type |
|---|---|
| `text` **required** | `string` |
| `tone` | `Tone` |

## EmptyState

| Prop | Type | Notes |
|---|---|---|
| `title` **required** | `string` | |
| `description` | `string` | |
| `icon` | `IconName` | |
| `action` | `{ label: string; onPress: () => void }` | A button under the text |

## List

Rows with a title. Send all items; the host virtualises long lists.

| Prop | Type | Notes |
|---|---|---|
| `items` **required** | `ListItem[]` | |
| `onSelect` | `({ key }) => void` | Row pressed; `key` is the item's key |
| `emptyText` | `string` | Shown when `items` is empty |
| `loading` | `boolean` | |

`ListItem`: `{ key: Key (required); title: string (required); subtitle?: string; meta?: string (short trailing text, e.g. a date); badge?: { text: string; tone?: Tone }; icon?: IconName; disabled?: boolean }`.

```tsx
<List
  items={tasks.map((t) => ({ key: t.id, title: t.title, meta: t.due ?? undefined, badge: { text: 'Gecikti', tone: 'danger' } }))}
  emptyText="Görev yok"
  onSelect={({ key }) => navigation.push('task', { taskId: String(key) })}
/>
```

Do not pass `undefined`-valued text you need to see: `meta: t.due ?? undefined` omits it cleanly.

## Table

| Prop | Type | Notes |
|---|---|---|
| `columns` **required** | `TableColumn[]` | below |
| `rows` **required** | `{ key: Key; cells: Record<columnKey, string \| number \| null> }[]` | |
| `onSelectRow` | `({ key }) => void` | |
| `emptyText` | `string` | |
| `defaultSort` | `{ key: string; direction: 'asc' \| 'desc' }` | Initial order (SDK 1.5) |

`TableColumn`: `{ key: string; title: string; width?: number; align?: 'start' | 'center' | 'end';
format?: 'text' | 'number' | 'currency' | 'percent'; currency?: string; sortable?: boolean }`.
`width` is a relative (flex) weight > 0. SDK 1.5:

- `format`: the host formats number cells with the person's locale (`Intl.NumberFormat`); a cell
  that is not a number shows as it is. `percent` takes a fraction (`0.034` → "%3,4").
- `currency`: ISO 4217 (`'TRY'`), required with `format: 'currency'` (`tree.invalid_prop`).
- `sortable`: the person sorts by tapping the title. The host sorts the rows itself, on the raw
  cell values (numbers as numbers); there is no handler.

```tsx
<Table
  columns={[
    { key: 'name', title: 'Kampanya', sortable: true },
    { key: 'spend', title: 'Harcama', format: 'currency', currency: 'TRY', align: 'end', sortable: true },
    { key: 'ctr', title: 'TO', format: 'percent', align: 'end', sortable: true },
  ]}
  rows={campaigns.map((c) => ({ key: c.id, cells: { name: c.name, spend: c.spend, ctr: c.ctr } }))}
  defaultSort={{ key: 'spend', direction: 'desc' }}
/>
```

## Chart

| Prop | Type | Notes |
|---|---|---|
| `kind` **required** | `'bar' \| 'line' \| 'area'` | `area` since SDK 1.5 |
| `series` **required** | `{ name: string; points: { x: string; y: number }[] }[]` | `x` is a label (e.g. a date) |
| `height` | `number` | Integer 1–2000 |
| `stacked` | `boolean` | Stacks the series; `bar` and `area` only (SDK 1.5) |
| `valueFormat` | `'number' \| 'currency' \| 'percent'` | Axis and tooltip format (SDK 1.5; `percent` takes fractions) |
| `currency` | `string` | ISO 4217; required with `valueFormat: 'currency'` |

Colours come from Olan's chart palette; you cannot set them.

```tsx
<Chart kind="area" stacked valueFormat="currency" currency="TRY"
  series={[{ name: 'Meta', points: days.map((d) => ({ x: d.day, y: d.meta })) }, { name: 'Google', points: days.map((d) => ({ x: d.day, y: d.google })) }]} />
```

## Form

Groups fields and submits their values together.

| Prop | Type | Notes |
|---|---|---|
| `onSubmit` **required** | `({ values }) => void` | `values: Record<string, string>` maps each field `name` to its value |
| `submitLabel` | `string` | Submit button text |
| `cancelLabel` | `string` | |
| `onCancel` | `() => void` | |
| children | any | Fields and layout |

```tsx
<Form submitLabel="Kaydet" onSubmit={({ values }) => save(values.title, values.due)}>
  <TextField name="title" label="Başlık" required />
  <DatePicker name="due" label="Bitiş" />
</Form>
```

Submitting does **not** clear the fields: an uncontrolled field (no `value`) keeps what the user
typed, in Olan and in `renderApp`. To empty the form after a save, either control the fields
(`value={title}` + `onChange={({ value }) => setTitle(value)}`, then `setTitle('')`) or remount
the form with a new React `key` (`<Form key={saved} …>`, `setSaved((n) => n + 1)`).

## TextField

| Prop | Type | Notes |
|---|---|---|
| `name` **required** | `string` | Key in `Form` values |
| `label` **required** | `string` | |
| `value` | `string` | Controlled value; omit for an uncontrolled field (it is not cleared on submit, see `Form`) |
| `placeholder` | `string` | |
| `multiline` | `boolean` | |
| `secure` | `boolean` | Password entry |
| `required` | `boolean` | |
| `error` | `string` | Validation message under the field |
| `onChange` | `({ value }) => void` | `value: string` |
| `maxLength` | `number` | 1–100000 (SDK 1.5): the host stops input at this many characters and shows an "n/max" counter under the field. Counted in Unicode code points (`[...value].length`), so an emoji is one |

## Select

The platform's own picker.

| Prop | Type | Notes |
|---|---|---|
| `name` **required** | `string` | |
| `label` **required** | `string` | |
| `options` **required** | `{ value: string; label: string }[]` | |
| `value` | `string \| null` | Selected option value; `null` = none |
| `placeholder` | `string` | |
| `onChange` | `({ value }) => void` | `value` is the option `value` |

## DatePicker

The platform's own date (or date and time) picker.

| Prop | Type | Notes |
|---|---|---|
| `name` **required** | `string` | |
| `label` **required** | `string` | |
| `value` | `string \| null` | ISO date `YYYY-MM-DD` or ISO date-time |
| `mode` | `'date' \| 'datetime'` | |
| `onChange` | `({ value }) => void` | ISO string |

## Button

| Prop | Type | Notes |
|---|---|---|
| `label` **required** | `string` | Never empty (`ui.button_label_missing`) |
| `onPress` **required** | `() => void` | |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | |
| `icon` | `IconName` | Shown next to the label |
| `disabled` | `boolean` | |
| `loading` | `boolean` | Also blocks presses |

## Menu

An anchored menu button: UIMenu on iOS, PopupMenu on Android, the Olan menu on web.

| Prop | Type | Notes |
|---|---|---|
| `label` | `string` | Button text. `label` or `icon` is required; prefer a label |
| `icon` | `IconName` | |
| `items` **required** | `{ key: Key; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean }[]` | |
| `onSelect` **required** | `({ key }) => void` | Chosen item |

```tsx
<Menu
  label="Durumu değiştir"
  items={[{ key: 'in-process', label: 'Sürüyor' }, { key: 'completed', label: 'Tamamlandı' }, { key: 'cancelled', label: 'İptal', destructive: true }]}
  onSelect={({ key }) => setStatus(String(key) as ProjectTaskStatus)}
/>
```

For a menu opened from code (not anchored to a button) use `olan.ui.menu` (api.md).

## SDK 1.5 components

The components below need `"sdk": "^1.5.0"` and an Olan server that knows them (an older one
reports `tree.unknown_type`). They take no children and are **not allowed in chat cards**
(`card.component_not_allowed`). Numbers are formatted by the host with the person's locale
(`Intl.NumberFormat`); `percent` always takes a fraction (`0.034` → "%3,4" in Turkish).

## Tabs

A controlled segmented control: UISegmentedControl on iOS, Material segmented buttons on Android
(a scrolling tab bar above 5 tabs), the Olan segmented control on web. Render the selected content
yourself.

| Prop | Type | Notes |
|---|---|---|
| `items` **required** | `{ key: Key; label: string; badge?: string \| number; disabled?: boolean }[]` | 2–8 tabs; `label` ≤ 40, never empty (`a11y.tab_label_missing`); `badge` ≤ 16 characters or a count |
| `value` **required** | `Key` | The selected `key` |
| `label` | `string` | The tab group's accessible name for screen readers, not shown; ≤ 40, default "Bölümler". Leave it out rather than passing an empty string (`a11y.tab_label_missing`) |
| `onChange` **required** | `({ key }) => void` | |

```tsx
const [tab, setTab] = useState('media');
<Tabs value={tab} label="Medya bölümleri" onChange={({ key }) => setTab(String(key))}
  items={[{ key: 'media', label: 'Medya', badge: processing }, { key: 'upload', label: 'Yükle' }, { key: 'stats', label: 'Analiz' }]} />
{tab === 'media' ? <MediaList /> : tab === 'upload' ? <UploadForm /> : <Stats />}
```

## Switch

The platform's on/off switch (UISwitch, Material switch).

| Prop | Type | Notes |
|---|---|---|
| `label` **required** | `string` | Never empty (`a11y.field_label_missing`) |
| `value` **required** | `boolean` | |
| `description` | `string` | A second line under the label |
| `disabled` | `boolean` | |
| `onChange` | `({ value }) => void` | `value: boolean`, the new state |

Not a `Form` field: its value is not in `onSubmit`'s `values` (still `Record<string, string>`);
keep it in state with `onChange`.

## MultiSelect

Several values from a list: a checkmarked native menu on iOS (it stays open while the person
ticks), a multi-choice dialog on Android, the Olan menu on web. The trigger shows how many are
selected.

| Prop | Type | Notes |
|---|---|---|
| `label` **required** | `string` | Never empty (`a11y.field_label_missing`) |
| `value` **required** | `string[]` | The selected option values |
| `options` **required** | `{ value: string; label: string }[]` | ≤ 200 |
| `placeholder` | `string` | Shown when nothing is selected |
| `max` | `number` | Most values the person may select |
| `disabled` | `boolean` | |
| `onChange` | `({ value }) => void` | `value: string[]`, the new selection |

Not a `Form` field either: keep its value with `onChange`.

```tsx
<MultiSelect label="Kanallar" value={channels} onChange={({ value }) => setChannels(value)} max={3}
  options={[{ value: 'instagram', label: 'Instagram' }, { value: 'tiktok', label: 'TikTok' }, { value: 'linkedin', label: 'LinkedIn' }]} />
```

## Stat

One key figure (a KPI tile).

| Prop | Type | Notes |
|---|---|---|
| `label` **required** | `string` | |
| `value` **required** | `number \| string \| null` | A number is formatted by `format`; a string shows as it is; `null` shows "—" |
| `format` | `'number' \| 'currency' \| 'percent'` | Default `number` |
| `currency` | `string` | ISO 4217 (`'TRY'`); required with `format: 'currency'` (`tree.invalid_prop`) |
| `delta` | `number` | Relative change as a fraction, shown as a signed percent (`0.124` → "+%12,4") |
| `deltaGood` | `'up' \| 'down'` | Which direction is good (green); default `up`, `down` for costs such as CPC |
| `caption` | `string` | A short line, e.g. "Son 30 gün" |

```tsx
<Stack direction="horizontal" gap="md" wrap>
  <Stat label="Harcama" value={1250.5} format="currency" currency="TRY" delta={0.08} caption="Son 7 gün" />
  <Stat label="Tıklama oranı" value={0.034} format="percent" delta={-0.012} />
  <Stat label="Tıklama başı maliyet" value={2.4} format="currency" currency="TRY" delta={-0.05} deltaGood="down" />
</Stack>
```

## Banner

A message across the screen: a connection that expired, an error to act on, a success.

| Prop | Type | Notes |
|---|---|---|
| `tone` **required** | `'info' \| 'success' \| 'warning' \| 'danger'` | |
| `text` **required** | `string` | |
| `title` | `string` | |
| `action` | `{ label: string; onPress: () => void }` | One button; `label` never empty (`a11y.action_label_missing`) |
| `onDismiss` | `() => void` | Shows a close button; remove the banner in the handler |

```tsx
{error ? <Banner tone="danger" title="Sunucuya ulaşılamıyor" text={error.message} action={{ label: 'Tekrar dene', onPress: () => items.refetch() }} /> : null}
```

## Image

An image from the app's own server.

| Prop | Type | Notes |
|---|---|---|
| `src` **required** | `string` | `https:` URL ≤ 2048 (`http:` only to local addresses in development) |
| `alt` **required** | `string` | What it shows, read by screen readers; `""` only for decoration (`validate --strict` warns `a11y.image_alt_missing`) |
| `aspectRatio` | `number` | Width / height, 0.1–10; default 16/9 |
| `fit` | `'cover' \| 'contain'` | Default `cover` |
| `poster` | `string` | A still shown while `src` loads or when it fails; same URL rule |

Origin rule (the host enforces it): `src` and `poster` must be on the origin of the manifest
`remote.url` (or the installation's override) or on a host granted as `http:<host>`. Any other
image is drawn as a neutral placeholder and logged as a warning; it is not an error. Serve images
from your app server (or a CDN host you list as `http:<host>`); signed, expiring URLs work.

```tsx
<Image src={item.thumbnailUrl} alt={item.title} aspectRatio={1} fit="cover" poster={item.posterUrl} />
```

## Avatar

| Prop | Type | Notes |
|---|---|---|
| `name` **required** | `string` | The person's or brand's name: read aloud and used for the initials. Never empty (`a11y.avatar_name_missing`) |
| `src` | `string` | Picture, with the `Image` origin rule; initials when missing or broken |
| `size` | `'sm' \| 'md' \| 'lg'` | |

## ProgressBar

| Prop | Type | Notes |
|---|---|---|
| `value` | `number` | 0–1; leave it out for an indeterminate bar (the platform's activity indicator) |
| `label` | `string` | E.g. "Yükleniyor…" |
| `tone` | `'default' \| 'success' \| 'warning' \| 'danger'` | |

Keep the percentage out of `label`: the bar already shows `value` itself.

```tsx
<ProgressBar value={progress} label="Yükleniyor…" />
<Button label="İptal" variant="ghost" onPress={() => task.cancel()} />
```

## Accessibility checks

`validate --strict` and the marketplace lint the rendered tree (`lintUiTree`, errors.md): a
`Button`, field (`TextField`, `Select`, `DatePicker`, `Switch`, `MultiSelect`), `Menu` item, action
or `Banner` action without a label, a `Tabs` item without a label (`a11y.tab_label_missing`) and
an `Avatar` without a name (`a11y.avatar_name_missing`) are errors; an icon-only `Menu` and an
`Image` with an empty `alt` are warnings.

## Exported prop types

`ScreenProps`, `StackProps`, `CardProps`, `TextProps`, `BadgeProps`, `EmptyStateProps`, `ListProps`,
`ListItem`, `TableProps`, `TableColumn`, `TableRow`, `ChartProps`, `ChartSeries`, `FormProps`,
`TextFieldProps`, `SelectProps`, `SelectOption`, `DatePickerProps`, `ButtonProps`, `MenuProps`,
`MenuItem`, `TabsProps`, `TabItem`, `SwitchProps`, `MultiSelectProps`, `StatProps`, `BannerProps`,
`ImageProps`, `AvatarProps`, `ProgressBarProps`, `ValueFormat`, `Action`, `BadgeData`, `Key`,
`Tone`, `Spacing`, `IconName`, `TextChildren`.

## Icons

`icon` props take an Olan icon name. Unknown names fall back to a generic icon. Names:

`mail chat meetings calendar projects marketing contacts files settings inbox all-inboxes archive
delete report-spam reply reply-all forward compose edit draw mark-unread mark-read flag folder
search attachment send send-arrow add minus close clear check check-double check-circle checkbox
more back chevron-right chevron-down chevron-up chevron-up-down list day-view refresh copy paste
share document document-text photo photo-library camera camera-flip video-play gif emoji poll mic
mic-off video video-off call call-end screen-share speaker waveform play pause stop group account
lock block sidebar person-add link record signal approval compare clock warning status-open
status-active touch face-id fingerprint qr-scan help info pin list-checks seal-check warning-circle
undo favorite bell bell-slash timer sign-out crop rotate sticker download tag snooze print`
