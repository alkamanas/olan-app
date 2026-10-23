import type { JsonValue } from './json.js';
export declare const FILE_PICK_SOURCES: readonly ["device"];
export type FilePickSource = (typeof FILE_PICK_SOURCES)[number];
export declare const FILES_LIMITS: Readonly<{
    /** Default `maxBytes` per file. */
    defaultMaxBytes: number;
    /** Highest `maxBytes`. */
    maxBytes: number;
    /** Highest `maxFiles` (also the default with `multiple`). */
    maxFiles: 20;
    acceptEntries: 32;
    uploadHeaders: 20;
    uploadHeaderValueMax: 4096;
    uploadFields: 50;
    /** The target's response body. */
    uploadResponseBytes: number;
    /** Uploads running at once per sandbox; more wait. */
    concurrentUploads: 4;
    /** No progress for this long fails the upload with `upload_failed`. */
    stallTimeoutMs: 60000;
    /** `upload-progress` messages are at least this far apart (plus a final one). */
    progressIntervalMs: 250;
}>;
/** Request header carrying the file name (`encodeURIComponent(name)`) on every upload. */
export declare const UPLOAD_FILE_NAME_HEADER = "x-olan-file-name";
/** Multipart field name of the file when `formField` is not given. */
export declare const DEFAULT_UPLOAD_FORM_FIELD = "file";
/** Headers an app may not set on an upload (plus every `x-olan-*`). */
export declare const FORBIDDEN_UPLOAD_HEADERS: readonly ["host", "content-length", "cookie", "connection", "transfer-encoding", "origin", "referer"];
export declare const FILE_ID_PREFIX = "file_";
export declare const UPLOAD_ID_PREFIX = "upl_";
/** A picked file; the bytes stay with the host. Valid while the sandbox runs. */
export interface FileHandle {
    /** `file_…`. */
    id: string;
    name: string;
    size: number;
    /** MIME type; `application/octet-stream` when unknown. */
    type: string;
    /** Epoch milliseconds, when known. */
    lastModified?: number;
}
export interface FilePickOptions {
    /** MIME types (`image/jpeg`), wildcards (`image/*`) or extensions (`.pdf`); ≤ 32. Default: any file. */
    accept?: string[];
    multiple?: boolean;
    /** Per file; default 100 MiB, at most 1 GiB. Larger files are left out. */
    maxBytes?: number;
    /** 1–20; default 20 with `multiple`, else 1. */
    maxFiles?: number;
    source?: FilePickSource;
}
export interface NormalizedFilePickOptions {
    accept: string[];
    multiple: boolean;
    maxBytes: number;
    maxFiles: number;
    source: FilePickSource;
}
/** `files.upload` wire params (the SDK adds `uploadId` and `fileId`). */
export interface FileUploadParams {
    /** `upl_…`, made by the SDK; `files.cancel` and `upload-progress` use it. */
    uploadId: string;
    fileId: string;
    url: string;
    method?: 'PUT' | 'POST';
    headers?: Record<string, string>;
    /** POST: the file's multipart field name (default `file`). */
    formField?: string;
    /** POST: form fields sent before the file. */
    fields?: Record<string, string>;
}
/** Result of `files.upload`: every HTTP status (like `http.fetch`). */
export interface FileUploadResult {
    status: number;
    headers: {
        'content-type'?: string;
        etag?: string;
        location?: string;
    };
    /** Parsed JSON for a JSON `content-type`, else text. */
    body: JsonValue;
}
/** Headers of the target's response passed to the app. */
export declare const UPLOAD_RESPONSE_HEADERS: readonly ["content-type", "etag", "location"];
export type NormalizePickOptionsResult = {
    ok: true;
    options: NormalizedFilePickOptions;
} | {
    ok: false;
    message: string;
};
/** Checks `files.pick` options and fills the defaults. */
export declare function normalizePickOptions(input: unknown): NormalizePickOptionsResult;
/** Whether a file matches `accept` (empty: any file). Extensions compare case-insensitively. */
export declare function acceptsFile(accept: readonly string[], file: {
    name: string;
    type: string;
}): boolean;
export type UploadTargetProblem = 'not_url' | 'scheme' | 'credentials' | 'http_public' | 'origin';
/**
 * Whether an upload may go to `url` (contract §3.2): `https:` (`http:` only for loopback/private
 * hosts in development installations), no credentials, and the origin of `remote.url` (with the
 * installation's override) or a host granted as `http:<host>`. Null when allowed.
 */
export declare function uploadTargetProblem(url: unknown, context: {
    remoteUrl?: string | null;
    permissions: readonly string[];
    development?: boolean;
}): UploadTargetProblem | null;
export type ValidateUploadParamsResult = {
    ok: true;
    params: Required<Pick<FileUploadParams, 'uploadId' | 'fileId' | 'url' | 'method' | 'formField'>> & {
        headers: Record<string, string>;
        fields: Record<string, string>;
    };
} | {
    ok: false;
    message: string;
};
/** Checks `files.upload` wire params (the target rule is `uploadTargetProblem`). Header names are lowercased. */
export declare function validateUploadParams(input: unknown): ValidateUploadParamsResult;
/** The `x-olan-file-name` header value of a file name. */
export declare function uploadFileNameHeader(name: string): string;
