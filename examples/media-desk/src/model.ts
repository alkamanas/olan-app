/*
 * Shapes shared by the app (src/app.tsx) and its server (remote-server/): what `olan.remote.request`
 * sends and gets back. Plain TypeScript, no imports, so both sides can use it.
 */

export const CHANNELS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'x', label: 'X' },
] as const;
export type Channel = (typeof CHANNELS)[number]['value'];

export const TITLE_MAX = 80;
export const CAPTION_MAX = 280;
/** Per file; the picker leaves larger files out, the server refuses them too. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MEDIA_ACCEPT = ['image/*', 'video/*'];

export type MediaStatus = 'awaiting_upload' | 'processing' | 'ready';

export interface MediaItem {
  id: string;
  title: string;
  caption: string;
  channels: Channel[];
  publishNow: boolean;
  status: MediaStatus;
  fileName: string;
  type: string;
  size: number;
  /** `{remote origin}/olan/media/<id>` once uploaded (the `Image` origin rule). */
  mediaUrl: string | null;
  ownerId: string;
  /** From the envelope's `user.displayName` (`profile:read`); a placeholder without it. */
  ownerName: string;
  views: number;
  /** TRY. */
  spend: number;
  /** A fraction (0.034 = 3.4 %). */
  engagement: number;
  createdAt: string;
}

/** `POST /items` body. */
export interface NewMediaItem {
  title: string;
  caption: string;
  channels: Channel[];
  publishNow: boolean;
  fileName: string;
  type: string;
  size: number;
}

/** `POST /items` answer: the item and where to upload the file (one-time URL). */
export interface CreatedMediaItem {
  item: MediaItem;
  upload: { url: string; method: 'PUT' };
}

export interface MediaStats {
  views: number;
  /** TRY. */
  spend: number;
  engagement: number;
  /** Relative change against the previous 7 days (fractions). */
  delta: { views: number; spend: number; engagement: number };
  /** Last 7 days: spend per channel group (TRY) and engagement (fraction). */
  days: { day: string; organic: number; paid: number; engagement: number }[];
}

export interface Connection {
  account: string;
  connectedAt: string;
}

/** `GET /connections` answer. */
export interface ConnectionState {
  connection: Connection | null;
  /** The server's own page (opened with `olan.ui.openUrl`). */
  webUrl: string;
}

/** `GET /me` answer: what the server learned about the person (`profile:read`). */
export interface Profile {
  id: string;
  displayName: string | null;
  email: string | null;
  role: 'admin' | 'member' | null;
}

/** `422 validation_failed` body. */
export interface ValidationFailure {
  error: 'validation_failed';
  issues: Partial<Record<'title' | 'caption' | 'channels' | 'file', string>>;
}

/** Checks a new item; returns the issues (empty when valid). */
export function validateNewItem(input: Partial<NewMediaItem>): ValidationFailure['issues'] {
  const issues: ValidationFailure['issues'] = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) issues.title = 'Başlık gerekli';
  else if ([...title].length > TITLE_MAX) issues.title = `En çok ${TITLE_MAX} karakter`;
  if (typeof input.caption === 'string' && [...input.caption].length > CAPTION_MAX) issues.caption = `En çok ${CAPTION_MAX} karakter`;
  const known = new Set<string>(CHANNELS.map((channel) => channel.value));
  if (!Array.isArray(input.channels) || input.channels.length === 0) issues.channels = 'En az bir kanal seçin';
  else if (input.channels.some((channel) => !known.has(channel))) issues.channels = 'Bilinmeyen kanal';
  if (typeof input.fileName !== 'string' || !input.fileName || typeof input.size !== 'number' || typeof input.type !== 'string') issues.file = 'Dosya bilgisi eksik';
  else if (!/^(image|video)\//.test(input.type)) issues.file = 'Yalnız görsel ve video yüklenebilir';
  else if (input.size > MEDIA_MAX_BYTES) issues.file = 'Dosya 100 MB sınırını aşıyor';
  return issues;
}

export const STATUS_LABEL: Record<MediaStatus, string> = {
  awaiting_upload: 'Yükleme bekleniyor',
  processing: 'İşleniyor',
  ready: 'Hazır',
};
