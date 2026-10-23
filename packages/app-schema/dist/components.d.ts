import { z } from 'zod';
import { type ComponentType } from './ui.js';
export declare const TONES: readonly ["default", "muted", "accent", "danger", "success", "warning"];
export declare const SPACINGS: readonly ["none", "xs", "sm", "md", "lg"];
export declare const TEXT_VARIANTS: readonly ["title", "heading", "body", "caption", "label"];
export declare const TEXT_WEIGHTS: readonly ["regular", "medium", "semibold", "bold"];
export declare const STACK_ALIGNS: readonly ["start", "center", "end", "stretch"];
export declare const STACK_JUSTIFIES: readonly ["start", "center", "end", "between"];
export declare const COLUMN_ALIGNS: readonly ["start", "center", "end"];
export declare const BUTTON_VARIANTS: readonly ["primary", "secondary", "ghost", "danger"];
export declare const CHART_KINDS: readonly ["bar", "line", "area"];
export declare const DATE_PICKER_MODES: readonly ["date", "datetime"];
/** Phase 5a §6: number formats of `Stat`, `Chart.valueFormat` and `Table` columns (`text` only in tables). */
export declare const VALUE_FORMATS: readonly ["number", "currency", "percent"];
export declare const COLUMN_FORMATS: readonly ["text", "number", "currency", "percent"];
export declare const BANNER_TONES: readonly ["info", "success", "warning", "danger"];
export declare const PROGRESS_TONES: readonly ["default", "success", "warning", "danger"];
export declare const AVATAR_SIZES: readonly ["sm", "md", "lg"];
export declare const IMAGE_FITS: readonly ["cover", "contain"];
export declare const SORT_DIRECTIONS: readonly ["asc", "desc"];
/** ISO 4217 currency code (`TRY`, `USD`). */
export declare const CURRENCY_PATTERN: RegExp;
export declare const TABS_LIMITS: Readonly<{
    min: 2;
    max: 8;
    labelMax: 40;
}>;
export declare const MULTI_SELECT_MAX_OPTIONS = 200;
export declare const TEXT_FIELD_MAX_LENGTH = 100000;
/** `Image.aspectRatio` (width / height) range. */
export declare const IMAGE_ASPECT_RATIO: Readonly<{
    min: 0.1;
    max: 10;
}>;
export type Tone = (typeof TONES)[number];
export type Spacing = (typeof SPACINGS)[number];
/** ISO 8601 date (`YYYY-MM-DD`) or date-time. */
export declare const ISO_DATE_PATTERN: RegExp;
export declare const actionSchema: z.ZodObject<{
    key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    label: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
}, z.core.$strict>;
declare const schemas: {
    Screen: z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        subtitle: z.ZodOptional<z.ZodString>;
        actions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            label: z.ZodString;
            icon: z.ZodOptional<z.ZodString>;
            onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        }, z.core.$strict>>>;
        loading: z.ZodOptional<z.ZodBoolean>;
        scroll: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    Stack: z.ZodObject<{
        direction: z.ZodOptional<z.ZodEnum<{
            vertical: "vertical";
            horizontal: "horizontal";
        }>>;
        gap: z.ZodOptional<z.ZodEnum<{
            none: "none";
            xs: "xs";
            sm: "sm";
            md: "md";
            lg: "lg";
        }>>;
        align: z.ZodOptional<z.ZodEnum<{
            start: "start";
            center: "center";
            end: "end";
            stretch: "stretch";
        }>>;
        justify: z.ZodOptional<z.ZodEnum<{
            start: "start";
            center: "center";
            end: "end";
            between: "between";
        }>>;
        wrap: z.ZodOptional<z.ZodBoolean>;
        padding: z.ZodOptional<z.ZodEnum<{
            none: "none";
            xs: "xs";
            sm: "sm";
            md: "md";
            lg: "lg";
        }>>;
    }, z.core.$strict>;
    Text: z.ZodObject<{
        text: z.ZodOptional<z.ZodString>;
        variant: z.ZodOptional<z.ZodEnum<{
            title: "title";
            body: "body";
            label: "label";
            heading: "heading";
            caption: "caption";
        }>>;
        tone: z.ZodOptional<z.ZodEnum<{
            success: "success";
            default: "default";
            muted: "muted";
            accent: "accent";
            danger: "danger";
            warning: "warning";
        }>>;
        weight: z.ZodOptional<z.ZodEnum<{
            bold: "bold";
            regular: "regular";
            medium: "medium";
            semibold: "semibold";
        }>>;
        truncate: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    List: z.ZodObject<{
        items: z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            title: z.ZodString;
            subtitle: z.ZodOptional<z.ZodString>;
            meta: z.ZodOptional<z.ZodString>;
            badge: z.ZodOptional<z.ZodObject<{
                text: z.ZodString;
                tone: z.ZodOptional<z.ZodEnum<{
                    success: "success";
                    default: "default";
                    muted: "muted";
                    accent: "accent";
                    danger: "danger";
                    warning: "warning";
                }>>;
            }, z.core.$strict>>;
            icon: z.ZodOptional<z.ZodString>;
            disabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        onSelect: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
        emptyText: z.ZodOptional<z.ZodString>;
        loading: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    Table: z.ZodObject<{
        columns: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            title: z.ZodString;
            width: z.ZodOptional<z.ZodNumber>;
            align: z.ZodOptional<z.ZodEnum<{
                start: "start";
                center: "center";
                end: "end";
            }>>;
            format: z.ZodOptional<z.ZodEnum<{
                number: "number";
                currency: "currency";
                percent: "percent";
                text: "text";
            }>>;
            currency: z.ZodOptional<z.ZodString>;
            sortable: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        rows: z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            cells: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodNull]>>;
        }, z.core.$strict>>;
        onSelectRow: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
        emptyText: z.ZodOptional<z.ZodString>;
        defaultSort: z.ZodOptional<z.ZodObject<{
            key: z.ZodString;
            direction: z.ZodEnum<{
                asc: "asc";
                desc: "desc";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    Form: z.ZodObject<{
        onSubmit: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        submitLabel: z.ZodOptional<z.ZodString>;
        cancelLabel: z.ZodOptional<z.ZodString>;
        onCancel: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    TextField: z.ZodObject<{
        name: z.ZodString;
        label: z.ZodString;
        value: z.ZodOptional<z.ZodString>;
        placeholder: z.ZodOptional<z.ZodString>;
        multiline: z.ZodOptional<z.ZodBoolean>;
        secure: z.ZodOptional<z.ZodBoolean>;
        required: z.ZodOptional<z.ZodBoolean>;
        error: z.ZodOptional<z.ZodString>;
        onChange: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
        maxLength: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    Select: z.ZodObject<{
        name: z.ZodString;
        label: z.ZodString;
        value: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        options: z.ZodArray<z.ZodObject<{
            value: z.ZodString;
            label: z.ZodString;
        }, z.core.$strict>>;
        placeholder: z.ZodOptional<z.ZodString>;
        onChange: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    DatePicker: z.ZodObject<{
        name: z.ZodString;
        label: z.ZodString;
        value: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        mode: z.ZodOptional<z.ZodEnum<{
            date: "date";
            datetime: "datetime";
        }>>;
        onChange: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    Button: z.ZodObject<{
        label: z.ZodString;
        onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        variant: z.ZodOptional<z.ZodEnum<{
            danger: "danger";
            primary: "primary";
            secondary: "secondary";
            ghost: "ghost";
        }>>;
        icon: z.ZodOptional<z.ZodString>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        loading: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    Menu: z.ZodObject<{
        label: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
        items: z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            label: z.ZodString;
            icon: z.ZodOptional<z.ZodString>;
            destructive: z.ZodOptional<z.ZodBoolean>;
            disabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        onSelect: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
    }, z.core.$strict>;
    Card: z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        subtitle: z.ZodOptional<z.ZodString>;
        actions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            label: z.ZodString;
            icon: z.ZodOptional<z.ZodString>;
            onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        }, z.core.$strict>>>;
        padding: z.ZodOptional<z.ZodEnum<{
            none: "none";
            xs: "xs";
            sm: "sm";
            md: "md";
            lg: "lg";
        }>>;
    }, z.core.$strict>;
    Badge: z.ZodObject<{
        text: z.ZodString;
        tone: z.ZodOptional<z.ZodEnum<{
            success: "success";
            default: "default";
            muted: "muted";
            accent: "accent";
            danger: "danger";
            warning: "warning";
        }>>;
    }, z.core.$strict>;
    EmptyState: z.ZodObject<{
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        icon: z.ZodOptional<z.ZodString>;
        action: z.ZodOptional<z.ZodObject<{
            label: z.ZodString;
            onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    Chart: z.ZodObject<{
        kind: z.ZodEnum<{
            bar: "bar";
            line: "line";
            area: "area";
        }>;
        series: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            points: z.ZodArray<z.ZodObject<{
                x: z.ZodString;
                y: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        height: z.ZodOptional<z.ZodNumber>;
        stacked: z.ZodOptional<z.ZodBoolean>;
        valueFormat: z.ZodOptional<z.ZodEnum<{
            number: "number";
            currency: "currency";
            percent: "percent";
        }>>;
        currency: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    Tabs: z.ZodObject<{
        items: z.ZodArray<z.ZodObject<{
            key: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
            label: z.ZodString;
            badge: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            disabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        value: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        /** The tab group's accessible name (hosts default to "Bölümler"). */
        label: z.ZodOptional<z.ZodString>;
        onChange: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
    }, z.core.$strict>;
    Switch: z.ZodObject<{
        label: z.ZodString;
        value: z.ZodBoolean;
        description: z.ZodOptional<z.ZodString>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        onChange: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    MultiSelect: z.ZodObject<{
        label: z.ZodString;
        value: z.ZodArray<z.ZodString>;
        options: z.ZodArray<z.ZodObject<{
            value: z.ZodString;
            label: z.ZodString;
        }, z.core.$strict>>;
        placeholder: z.ZodOptional<z.ZodString>;
        max: z.ZodOptional<z.ZodNumber>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        onChange: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    Stat: z.ZodObject<{
        label: z.ZodString;
        value: z.ZodUnion<readonly [z.ZodNumber, z.ZodString, z.ZodNull]>;
        format: z.ZodOptional<z.ZodEnum<{
            number: "number";
            currency: "currency";
            percent: "percent";
        }>>;
        currency: z.ZodOptional<z.ZodString>;
        delta: z.ZodOptional<z.ZodNumber>;
        deltaGood: z.ZodOptional<z.ZodEnum<{
            up: "up";
            down: "down";
        }>>;
        caption: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    Banner: z.ZodObject<{
        tone: z.ZodEnum<{
            success: "success";
            danger: "danger";
            warning: "warning";
            info: "info";
        }>;
        title: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        action: z.ZodOptional<z.ZodObject<{
            label: z.ZodString;
            onPress: z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>;
        }, z.core.$strict>>;
        onDismiss: z.ZodOptional<z.ZodType<import("./ui.js").HandlerRef, unknown, z.core.$ZodTypeInternals<import("./ui.js").HandlerRef, unknown>>>;
    }, z.core.$strict>;
    Image: z.ZodObject<{
        src: z.ZodString;
        alt: z.ZodString;
        aspectRatio: z.ZodOptional<z.ZodNumber>;
        fit: z.ZodOptional<z.ZodEnum<{
            cover: "cover";
            contain: "contain";
        }>>;
        poster: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    Avatar: z.ZodObject<{
        name: z.ZodString;
        src: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodEnum<{
            sm: "sm";
            md: "md";
            lg: "lg";
        }>>;
    }, z.core.$strict>;
    ProgressBar: z.ZodObject<{
        value: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
        tone: z.ZodOptional<z.ZodEnum<{
            success: "success";
            default: "default";
            danger: "danger";
            warning: "warning";
        }>>;
    }, z.core.$strict>;
};
/** Strict prop schemas used by `olan-app validate --strict` and the renderer. */
export declare const componentPropSchemas: Record<ComponentType, z.ZodType>;
/** Wire-level props of a component (handlers as `{ $handler }`). */
export type ComponentProps<T extends ComponentType> = z.output<(typeof schemas)[T]>;
/**
 * Which children a component accepts: `any` node, only `#text` nodes (`text`),
 * or `none`.
 */
export declare const COMPONENT_CHILDREN: Record<ComponentType, 'any' | 'text' | 'none'>;
export {};
