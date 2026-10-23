import { createElement, type ReactElement, type ReactNode } from 'react';

/*
 * Olan Apps components (contract §3). Each renders a host element whose type and prop names are
 * exactly the wire names; the host draws it with Olan's own components on each platform, so
 * apps cannot set colours, fonts or sizes. Function props (`onPress`, `onSelect`, …) stay in the
 * sandbox; the host receives a handler id and sends the event back.
 */

/** A list, row, menu or action key. */
export type Key = string | number;
export type Tone = 'default' | 'muted' | 'accent' | 'danger' | 'success' | 'warning';
export type Spacing = 'none' | 'xs' | 'sm' | 'md' | 'lg';
/** An icon name from Olan's icon vocabulary (`design-system/icons.json`, e.g. `check`, `calendar`). */
export type IconName = string;
/** Handlers may return anything; a returned promise is awaited and its rejection reported. */
type MaybePromise = unknown;

/** Text-only children: strings, numbers and lists of them. */
export type TextChildren = string | number | boolean | null | undefined | readonly TextChildren[];

export interface Action {
  key: Key;
  label: string;
  icon?: IconName;
  onPress: () => MaybePromise;
}

export interface BadgeData {
  text: string;
  tone?: Tone;
}

function host<P extends object>(type: string) {
  const component = (props: P): ReactElement => createElement(type, props as Record<string, unknown>);
  Object.defineProperty(component, 'name', { value: type });
  return component;
}

// ---- layout ----

export interface ScreenProps {
  title?: string;
  subtitle?: string;
  /** Buttons in the host's title bar. */
  actions?: Action[];
  loading?: boolean;
  /** The screen body scrolls (default: the host decides). */
  scroll?: boolean;
  children?: ReactNode;
}
/** The root of a surface: title bar and body. */
export const Screen = host<ScreenProps>('Screen');

export interface StackProps {
  direction?: 'vertical' | 'horizontal';
  gap?: Spacing;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  wrap?: boolean;
  padding?: Spacing;
  children?: ReactNode;
}
/** Lays children out in a row or a column with token spacing. */
export const Stack = host<StackProps>('Stack');

export interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: Action[];
  padding?: Spacing;
  children?: ReactNode;
}
export const Card = host<CardProps>('Card');

// ---- content ----

export interface TextProps {
  /** The text; alternatively pass it as children. */
  text?: string;
  variant?: 'title' | 'heading' | 'body' | 'caption' | 'label';
  tone?: Tone;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  /** One line with an ellipsis. */
  truncate?: boolean;
  children?: TextChildren;
}
export const Text = host<TextProps>('Text');

export interface BadgeProps {
  text: string;
  tone?: Tone;
  children?: never;
}
export const Badge = host<BadgeProps>('Badge');

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: IconName;
  action?: { label: string; onPress: () => MaybePromise };
  children?: never;
}
export const EmptyState = host<EmptyStateProps>('EmptyState');

export interface ListItem {
  key: Key;
  title: string;
  subtitle?: string;
  /** Short trailing text (a date, a count). */
  meta?: string;
  badge?: BadgeData;
  icon?: IconName;
  disabled?: boolean;
}

export interface ListProps {
  items: ListItem[];
  onSelect?: (payload: { key: Key }) => MaybePromise;
  emptyText?: string;
  loading?: boolean;
  children?: never;
}
/** A list of rows. Long lists are virtualised by the host; send all items. */
export const List = host<ListProps>('List');

/** How the host formats numbers (with the person's locale): `percent` takes a fraction (0.034 → 3.4 %). */
export type ValueFormat = 'number' | 'currency' | 'percent';

export interface TableColumn {
  key: string;
  title: string;
  /** Relative width (a flex weight). */
  width?: number;
  align?: 'start' | 'center' | 'end';
  /** Formats number cells (other values show as they are). */
  format?: 'text' | ValueFormat;
  /** ISO 4217 code; required with `format: 'currency'`. */
  currency?: string;
  /** The host sorts the rows by this column when the person taps its title. */
  sortable?: boolean;
}

export interface TableRow {
  key: Key;
  cells: Record<string, string | number | null>;
}

export interface TableProps {
  columns: TableColumn[];
  rows: TableRow[];
  onSelectRow?: (payload: { key: Key }) => MaybePromise;
  emptyText?: string;
  /** Initial order of a sortable table. */
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  children?: never;
}
export const Table = host<TableProps>('Table');

export interface ChartSeries {
  name: string;
  points: { x: string; y: number }[];
}

export interface ChartProps {
  kind: 'bar' | 'line' | 'area';
  series: ChartSeries[];
  /** Height in points (default: the host's chart height). */
  height?: number;
  /** Stacks the series (`bar` and `area`). */
  stacked?: boolean;
  /** Axis and tooltip number format. */
  valueFormat?: ValueFormat;
  /** ISO 4217 code; required with `valueFormat: 'currency'`. */
  currency?: string;
  children?: never;
}
/** A bar, line or area chart in Olan's chart colours. */
export const Chart = host<ChartProps>('Chart');

export interface StatProps {
  label: string;
  /** A number is formatted by `format`; a string shows as it is; null shows "—". */
  value: number | string | null;
  format?: ValueFormat;
  /** ISO 4217 code; required with `format: 'currency'`. */
  currency?: string;
  /** Relative change as a fraction, shown as a signed percent (0.124 → +12.4 %). */
  delta?: number;
  /** Which direction is good (green): `up` (default) or `down` (costs such as CPC). */
  deltaGood?: 'up' | 'down';
  /** A short line under the value, e.g. "Son 30 gün". */
  caption?: string;
  children?: never;
}
/** One key figure (a KPI tile). */
export const Stat = host<StatProps>('Stat');

export interface BannerProps {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  text: string;
  action?: { label: string; onPress: () => MaybePromise };
  /** Shows a close button. */
  onDismiss?: () => MaybePromise;
  children?: never;
}
/** A message across the screen (a connection expired, an error to act on). */
export const Banner = host<BannerProps>('Banner');

export interface ImageProps {
  /**
   * An `https:` URL on the origin of the manifest `remote.url` or a host granted as `http:<host>`;
   * others show a placeholder.
   */
  src: string;
  /** What the image shows; `""` only for decoration. */
  alt: string;
  /** Width / height (0.1–10); default 16/9. */
  aspectRatio?: number;
  fit?: 'cover' | 'contain';
  /** A still shown while `src` loads or when it fails (same URL rule). */
  poster?: string;
  children?: never;
}
/** An image from the app's server. Not allowed in chat cards. */
export const Image = host<ImageProps>('Image');

export interface AvatarProps {
  /** The person's or brand's name: read aloud and used for the initials. */
  name: string;
  /** Picture (the `Image` URL rule); initials when missing or broken. */
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  children?: never;
}
export const Avatar = host<AvatarProps>('Avatar');

export interface ProgressBarProps {
  /** 0–1; leave it out for an indeterminate bar. */
  value?: number;
  label?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  children?: never;
}
export const ProgressBar = host<ProgressBarProps>('ProgressBar');

// ---- input ----

export interface FormProps {
  /** `values` maps each field `name` to its current value. */
  onSubmit: (payload: { values: Record<string, string> }) => MaybePromise;
  submitLabel?: string;
  cancelLabel?: string;
  onCancel?: () => MaybePromise;
  /** Fields (`TextField`, `Select`, `DatePicker`) and any layout. */
  children?: ReactNode;
}
export const Form = host<FormProps>('Form');

export interface TextFieldProps {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Password entry. */
  secure?: boolean;
  required?: boolean;
  /** Validation message shown under the field. */
  error?: string;
  onChange?: (payload: { value: string }) => MaybePromise;
  /** Limits the input and shows an "n/max" counter (Unicode code points). */
  maxLength?: number;
  children?: never;
}
export const TextField = host<TextFieldProps>('TextField');

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  name: string;
  label: string;
  value?: string | null;
  options: SelectOption[];
  placeholder?: string;
  onChange?: (payload: { value: string }) => MaybePromise;
  children?: never;
}
/** The platform's own select control. */
export const Select = host<SelectProps>('Select');

export interface DatePickerProps {
  name: string;
  label: string;
  /** ISO date (`2026-10-16`) or date-time. */
  value?: string | null;
  mode?: 'date' | 'datetime';
  onChange?: (payload: { value: string }) => MaybePromise;
  children?: never;
}
/** The platform's own date (or date and time) picker. */
export const DatePicker = host<DatePickerProps>('DatePicker');

export interface ButtonProps {
  label: string;
  onPress: () => MaybePromise;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  children?: never;
}
export const Button = host<ButtonProps>('Button');

export interface MenuItem {
  key: Key;
  label: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
}

interface MenuBaseProps {
  items: MenuItem[];
  onSelect: (payload: { key: Key }) => MaybePromise;
  children?: never;
}
/** An anchored menu: the platform's own menu (UIMenu, PopupMenu, the web menu). Needs a label or an icon. */
export type MenuProps = MenuBaseProps & ({ label: string; icon?: IconName } | { label?: string; icon: IconName });
export const Menu = host<MenuProps>('Menu');

// ---- Phase 5a: selection controls ----

export interface TabItem {
  key: Key;
  /** ≤ 40 characters. */
  label: string;
  badge?: string | number;
  disabled?: boolean;
}

export interface TabsProps {
  /** 2–8 tabs. */
  items: TabItem[];
  /** The selected `key`. */
  value: Key;
  /** The tab group's accessible name, ≤ 40 characters (default "Bölümler"); not shown. */
  label?: string;
  onChange: (payload: { key: Key }) => MaybePromise;
  children?: never;
}
/** A segmented control (UISegmentedControl, Material segmented buttons); render the selected content yourself. */
export const Tabs = host<TabsProps>('Tabs');

export interface SwitchProps {
  label: string;
  value: boolean;
  description?: string;
  disabled?: boolean;
  onChange?: (payload: { value: boolean }) => MaybePromise;
  children?: never;
}
/** The platform's on/off switch. Not a Form field: keep its value with `onChange`. */
export const Switch = host<SwitchProps>('Switch');

export interface MultiSelectProps {
  label: string;
  /** The selected option values. */
  value: string[];
  /** ≤ 200. */
  options: SelectOption[];
  placeholder?: string;
  /** Most values that may be selected. */
  max?: number;
  disabled?: boolean;
  onChange?: (payload: { value: string[] }) => MaybePromise;
  children?: never;
}
/** Several values from a list (a checkmarked native menu or a multi-choice dialog). Not a Form field. */
export const MultiSelect = host<MultiSelectProps>('MultiSelect');
