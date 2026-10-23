/*
 * The routes `olan.remote.request` reaches (`POST {remote.url}/requests`, routed by `handleRequest`).
 * Plain data in memory: replace the store with your database. Ids are per installation, so
 * one Olan organization never sees another's items.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { RequestError, type RemoteRequestContext, type RemoteRoutes } from '@olan-app/sdk/server';

/** The largest upload the target accepts (the app asks the picker for the same limit). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** A `type`, not an `interface`: route bodies are `JsonValue`, and only type aliases fit its index signature. */
export type Item = {
  id: string;
  title: string;
  status: 'awaiting_upload' | 'ready';
  fileName: string | null;
  size: number | null;
  /** `user.id` of the person who created it (the central Olan user id). */
  createdBy: string;
};

export interface Store {
  list(installationId: string): Item[];
  create(installationId: string, item: Omit<Item, 'id' | 'status' | 'fileName' | 'size'>): { item: Item; token: string };
  remove(installationId: string, id: string): boolean;
  /** The item a one-time upload token belongs to (the token is used up). */
  takeUpload(id: string, token: string): { installationId: string; item: Item } | null;
  finishUpload(installationId: string, id: string, file: { name: string; size: number }): Item | null;
}

export function createStore(): Store {
  const items = new Map<string, Map<string, Item>>();
  const uploads = new Map<string, { installationId: string; token: string }>();
  const of = (installationId: string) => {
    let map = items.get(installationId);
    if (!map) items.set(installationId, (map = new Map()));
    return map;
  };
  return {
    list: (installationId) => [...of(installationId).values()],
    create(installationId, input) {
      const item: Item = { id: `it_${randomUUID().slice(0, 8)}`, status: 'awaiting_upload', fileName: null, size: null, ...input };
      of(installationId).set(item.id, item);
      const token = randomBytes(16).toString('hex');
      uploads.set(item.id, { installationId, token });
      return { item, token };
    },
    remove(installationId, id) {
      uploads.delete(id);
      return of(installationId).delete(id);
    },
    takeUpload(id, token) {
      const pending = uploads.get(id);
      if (!pending || pending.token !== token) return null;
      uploads.delete(id);
      const item = of(pending.installationId).get(id);
      return item ? { installationId: pending.installationId, item } : null;
    },
    finishUpload(installationId, id, file) {
      const item = of(installationId).get(id);
      if (!item) return null;
      Object.assign(item, { status: 'ready', fileName: file.name, size: file.size });
      return item;
    },
  };
}

/** Requests always come from a person in SDK 1.5; without `user` (the app identity) refuse. */
function person(ctx: RemoteRequestContext) {
  if (!ctx.user) throw new RequestError(403, { error: 'person_required', message: 'This route acts for a person' });
  return ctx.user;
}

/** The routes; `publicUrl()` is where uploads go (the `remote.url` origin). */
export function createRoutes(store: Store, publicUrl: () => string): RemoteRoutes {
  return {
    'GET /items': (ctx) => {
      person(ctx);
      return { body: { items: store.list(ctx.installationId) } };
    },
    'POST /items': (ctx) => {
      const user = person(ctx);
      const input = (ctx.body ?? {}) as { title?: unknown; size?: unknown };
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 120) throw new RequestError(422, { error: 'validation_failed', issues: { title: 'Başlık 1–120 karakter olmalı' } });
      if (typeof input.size === 'number' && input.size > MAX_UPLOAD_BYTES) throw new RequestError(413, { error: 'file_too_large', limitBytes: MAX_UPLOAD_BYTES });
      const { item, token } = store.create(ctx.installationId, { title, createdBy: user.id });
      return { status: 201, body: { item, upload: { url: `${publicUrl()}/olan/uploads/${item.id}?token=${token}`, method: 'PUT' } } };
    },
    'DELETE /items/:id': (ctx) => {
      person(ctx);
      if (!store.remove(ctx.installationId, ctx.params.id!)) throw new RequestError(404, { error: 'item_not_found', message: 'Kayıt bulunamadı' });
      return { status: 204 };
    },
  };
}
