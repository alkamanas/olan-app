import { defineBackend, olan } from '@olan-app/sdk/backend';

/** A row of the `notes` collection (manifest `data`). */
interface Note {
  text: string;
  source?: 'ui' | 'schedule';
}

const notes = () => olan.db.collection<Note>('notes');

export default defineBackend({
  functions: {
    /** UI: `olan.backend.call('summary')`. */
    async summary() {
      const { rows } = await notes().query({ orderBy: { field: 'createdAt', direction: 'desc' }, limit: 5 });
      const token = await olan.secrets.get('apiToken');
      return {
        count: await notes().count(),
        latest: rows.map((row) => ({ id: row.id, text: row.data.text, source: row.data.source ?? 'ui' })),
        // Never return the secret itself: only whether it is set.
        configured: token !== null,
      };
    },
    /** UI: `olan.backend.call('addNote', { text })`. */
    async addNote(args: { text?: unknown } | null) {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('text is required');
      const row = await notes().insert({ text, source: 'ui' });
      console.log('note added', row.id);
      return { id: row.id };
    },
  },
  // Trigger handlers go in their own maps, keyed by the manifest name: `functions` is what the UI
  // may call with `olan.backend.call`, so a schedule, event or hook handler never belongs there.
  schedules: {
    /** `server.schedules` "heartbeat" (every hour), as the app. */
    async heartbeat(ctx) {
      await notes().insert({ text: `Saatlik kontrol ${ctx.scheduledAt}`, source: 'schedule' });
    },
  },
});
