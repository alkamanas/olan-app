/*
 * The app's own server (manifest `remote`), a plain Node HTTP server. Not `server/`: that folder is
 * backend code Olan runs for you (manifest `server`, backend.md). This one you run and host yourself:
 *
 *   npm run server          (node app-server/server.ts: Node ≥ 22.18 runs TypeScript directly;
 *                            older Node: node --experimental-strip-types app-server/server.ts)
 *
 * - `POST /olan/requests`          `olan.remote.request`: verified and routed by `olan.handleRequest`
 * - `PUT  /olan/uploads/:id?token=` the `olan.files.upload` target (raw bytes, one-time token, CORS)
 * - `GET  /.well-known/jwks.json`  the app's public key (manifest `remote.jwksUrl`)
 *
 * Env: PORT (4100), OLAN_ISSUERS (comma-separated Olan servers you accept; default
 * http://localhost:4000 and the CLI's development issuer http://127.0.0.1:5180), OLAN_WEB_ORIGINS
 * (browser origins that may upload, default http://localhost:3000), PUBLIC_URL (default
 * http://127.0.0.1:<PORT>), OLAN_APP_KEY (PKCS#8 PEM; without it a new key is made at every start).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createOlanServer, fromNodeRequest, generateAppKey, OlanServerError, sendNodeResponse, type OlanServer } from '@olan-app/sdk/server';

import { createRoutes, createStore, MAX_UPLOAD_BYTES, type Store } from './routes.ts';

export const APP_ID = '{{appId}}';
export const DEFAULT_PORT = 4100;
const list = (value: string | undefined) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : null);

export interface AppServerOptions {
  /** Olan servers accepted (`olan-issuer`). Always explicit: anyone can run "an Olan server". */
  issuers?: readonly string[];
  /** Browser origins allowed to upload (CORS: Olan's web origin). */
  webOrigins?: readonly string[];
  /** This server's public base URL (uploads go to `<publicUrl>/olan/uploads/…`); default: where it listens. */
  publicUrl?: string;
  /** PKCS#8 PEM for `jwks()` and installation tokens; `handleRequest` does not need it. */
  privateKeyPem?: string;
}

export interface AppServer {
  readonly olan: OlanServer;
  readonly store: Store;
  readonly url: string;
  close(): Promise<void>;
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/** The raw upload body up to `max` bytes; null when it is larger. */
async function readBody(request: IncomingMessage, max: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > max) return null;
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Starts the server on 127.0.0.1:`port` (`0`: a free port, e.g. in tests). */
export async function startAppServer(port = DEFAULT_PORT, options: AppServerOptions = {}): Promise<AppServer> {
  const issuers = options.issuers ?? list(process.env.OLAN_ISSUERS) ?? ['http://localhost:4000', 'http://127.0.0.1:5180'];
  const webOrigins = new Set(options.webOrigins ?? list(process.env.OLAN_WEB_ORIGINS) ?? ['http://localhost:3000']);
  const privateKeyPem = options.privateKeyPem ?? process.env.OLAN_APP_KEY ?? (await generateAppKey()).privateKeyPem;
  const olan = createOlanServer({ appId: APP_ID, privateKeyPem, issuers });
  const store = createStore();
  let publicUrl = (options.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  const routes = createRoutes(store, () => publicUrl);

  /** CORS for uploads from Olan's web app (iOS and Android do not need it). */
  const cors = (request: IncomingMessage): Record<string, string> => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (!webOrigins.has(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'PUT, POST',
      'access-control-allow-headers': 'content-type, x-olan-file-name',
      'access-control-expose-headers': 'etag, location',
      vary: 'origin',
    };
  };

  async function upload(request: IncomingMessage, id: string, token: string): Promise<Response> {
    const headers = cors(request);
    const found = store.takeUpload(id, token);
    if (!found) return json(403, { error: 'invalid_upload_token' }, headers);
    const bytes = await readBody(request, MAX_UPLOAD_BYTES);
    if (!bytes) return json(413, { error: 'file_too_large', limitBytes: MAX_UPLOAD_BYTES }, headers);
    // The name comes from x-olan-file-name (URL-encoded), never from a multipart filename.
    const header = request.headers['x-olan-file-name'];
    let name = 'file';
    try {
      if (typeof header === 'string') name = decodeURIComponent(header);
    } catch {
      // keep the default
    }
    // Store `bytes` here (disk, object storage); the template keeps only the size.
    const item = store.finishUpload(found.installationId, id, { name, size: bytes.byteLength });
    return json(201, { item }, { ...headers, etag: `"${id}-${bytes.byteLength}"` });
  }

  async function route(request: IncomingMessage): Promise<Response> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/olan/requests') {
      // Verifies (issuer → kid → Ed25519 → ±5 min → id === webhook-id → no repeated req_ id), routes, wraps.
      return olan.handleRequest(await fromNodeRequest(request, { maxBytes: 2 * 1024 * 1024 }), routes);
    }
    const uploadPath = /^\/olan\/uploads\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (uploadPath && method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    if (uploadPath && method === 'PUT') return upload(request, uploadPath[1]!, url.searchParams.get('token') ?? '');
    if (method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(200, await olan.jwks());
    if (method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let answer: Response;
    try {
      answer = await route(request);
    } catch (error) {
      answer = error instanceof OlanServerError ? json(error.status, { error: error.code, message: error.message }) : json(500, { error: 'internal_error' });
      if (!(error instanceof OlanServerError)) console.error(error);
    }
    await sendNodeResponse(response, answer);
  };

  const server: Server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  if (!publicUrl) publicUrl = url;
  return {
    olan,
    store,
    url,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

// `node app-server/server.ts` starts it; tests import `startAppServer` instead.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && /[\\/]app-server[\\/]server\.ts$/.test(fileURLToPath(import.meta.url))) {
  const server = await startAppServer(Number(process.env.PORT ?? DEFAULT_PORT));
  console.log(`App server on ${server.url} (remote.url ${server.url}/olan)`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
