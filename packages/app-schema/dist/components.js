import { z } from 'zod';
import { handlerRefSchema } from './ui.js';
/*
 * Prop schemas per component (contract §3). All objects are strict: unknown
 * props are rejected. Function-valued props travel as `{ $handler: number }`.
 * Values left open in the contract table are fixed here and recorded in the
 * contract document (§3, "Prop value sets").
 */
export const TONES = ['default', 'muted', 'accent', 'danger', 'success', 'warning'];
export const SPACINGS = ['none', 'xs', 'sm', 'md', 'lg'];
export const TEXT_VARIANTS = ['title', 'heading', 'body', 'caption', 'label'];
export const TEXT_WEIGHTS = ['regular', 'medium', 'semibold', 'bold'];
export const STACK_ALIGNS = ['start', 'center', 'end', 'stretch'];
export const STACK_JUSTIFIES = ['start', 'center', 'end', 'between'];
export const COLUMN_ALIGNS = ['start', 'center', 'end'];
export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'];
export const CHART_KINDS = ['bar', 'line', 'area'];
export const DATE_PICKER_MODES = ['date', 'datetime'];
/** Phase 5a §6: number formats of `Stat`, `Chart.valueFormat` and `Table` columns (`text` only in tables). */
export const VALUE_FORMATS = ['number', 'currency', 'percent'];
export const COLUMN_FORMATS = ['text', 'number', 'currency', 'percent'];
export const BANNER_TONES = ['info', 'success', 'warning', 'danger'];
export const PROGRESS_TONES = ['default', 'success', 'warning', 'danger'];
export const AVATAR_SIZES = ['sm', 'md', 'lg'];
export const IMAGE_FITS = ['cover', 'contain'];
export const SORT_DIRECTIONS = ['asc', 'desc'];
/** ISO 4217 currency code (`TRY`, `USD`). */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const TABS_LIMITS = Object.freeze({ min: 2, max: 8, labelMax: 40 });
export const MULTI_SELECT_MAX_OPTIONS = 200;
export const TEXT_FIELD_MAX_LENGTH = 100_000;
/** `Image.aspectRatio` (width / height) range. */
export const IMAGE_ASPECT_RATIO = Object.freeze({ min: 0.1, max: 10 });
const handler = handlerRefSchema;
const label = z.string();
/** Icon names from `design-system/icons.json` (`olanIcons` keys); the renderer falls back for unknown names. */
const icon = z.string().min(1).max(64);
const key = z.union([z.string().min(1), z.number()]);
/** ISO 8601 date (`YYYY-MM-DD`) or date-time. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const badge = z.strictObject({ text: z.string(), tone: z.enum(TONES).optional() });
export const actionSchema = z.strictObject({
    key,
    label,
    icon: icon.optional(),
    onPress: handler,
});
const screenProps = z.strictObject({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    actions: z.array(actionSchema).optional(),
    loading: z.boolean().optional(),
    scroll: z.boolean().optional(),
});
const stackProps = z.strictObject({
    direction: z.enum(['vertical', 'horizontal']).optional(),
    gap: z.enum(SPACINGS).optional(),
    align: z.enum(STACK_ALIGNS).optional(),
    justify: z.enum(STACK_JUSTIFIES).optional(),
    wrap: z.boolean().optional(),
    padding: z.enum(SPACINGS).optional(),
});
const textProps = z.strictObject({
    text: z.string().optional(),
    variant: z.enum(TEXT_VARIANTS).optional(),
    tone: z.enum(TONES).optional(),
    weight: z.enum(TEXT_WEIGHTS).optional(),
    truncate: z.boolean().optional(),
});
const listItem = z.strictObject({
    key,
    title: z.string(),
    subtitle: z.string().optional(),
    meta: z.string().optional(),
    badge: badge.optional(),
    icon: icon.optional(),
    disabled: z.boolean().optional(),
});
const listProps = z.strictObject({
    items: z.array(listItem),
    onSelect: handler.optional(),
    emptyText: z.string().optional(),
    loading: z.boolean().optional(),
});
const currency = z.string().regex(CURRENCY_PATTERN, 'currency must be an ISO 4217 code such as "TRY"');
/** `currency` is required with a `currency` format. */
const needsCurrency = (format, code) => format !== 'currency' || code !== undefined;
const CURRENCY_MESSAGE = { message: 'currency is required with the "currency" format', path: ['currency'] };
/** An `http(s)` image URL; the host also checks its origin (Phase 5a §4). */
const imageUrl = z
    .string()
    .max(2048)
    .refine((value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    }
    catch {
        return false;
    }
}, 'must be an https URL');
const tableProps = z
    .strictObject({
    columns: z.array(z
        .strictObject({
        key: z.string().min(1),
        title: z.string(),
        width: z.number().positive().optional(),
        align: z.enum(COLUMN_ALIGNS).optional(),
        // Phase 5a §6.2: number formatting and host-side sorting.
        format: z.enum(COLUMN_FORMATS).optional(),
        currency: currency.optional(),
        sortable: z.boolean().optional(),
    })
        .refine((column) => needsCurrency(column.format, column.currency), CURRENCY_MESSAGE)),
    rows: z.array(z.strictObject({
        key,
        cells: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    })),
    onSelectRow: handler.optional(),
    emptyText: z.string().optional(),
    defaultSort: z.strictObject({ key: z.string().min(1), direction: z.enum(SORT_DIRECTIONS) }).optional(),
});
const formProps = z.strictObject({
    onSubmit: handler,
    submitLabel: z.string().optional(),
    cancelLabel: z.string().optional(),
    onCancel: handler.optional(),
});
const fieldName = z.string().min(1);
const textFieldProps = z.strictObject({
    name: fieldName,
    label,
    value: z.string().optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    secure: z.boolean().optional(),
    required: z.boolean().optional(),
    error: z.string().optional(),
    onChange: handler.optional(),
    // Phase 5a §6.2: the host limits input and shows an "n/max" counter (Unicode code points).
    maxLength: z.number().int().min(1).max(TEXT_FIELD_MAX_LENGTH).optional(),
});
const selectProps = z.strictObject({
    name: fieldName,
    label,
    value: z.string().nullable().optional(),
    options: z.array(z.strictObject({ value: z.string(), label: z.string() })),
    placeholder: z.string().optional(),
    onChange: handler.optional(),
});
const datePickerProps = z.strictObject({
    name: fieldName,
    label,
    value: z.string().regex(ISO_DATE_PATTERN, 'value must be an ISO date (YYYY-MM-DD) or date-time').nullable().optional(),
    mode: z.enum(DATE_PICKER_MODES).optional(),
    onChange: handler.optional(),
});
const buttonProps = z.strictObject({
    label,
    onPress: handler,
    variant: z.enum(BUTTON_VARIANTS).optional(),
    icon: icon.optional(),
    disabled: z.boolean().optional(),
    loading: z.boolean().optional(),
});
const menuProps = z
    .strictObject({
    label: z.string().optional(),
    icon: icon.optional(),
    items: z.array(z.strictObject({
        key,
        label: z.string(),
        icon: icon.optional(),
        destructive: z.boolean().optional(),
        disabled: z.boolean().optional(),
    })),
    onSelect: handler,
})
    .refine((props) => props.label !== undefined || props.icon !== undefined, {
    message: 'Menu needs a label or an icon',
    path: ['label'],
});
const cardProps = z.strictObject({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    actions: z.array(actionSchema).optional(),
    padding: z.enum(SPACINGS).optional(),
});
const badgeProps = z.strictObject({ text: z.string(), tone: z.enum(TONES).optional() });
const emptyStateProps = z.strictObject({
    title: z.string(),
    description: z.string().optional(),
    icon: icon.optional(),
    action: z.strictObject({ label, onPress: handler }).optional(),
});
const chartProps = z
    .strictObject({
    kind: z.enum(CHART_KINDS),
    series: z.array(z.strictObject({
        name: z.string(),
        points: z.array(z.strictObject({ x: z.string(), y: z.number() })),
    })),
    height: z.number().int().positive().max(2000).optional(),
    // Phase 5a §6.2.
    stacked: z.boolean().optional(),
    valueFormat: z.enum(VALUE_FORMATS).optional(),
    currency: currency.optional(),
})
    .refine((props) => needsCurrency(props.valueFormat, props.currency), CURRENCY_MESSAGE)
    .refine((props) => props.stacked !== true || props.kind !== 'line', { message: 'stacked is for "bar" and "area" charts', path: ['stacked'] });
// ---- Phase 5a (§4, §6) ----
const tabsProps = z.strictObject({
    items: z
        .array(z.strictObject({
        key,
        label: z.string().max(TABS_LIMITS.labelMax),
        badge: z.union([z.string().max(16), z.number()]).optional(),
        disabled: z.boolean().optional(),
    }))
        .min(TABS_LIMITS.min)
        .max(TABS_LIMITS.max),
    value: key,
    /** The tab group's accessible name (hosts default to "Bölümler"). */
    label: z.string().max(TABS_LIMITS.labelMax).optional(),
    onChange: handler,
});
const switchProps = z.strictObject({
    label,
    value: z.boolean(),
    description: z.string().optional(),
    disabled: z.boolean().optional(),
    onChange: handler.optional(),
});
const multiSelectProps = z.strictObject({
    label,
    value: z.array(z.string()),
    options: z.array(z.strictObject({ value: z.string(), label: z.string() })).max(MULTI_SELECT_MAX_OPTIONS),
    placeholder: z.string().optional(),
    max: z.number().int().positive().optional(),
    disabled: z.boolean().optional(),
    onChange: handler.optional(),
});
const statProps = z
    .strictObject({
    label,
    value: z.union([z.number(), z.string(), z.null()]),
    format: z.enum(VALUE_FORMATS).optional(),
    currency: currency.optional(),
    delta: z.number().optional(),
    deltaGood: z.enum(['up', 'down']).optional(),
    caption: z.string().optional(),
})
    .refine((props) => needsCurrency(props.format, props.currency), CURRENCY_MESSAGE);
const bannerProps = z.strictObject({
    tone: z.enum(BANNER_TONES),
    title: z.string().optional(),
    text: z.string(),
    action: z.strictObject({ label, onPress: handler }).optional(),
    onDismiss: handler.optional(),
});
const imageProps = z.strictObject({
    src: imageUrl,
    alt: z.string(),
    aspectRatio: z.number().min(IMAGE_ASPECT_RATIO.min).max(IMAGE_ASPECT_RATIO.max).optional(),
    fit: z.enum(IMAGE_FITS).optional(),
    poster: imageUrl.optional(),
});
const avatarProps = z.strictObject({
    name: z.string(),
    src: imageUrl.optional(),
    size: z.enum(AVATAR_SIZES).optional(),
});
const progressBarProps = z.strictObject({
    value: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
    tone: z.enum(PROGRESS_TONES).optional(),
});
const schemas = {
    Screen: screenProps,
    Stack: stackProps,
    Text: textProps,
    List: listProps,
    Table: tableProps,
    Form: formProps,
    TextField: textFieldProps,
    Select: selectProps,
    DatePicker: datePickerProps,
    Button: buttonProps,
    Menu: menuProps,
    Card: cardProps,
    Badge: badgeProps,
    EmptyState: emptyStateProps,
    Chart: chartProps,
    Tabs: tabsProps,
    Switch: switchProps,
    MultiSelect: multiSelectProps,
    Stat: statProps,
    Banner: bannerProps,
    Image: imageProps,
    Avatar: avatarProps,
    ProgressBar: progressBarProps,
};
/** Strict prop schemas used by `olan-app validate --strict` and the renderer. */
export const componentPropSchemas = schemas;
/**
 * Which children a component accepts: `any` node, only `#text` nodes (`text`),
 * or `none`.
 */
export const COMPONENT_CHILDREN = {
    Screen: 'any',
    Stack: 'any',
    Text: 'text',
    List: 'none',
    Table: 'none',
    Form: 'any',
    TextField: 'none',
    Select: 'none',
    DatePicker: 'none',
    Button: 'none',
    Menu: 'none',
    Card: 'any',
    Badge: 'none',
    EmptyState: 'none',
    Chart: 'none',
    Tabs: 'none',
    Switch: 'none',
    MultiSelect: 'none',
    Stat: 'none',
    Banner: 'none',
    Image: 'none',
    Avatar: 'none',
    ProgressBar: 'none',
};
