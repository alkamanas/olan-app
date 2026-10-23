/*
 * Host messages that belong to a running call rather than to the UI tree (Phase 5a): `upload-progress`
 * of `olan.files.upload` and `timer` ticks of `useQuery({ refetchIntervalMs })`. The runtime routes
 * them here; one app runs per worker, so module state is enough.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
}

const uploads = new Map<string, (progress: UploadProgress) => void>();
const timers = new Map<string, () => void>();

/** Calls `listener` for the progress of `uploadId` until the returned function is called. */
export function onUploadProgress(uploadId: string, listener: (progress: UploadProgress) => void): () => void {
  uploads.set(uploadId, listener);
  return () => {
    if (uploads.get(uploadId) === listener) uploads.delete(uploadId);
  };
}

export function dispatchUploadProgress(uploadId: string, progress: UploadProgress): void {
  uploads.get(uploadId)?.(progress);
}

/** Calls `listener` on every tick of `timerId` until the returned function is called. */
export function onTimer(timerId: string, listener: () => void): () => void {
  timers.set(timerId, listener);
  return () => {
    if (timers.get(timerId) === listener) timers.delete(timerId);
  };
}

export function dispatchTimer(timerId: string): void {
  timers.get(timerId)?.();
}

let nextTimer = 0;

/** A new `tmr_<n>` id, unique in this sandbox. */
export function nextTimerId(): string {
  nextTimer += 1;
  return `tmr_${nextTimer}`;
}

/** Forgets every listener (the runtime is shutting down). */
export function resetHostEvents(): void {
  uploads.clear();
  timers.clear();
}
