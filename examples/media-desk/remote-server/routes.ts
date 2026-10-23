/*
 * Media Desk's request routes (`POST {remote.url}/requests`, Phase 5a contract §1.8) and their
 * in-memory store. No Node I/O here: `server.ts` serves them over HTTP with `olan.handleRequest`, and
 * the surface tests pass the same table to `renderApp({ remote })`, so tests and production route alike.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { PROFILE_REQUIRED, RequestError, type RemoteRequestContext, type RemoteRequestResult, type RemoteRoutes } from '@olan-app/sdk/server';

import {
  validateNewItem,
  type Connection,
  type ConnectionState,
  type CreatedMediaItem,
  type MediaItem,
  type MediaStats,
  type NewMediaItem,
  type Profile,
} from '../src/model.ts';

/** One pending account connection (`POST /connections/start` → the external page → `/connections/complete`). */
export interface PendingConnection {
  state: string;
  installationId: string;
  userId: string;
  returnUrl: string;
  createdAt: number;
}

export interface MediaStore {
  items(installationId: string): MediaItem[];
  item(installationId: string, id: string): MediaItem | undefined;
  add(installationId: string, item: MediaItem): void;
  /** The item a one-time upload token belongs to; the token is used up. */
  takeUploadToken(itemId: string, token: string): { installationId: string; item: MediaItem } | null;
  /** Stores the uploaded bytes and marks the item `processing`. */
  saveUpload(installationId: string, itemId: string, file: { name: string; type: string; bytes: Uint8Array }): MediaItem;
  /** `processing` → `ready` (the server does it after `processingMs`). */
  finishProcessing(installationId: string, itemId: string): void;
  media(itemId: string): { type: string; bytes: Uint8Array } | undefined;
  pending(state: string): PendingConnection | undefined;
  /** Removes and returns a pending connection (each `state` is used once). */
  takePending(state: string): PendingConnection | undefined;
  connections: Map<string, Connection>;
  /** Internal maps (the routes below write them). */
  readonly data: {
    items: Map<string, Map<string, MediaItem>>;
    tokens: Map<string, { installationId: string; itemId: string }>;
    media: Map<string, { type: string; bytes: Uint8Array }>;
    pending: Map<string, PendingConnection>;
  };
}

export function createMediaStore(): MediaStore {
  const data: MediaStore['data'] = { items: new Map(), tokens: new Map(), media: new Map(), pending: new Map() };
  const bucket = (installationId: string) => {
    let items = data.items.get(installationId);
    if (!items) {
      items = new Map();
      data.items.set(installationId, items);
    }
    return items;
  };
  return {
    data,
    connections: new Map(),
    items: (installationId) => [...bucket(installationId).values()],
    item: (installationId, id) => bucket(installationId).get(id),
    add: (installationId, item) => void bucket(installationId).set(item.id, item),
    takeUploadToken(itemId, token) {
      const entry = data.tokens.get(token);
      if (!entry || entry.itemId !== itemId) return null;
      data.tokens.delete(token);
      const item = bucket(entry.installationId).get(itemId);
      return item ? { installationId: entry.installationId, item } : null;
    },
    saveUpload(installationId, itemId, file) {
      const item = bucket(installationId).get(itemId)!;
      data.media.set(itemId, { type: file.type, bytes: file.bytes });
      item.status = 'processing';
      item.fileName = file.name;
      item.size = file.bytes.byteLength;
      return item;
    },
    finishProcessing(installationId, itemId) {
      const item = bucket(installationId).get(itemId);
      if (item && item.status === 'processing') item.status = 'ready';
    },
    media: (itemId) => data.media.get(itemId),
    pending: (state) => data.pending.get(state),
    takePending(state) {
      const found = data.pending.get(state);
      data.pending.delete(state);
      return found;
    },
  };
}

export interface RouteOptions {
  store: MediaStore;
  /** Public base of this server, e.g. `http://127.0.0.1:4419` (upload, media and sign-in URLs). */
  publicUrl: string;
  /** The person's return address (`https://<Olan web>/apps/return/<installationId>`). */
  returnUrl: (ctx: RemoteRequestContext) => string | Promise<string>;
  now?: () => number;
}

/** A pending connection expires after this long (the host gives up waiting after 30 minutes too). */
const CONNECTION_TTL_MS = 30 * 60 * 1000;

/** Typed answers (interfaces) as the route's JSON body. */
const json = (value: unknown) => value as RemoteRequestResult['body'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The person, or a 403 for app-identity calls (no `user`: never act on someone's behalf). */
function person(ctx: RemoteRequestContext) {
  if (!ctx.user) throw new RequestError(403, { error: 'person_required', message: 'This route needs a person' });
  return ctx.user;
}

/** Deterministic sample figures per item, so the analytics look alive without a real network. */
function sampleFigures(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { views: 400 + (hash % 9600), spend: Math.round(((hash >>> 8) % 50000) / 10) / 10, engagement: Math.round((0.01 + ((hash >>> 4) % 80) / 1000) * 1000) / 1000 };
}

/**
 * Answers a thrown `RequestError` with its status and body. `handleRequest` does this too, but it checks
 * `instanceof`: the CLI test host bundles its own copy of the class, so routes shared with
 * `renderApp({ remote })` convert it here by name.
 */
function answeringErrors(routes: RemoteRoutes): RemoteRoutes {
  return Object.fromEntries(
    Object.entries(routes).map(([key, handler]) => [
      key,
      async (ctx: RemoteRequestContext) => {
        try {
          return await handler(ctx);
        } catch (error) {
          if (error instanceof Error && error.name === 'RequestError') {
            const { status, body, headers } = error as RequestError;
            return { status, body, ...(headers ? { headers } : {}) };
          }
          throw error;
        }
      },
    ]),
  );
}

export function createRoutes(options: RouteOptions): RemoteRoutes {
  return answeringErrors(routeTable(options));
}

function routeTable(options: RouteOptions): RemoteRoutes {
  const { store, publicUrl } = options;
  const now = options.now ?? Date.now;
  const base = publicUrl.replace(/\/+$/, '');

  return {
    'GET /me': (ctx) => {
      const user = person(ctx);
      const profile: Profile = { id: user.id, displayName: user.displayName ?? null, email: user.email ?? null, role: user.role ?? null };
      return { body: json(profile) };
    },

    'GET /items': (ctx) => {
      person(ctx);
      const items = store.items(ctx.installationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { headers: { etag: `"${items.length}-${items.map((item) => item.status[0]).join('')}"` }, body: json({ items }) };
    },

    'POST /items': (ctx) => {
      const user = person(ctx);
      const input = (isObject(ctx.body) ? ctx.body : {}) as Partial<NewMediaItem>;
      const issues = validateNewItem(input);
      if (Object.keys(issues).length > 0) throw new RequestError(422, { error: 'validation_failed', issues });
      const id = `m_${randomUUID().slice(0, 8)}`;
      const figures = sampleFigures(id);
      const item: MediaItem = {
        id,
        title: input.title!.trim(),
        caption: input.caption ?? '',
        channels: input.channels!,
        publishNow: input.publishNow === true,
        status: 'awaiting_upload',
        fileName: input.fileName!,
        type: input.type!,
        size: input.size!,
        mediaUrl: `${base}/olan/media/${id}`,
        ownerId: user.id,
        // `displayName` is in the envelope only when the person granted `profile:read`.
        ownerName: user.displayName ?? 'Olan kullanıcısı',
        ...figures,
        createdAt: new Date(now()).toISOString(),
      };
      store.add(ctx.installationId, item);
      const token = randomBytes(18).toString('base64url');
      store.data.tokens.set(token, { installationId: ctx.installationId, itemId: id });
      const created: CreatedMediaItem = { item, upload: { url: `${base}/olan/uploads/${id}?token=${token}`, method: 'PUT' } };
      return { status: 201, body: json(created) };
    },

    'GET /items/:id': (ctx) => {
      person(ctx);
      const item = store.item(ctx.installationId, ctx.params.id!);
      if (!item) throw new RequestError(404, { error: 'item_not_found', message: 'Medya bulunamadı' });
      return { body: json({ item }) };
    },

    'DELETE /items/:id': (ctx) => {
      const user = person(ctx);
      const item = store.item(ctx.installationId, ctx.params.id!);
      if (!item) throw new RequestError(404, { error: 'item_not_found', message: 'Medya bulunamadı' });
      // Owners delete their own media; admins (`user.role`, `profile:read`) delete anything.
      if (item.ownerId !== user.id && user.role !== 'admin') throw new RequestError(403, { error: 'not_owner', message: 'Yalnız yükleyen ya da yönetici silebilir' });
      store.data.items.get(ctx.installationId)?.delete(item.id);
      store.data.media.delete(item.id);
      return { status: 204 };
    },

    'GET /stats': (ctx) => {
      person(ctx);
      const items = store.items(ctx.installationId);
      const views = items.reduce((sum, item) => sum + item.views, 0);
      const spend = Math.round(items.reduce((sum, item) => sum + item.spend, 0) * 100) / 100;
      const engagement = items.length ? Math.round((items.reduce((sum, item) => sum + item.engagement, 0) / items.length) * 1000) / 1000 : 0;
      const days = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(now() - (6 - index) * 86_400_000).toISOString().slice(0, 10);
        const share = (index + 1) / 28;
        return { day, organic: Math.round(spend * share * 0.4), paid: Math.round(spend * share * 0.6), engagement: Math.round(engagement * (0.8 + index / 15) * 1000) / 1000 };
      });
      const stats: MediaStats = { views, spend, engagement, delta: { views: 0.124, spend: -0.05, engagement: 0.018 }, days };
      return { body: json(stats) };
    },

    'GET /connections': (ctx) => {
      person(ctx);
      const state: ConnectionState = { connection: store.connections.get(ctx.installationId) ?? null, webUrl: `${base}/` };
      return { body: json(state) };
    },

    /** Starts an account connection: a `state` and the external page that sends the person back. */
    'POST /connections/start': async (ctx) => {
      const user = person(ctx);
      // The external account is linked to the person's email: without `profile:read` there is none.
      if (!user.email) throw new RequestError(409, { error: PROFILE_REQUIRED, message: 'Hesap bağlamak için "Profilinizi görme" iznini verin' });
      const returnUrl = await options.returnUrl(ctx);
      const state = randomBytes(16).toString('base64url');
      store.data.pending.set(state, { state, installationId: ctx.installationId, userId: user.id, returnUrl, createdAt: now() });
      const authorizeUrl = `${base}/oauth/authorize?${new URLSearchParams({ state, return: returnUrl }).toString()}`;
      return { status: 201, body: { authorizeUrl, state } };
    },

    /** Finishes it with the return address's parameters; the `state` must be ours, fresh and this person's. */
    'POST /connections/complete': (ctx) => {
      const user = person(ctx);
      const body = isObject(ctx.body) ? ctx.body : {};
      const state = typeof body.state === 'string' ? body.state : '';
      const pending = store.pending(state);
      if (!pending || pending.installationId !== ctx.installationId || pending.userId !== user.id || now() - pending.createdAt > CONNECTION_TTL_MS) {
        throw new RequestError(400, { error: 'invalid_state', message: 'Bağlantı isteği geçersiz ya da süresi doldu' });
      }
      store.takePending(state);
      if (body.connection !== 'connected') throw new RequestError(409, { error: 'connection_denied', message: 'Bağlantı onaylanmadı' });
      const account = typeof body.account === 'string' && body.account ? body.account.slice(0, 64) : 'hesap';
      const connection: Connection = { account, connectedAt: new Date(now()).toISOString() };
      store.connections.set(ctx.installationId, connection);
      return { body: json({ connection }) };
    },

    'DELETE /connections': (ctx) => {
      person(ctx);
      store.connections.delete(ctx.installationId);
      return { status: 204 };
    },
  };
}
