import type { JsonValue } from './json.js';
import { isHttpUrlAllowed } from './permissions.js';
import { isPrivateHost } from './remote.js';

/*
 * `olan.files.pick` / `olan.files.upload` (Phase 5a contract §3, G3). The host opens the platform
 * picker and keeps the bytes; the sandbox only gets handles. Uploads go straight from the device or
 * browser to the app's server (or an `http:<host>`), never through Olan.
 */

export const FILE_PICK_SOURCES = ['device'] as const;
export type FilePickSource = (typeof FILE_PICK_SOURCES)[number];

export const FILES_LIMITS = Object.freeze({
  /** Default `maxBytes` per file. */
  defaultMaxBytes: 100 * 1024 * 1024,
  /** Highest `maxBytes`. */
  maxBytes: 1024 * 1024 * 1024,
  /** Highest `maxFiles` (also the default with `multiple`). */
  maxFiles: 20,
  acceptEntries: 32,
  uploadHeaders: 20,
  uploadHeaderValueMax: 4096,
  uploadFields: 50,
  /** The target's response body. */
  uploadResponseBytes: 1024 * 1024,
  /** Uploads running at once per sandbox; more wait. */
  concurrentUploads: 4,
  /** No progress for this long fails the upload with `upload_failed`. */
  stallTimeoutMs: 60_000,
  /** `upload-progress` messages are at least this far apart (plus a final one). */
  progressIntervalMs: 250,
});

/** Request header carrying the file name (`encodeURIComponent(name)`) on every upload. */
export const UPLOAD_FILE_NAME_HEADER = 'x-olan-file-name';
/** Multipart field name of the file when `formField` is not given. */
export const DEFAULT_UPLOAD_FORM_FIELD = 'file';
/** Headers an app may not set on an upload (plus every `x-olan-*`). */
export const FORBIDDEN_UPLOAD_HEADERS = ['host', 'content-length', 'cookie', 'connection', 'transfer-encoding', 'origin', 'referer'] as const;
export const FILE_ID_PREFIX = 'file_';
export const UPLOAD_ID_PREFIX = 'upl_';

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
  headers: { 'content-type'?: string; etag?: string; location?: string };
  /** Parsed JSON for a JSON `content-type`, else text. */
  body: JsonValue;
}

/** Headers of the target's response passed to the app. */
export const UPLOAD_RESPONSE_HEADERS = ['content-type', 'etag', 'location'] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ACCEPT_ENTRY = /^(?:\.[A-Za-z0-9][A-Za-z0-9.+-]{0,31}|[a-z0-9][a-z0-9.+-]{0,63}\/(?:\*|[A-Za-z0-9][A-Za-z0-9.+-]{0,127}))$/;
const FORM_FIELD = /^[A-Za-z0-9_.[\]-]{1,128}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

export type NormalizePickOptionsResult = { ok: true; options: NormalizedFilePickOptions } | { ok: false; message: string };

/** Checks `files.pick` options and fills the defaults. */
export function normalizePickOptions(input: unknown): NormalizePickOptionsResult {
  const value = input === undefined || input === null ? {} : input;
  if (!isObject(value)) return { ok: false, message: 'files.pick options must be an object' };
  for (const key of Object.keys(value)) {
    if (!['accept', 'multiple', 'maxBytes', 'maxFiles', 'source'].includes(key)) return { ok: false, message: `files.pick does not take "${key}"` };
  }
  let accept: string[] = [];
  if (value.accept !== undefined) {
    if (!Array.isArray(value.accept) || value.accept.some((entry) => typeof entry !== 'string' || !ACCEPT_ENTRY.test(entry))) {
      return { ok: false, message: 'accept must be an array of MIME types ("image/jpeg"), wildcards ("image/*") or extensions (".pdf")' };
    }
    if (value.accept.length > FILES_LIMITS.acceptEntries) return { ok: false, message: `accept takes at most ${FILES_LIMITS.acceptEntries} entries` };
    accept = (value.accept as string[]).map((entry) => entry.toLowerCase());
  }
  if (value.multiple !== undefined && typeof value.multiple !== 'boolean') return { ok: false, message: 'multiple must be a boolean' };
  const multiple = value.multiple === true;
  let maxBytes = FILES_LIMITS.defaultMaxBytes;
  if (value.maxBytes !== undefined) {
    if (typeof value.maxBytes !== 'number' || !Number.isInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > FILES_LIMITS.maxBytes) {
      return { ok: false, message: `maxBytes must be an integer from 1 to ${FILES_LIMITS.maxBytes}` };
    }
    maxBytes = value.maxBytes;
  }
  let maxFiles = multiple ? FILES_LIMITS.maxFiles : 1;
  if (value.maxFiles !== undefined) {
    if (typeof value.maxFiles !== 'number' || !Number.isInteger(value.maxFiles) || value.maxFiles < 1 || value.maxFiles > FILES_LIMITS.maxFiles) {
      return { ok: false, message: `maxFiles must be an integer from 1 to ${FILES_LIMITS.maxFiles}` };
    }
    maxFiles = multiple ? value.maxFiles : 1;
  }
  if (value.source !== undefined && !(FILE_PICK_SOURCES as readonly unknown[]).includes(value.source)) {
    return { ok: false, message: `source must be one of ${FILE_PICK_SOURCES.join(', ')}` };
  }
  return { ok: true, options: { accept, multiple, maxBytes, maxFiles, source: 'device' } };
}

/** Whether a file matches `accept` (empty: any file). Extensions compare case-insensitively. */
export function acceptsFile(accept: readonly string[], file: { name: string; type: string }): boolean {
  if (accept.length === 0) return true;
  const type = (file.type || 'application/octet-stream').toLowerCase();
  const name = file.name.toLowerCase();
  return accept.some((entry) => {
    const lower = entry.toLowerCase();
    if (lower.startsWith('.')) return name.endsWith(lower);
    if (lower.endsWith('/*')) return type.startsWith(lower.slice(0, -1));
    return type === lower;
  });
}

export type UploadTargetProblem = 'not_url' | 'scheme' | 'credentials' | 'http_public' | 'origin';

/**
 * Whether an upload may go to `url` (contract §3.2): `https:` (`http:` only for loopback/private
 * hosts in development installations), no credentials, and the origin of `remote.url` (with the
 * installation's override) or a host granted as `http:<host>`. Null when allowed.
 */
export function uploadTargetProblem(url: unknown, context: { remoteUrl?: string | null; permissions: readonly string[]; development?: boolean }): UploadTargetProblem | null {
  if (typeof url !== 'string' || url.length > 4096) return 'not_url';
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return 'not_url';
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'scheme';
  if (target.username || target.password) return 'credentials';
  if (target.protocol === 'http:' && !(context.development === true && isPrivateHost(target.hostname))) return 'http_public';
  if (context.remoteUrl) {
    try {
      if (new URL(context.remoteUrl).origin === target.origin) return null;
    } catch {
      // an invalid remote URL allows nothing
    }
  }
  return isHttpUrlAllowed(url, context.permissions) ? null : 'origin';
}

export type ValidateUploadParamsResult = { ok: true; params: Required<Pick<FileUploadParams, 'uploadId' | 'fileId' | 'url' | 'method' | 'formField'>> & { headers: Record<string, string>; fields: Record<string, string> } } | { ok: false; message: string };

/** Checks `files.upload` wire params (the target rule is `uploadTargetProblem`). Header names are lowercased. */
export function validateUploadParams(input: unknown): ValidateUploadParamsResult {
  if (!isObject(input)) return { ok: false, message: 'files.upload needs { uploadId, fileId, url }' };
  for (const key of Object.keys(input)) {
    if (!['uploadId', 'fileId', 'url', 'method', 'headers', 'formField', 'fields'].includes(key)) return { ok: false, message: `files.upload does not take "${key}"` };
  }
  const { uploadId, fileId, url } = input;
  if (typeof uploadId !== 'string' || !uploadId.startsWith(UPLOAD_ID_PREFIX) || uploadId.length > 128) return { ok: false, message: `uploadId must be an "${UPLOAD_ID_PREFIX}…" string` };
  if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 128) return { ok: false, message: 'fileId must be the id of a picked file' };
  if (typeof url !== 'string' || url.length === 0) return { ok: false, message: 'url must be a string' };
  const method = input.method ?? 'PUT';
  if (method !== 'PUT' && method !== 'POST') return { ok: false, message: 'method must be "PUT" or "POST"' };
  const headers: Record<string, string> = {};
  if (input.headers !== undefined) {
    if (!isObject(input.headers)) return { ok: false, message: 'headers must be an object' };
    const entries = Object.entries(input.headers);
    if (entries.length > FILES_LIMITS.uploadHeaders) return { ok: false, message: `At most ${FILES_LIMITS.uploadHeaders} headers` };
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name) || (FORBIDDEN_UPLOAD_HEADERS as readonly string[]).includes(lower) || lower.startsWith('x-olan-')) {
        return { ok: false, message: `header "${name}" is not allowed on uploads` };
      }
      if (typeof value !== 'string' || value.length > FILES_LIMITS.uploadHeaderValueMax || /[\r\n]/.test(value)) {
        return { ok: false, message: `header "${name}" must be a single-line string of at most ${FILES_LIMITS.uploadHeaderValueMax} characters` };
      }
      headers[lower] = value;
    }
  }
  const formField = input.formField ?? DEFAULT_UPLOAD_FORM_FIELD;
  if (typeof formField !== 'string' || !FORM_FIELD.test(formField)) return { ok: false, message: 'formField must be 1–128 letters, digits or _.[]-' };
  const fields: Record<string, string> = {};
  if (input.fields !== undefined) {
    if (!isObject(input.fields)) return { ok: false, message: 'fields must be an object of strings' };
    const entries = Object.entries(input.fields);
    if (entries.length > FILES_LIMITS.uploadFields) return { ok: false, message: `At most ${FILES_LIMITS.uploadFields} fields` };
    for (const [name, value] of entries) {
      if (!FORM_FIELD.test(name) || typeof value !== 'string') return { ok: false, message: `fields.${name} must be a string with a simple name` };
      fields[name] = value;
    }
  }
  if (method === 'PUT' && (input.formField !== undefined || input.fields !== undefined)) return { ok: false, message: 'formField and fields are for POST (multipart) uploads' };
  return { ok: true, params: { uploadId, fileId, url, method, headers, formField, fields } };
}

/** The `x-olan-file-name` header value of a file name. */
export function uploadFileNameHeader(name: string): string {
  return encodeURIComponent(name);
}
