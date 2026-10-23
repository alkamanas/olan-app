/*
 * Media Desk's own server (manifest `remote` with `"requests": true`, Phase 5a contract §1, §3, §5),
 * a small Node test server:
 *   node remote-server/server.ts            (Node ≥ 22.18 / 24: runs the TypeScript directly)
 *
 * - `GET  /.well-known/jwks.json`   the app's public key (manifest `remote.jwksUrl`)
 * - `POST /olan/requests`           `olan.remote.request`: verified and routed by `olan.handleRequest`
 *                                    (routes in `routes.ts`); answers HTTP 200 + `{ status, headers?, body }`
 * - `PUT  /olan/uploads/:id?token=` `olan.files.upload` target (raw bytes, one-time token, CORS for Olan web)
 * - `GET  /olan/media/:id`          the uploaded bytes (`Image` src: same origin as `remote.url`)
 * - `GET  /oauth/authorize`         a stand-in for a network's sign-in page: redirects to the app's
 *                                    return address (`/apps/return/<installationId>?state=…&connection=connected&account=…`)
 * - `GET  /health`, `GET /`         health and a plain page (`olan.ui.openUrl`)
 *
 * Env: PORT (4419), OLAN_ISSUERS (comma-separated, default http://localhost:4000: always list the Olan
 * servers explicitly), OLAN_WEB_ORIGIN (Olan web origin for return addresses when the issuer's
 * `/.well-known/olan` has no `webOrigin`), OLAN_WEB_ORIGINS (CORS origins for uploads, default
 * http://localhost:3000), PUBLIC_URL (default http://127.0.0.1:<PORT>), MEDIA_DESK_DATA_DIR
 * (default remote-server/.data: app-key.json), PROCESSING_MS (3000).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createOlanServer, fromNodeRequest, generateAppKey, OlanServerError, sendNodeResponse, type OlanServer, type RemoteRequestContext } from '@olan-app/sdk/server';

import { MEDIA_MAX_BYTES } from '../src/model.ts';
import { createMediaStore, createRoutes, type MediaStore } from './routes.ts';

export const APP_ID = 'com.olan.examples.media-desk';
export const DEFAULT_PORT = 4419;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ISSUERS: readonly string[] = ['http://localhost:4000'];
export const DEFAULT_WEB_ORIGINS: readonly string[] = ['http://localhost:3000'];
/** Signed requests are small (≤ 1 MiB body plus the envelope). */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

export interface MediaDeskServerOptions {
  /** Olan servers accepted (`olan-issuer`); default `OLAN_ISSUERS` or http://localhost:4000. */
  issuers?: readonly string[];
  /** Fallback Olan web origin for return addresses; default `OLAN_WEB_ORIGIN`. */
  webOrigin?: string;
  /** Browser origins allowed to upload (CORS); default `OLAN_WEB_ORIGINS` or http://localhost:3000. */
  webOrigins?: readonly string[];
  /** This server's public base; default `PUBLIC_URL` or `http://127.0.0.1:<port>` once listening. */
  publicUrl?: string;
  dataDir?: string;
  /** `processing` → `ready` after this many ms (default `PROCESSING_MS` or 3000). */
  processingMs?: number;
  /** Used for the issuer's `/.well-known/olan` and JWKS (tests pass a fake). */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface MediaDeskServer {
  readonly olan: OlanServer;
  readonly keyId: string;
  readonly store: MediaStore;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

type AppKey = { privateKeyPem: string; keyId: string };

/** The app's signing key: `app-key.json` in the data directory, made on the first start. */
async function loadKey(dataDir: string): Promise<AppKey> {
  const file = join(dataDir, 'app-key.json');
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppKey>;
    if (typeof stored.privateKeyPem === 'string' && typeof stored.keyId === 'string') return { privateKeyPem: stored.privateKeyPem, keyId: stored.keyId };
  }
  const generated = await generateAppKey();
  const key = { privateKeyPem: generated.privateKeyPem, keyId: generated.keyId };
  writeFileSync(file, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  return key;
}

const list = (value: string | undefined) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);
const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** Reads a raw upload body up to `max` bytes; null when it is larger. */
async function readBody(request: IncomingMessage, max: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > max) return null;
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function createMediaDeskServer(options: MediaDeskServerOptions = {}): Promise<MediaDeskServer> {
  const dataDir = resolve(options.dataDir ?? process.env.MEDIA_DESK_DATA_DIR ?? join(here, '.data'));
  mkdirSync(dataDir, { recursive: true });
  const issuers = options.issuers ?? list(process.env.OLAN_ISSUERS) ?? DEFAULT_ISSUERS;
  const webOrigins = new Set(options.webOrigins ?? list(process.env.OLAN_WEB_ORIGINS) ?? DEFAULT_WEB_ORIGINS);
  const fallbackWebOrigin = options.webOrigin ?? process.env.OLAN_WEB_ORIGIN ?? null;
  const processingMs = options.processingMs ?? Number(process.env.PROCESSING_MS ?? 3000);
  const now = options.now ?? Date.now;
  const key = await loadKey(dataDir);
  const olan = createOlanServer({ appId: APP_ID, privateKeyPem: key.privateKeyPem, keyId: key.keyId, issuers, now, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const store = createMediaStore();
  let publicUrl = (options.publicUrl ?? process.env.PUBLIC_URL ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`).replace(/\/+$/, '');

  /**
   * The return address of external flows. `olan.appReturnUrl` reads the issuer's `/.well-known/olan`
   * `webOrigin` (Olan 1.5+); an older or development issuer without it uses `OLAN_WEB_ORIGIN`.
   */
  const returnUrl = async (ctx: RemoteRequestContext) => {
    try {
      return await olan.appReturnUrl({ issuer: ctx.issuer, installationId: ctx.installationId });
    } catch (error) {
      if (!fallbackWebOrigin || !(error instanceof OlanServerError) || error.code !== 'web_origin_unknown') throw error;
      return `${new URL(fallbackWebOrigin).origin}/apps/return/${encodeURIComponent(ctx.installationId)}`;
    }
  };
  // `publicUrl` is read on each request (it is known only after `listen` picks the port).
  let routes = createRoutes({ store, publicUrl, returnUrl, now });

  const cors = (request: IncomingMessage): Record<string, string> => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (!webOrigins.has(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'PUT, POST',
      'access-control-allow-headers': 'content-type, x-olan-file-name',
      'access-control-expose-headers': 'etag, location',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  };

  async function upload(request: IncomingMessage, itemId: string, token: string): Promise<Response> {
    const headers = cors(request);
    const found = store.takeUploadToken(itemId, token);
    if (!found) return json(403, { error: 'invalid_upload_token', message: 'The upload address is unknown or already used' }, headers);
    const bytes = await readBody(request, MEDIA_MAX_BYTES);
    if (!bytes) return json(413, { error: 'file_too_large', limitBytes: MEDIA_MAX_BYTES }, headers);
    // The file name always comes from `x-olan-file-name` (URL-encoded), never from the multipart filename.
    const rawName = request.headers['x-olan-file-name'];
    let name = found.item.fileName;
    if (typeof rawName === 'string') {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        // keep the announced name
      }
    }
    const type = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : found.item.type;
    const item = store.saveUpload(found.installationId, itemId, { name, type, bytes });
    setTimeout(() => store.finishProcessing(found.installationId, itemId), processingMs).unref?.();
    return json(201, { item }, { ...headers, etag: `"${itemId}-${bytes.byteLength}"`, location: `${publicUrl}/olan/media/${itemId}` });
  }

  /** The stand-in sign-in page: checks `state`, then sends the person to the stored return address. */
  function authorize(url: URL): Response {
    const state = url.searchParams.get('state') ?? '';
    const pending = store.pending(state);
    if (!pending || url.searchParams.get('return') !== pending.returnUrl) {
      return new Response('<!doctype html><title>Medya Masası</title><p>Bağlantı isteği geçersiz.</p>', { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const target = new URL(pending.returnUrl);
    target.searchParams.set('state', state);
    target.searchParams.set('connection', 'connected');
    target.searchParams.set('account', '@medya-masasi');
    return new Response(null, { status: 302, headers: { location: target.href } });
  }

  async function route(method: string, url: URL, request: IncomingMessage): Promise<Response> {
    const path = url.pathname;
    if (method === 'GET' && path === '/health') return json(200, { ok: true, keyId: key.keyId, publicUrl });
    if (method === 'GET' && path === '/') {
      return new Response('<!doctype html><title>Medya Masası</title><h1>Medya Masası sunucusu</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (method === 'GET' && path === '/.well-known/jwks.json') return json(200, await olan.jwks());
    if (method === 'GET' && path === '/oauth/authorize') return authorize(url);

    const media = /^\/olan\/media\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (media && method === 'GET') {
      const file = store.media(media[1]!);
      if (!file) return json(404, { error: 'not_found' });
      return new Response(file.bytes.slice(), { headers: { 'content-type': file.type, 'cache-control': 'private, max-age=60' } });
    }

    const uploadPath = /^\/olan\/uploads\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (uploadPath && method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    if (uploadPath && method === 'PUT') return upload(request, uploadPath[1]!, url.searchParams.get('token') ?? '');

    if (method === 'POST' && path === '/olan/requests') {
      // Verifies (issuer → kid → Ed25519 → ±5 min, id === webhook-id, no repeated req_ id), routes, wraps.
      return olan.handleRequest(await fromNodeRequest(request, { maxBytes: MAX_REQUEST_BYTES }), routes);
    }
    return json(404, { error: 'not_found' });
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let answer: Response;
    try {
      answer = await route((request.method ?? 'GET').toUpperCase(), url, request);
    } catch (error) {
      if (error instanceof OlanServerError) answer = json(error.status, { error: error.code, message: error.message });
      else {
        console.error('media-desk remote server:', error instanceof Error ? error.message : error);
        answer = json(500, { error: 'internal_error' });
      }
    }
    await sendNodeResponse(response, answer);
  };

  let server: Server | null = null;
  return {
    olan,
    keyId: key.keyId,
    store,
    handle,
    listen(port = DEFAULT_PORT, host = DEFAULT_HOST) {
      return new Promise((resolveListen, reject) => {
        server = createServer((request, response) => void handle(request, response));
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server!.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          const url = `http://${host}:${actual}`;
          if (!options.publicUrl && !process.env.PUBLIC_URL) {
            publicUrl = url;
            routes = createRoutes({ store, publicUrl, returnUrl, now });
          }
          resolveListen({ port: actual, url });
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        if (!server) return resolveClose();
        server.close(() => resolveClose());
        server = null;
      });
    },
  };
}

// Started directly: `node remote-server/server.ts`. (A bundle that includes this module, e.g. a
// test, has another file name and never listens.)
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && /[\\/]remote-server[\\/]server\.ts$/.test(self) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = await createMediaDeskServer();
  const { url } = await server.listen(port, DEFAULT_HOST);
  console.log(`Medya Masası app server on ${url} (remote.url ${url}/olan, key ${server.keyId})`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
