import type { AppCard } from '@olan-app/sdk';

/*
 * The standup chat card (docs/cards.md). Shared by the app (`/standup` posts it) and the app
 * server (`remote-server/`, the `done` card action answers the completed version), so both draw
 * the same card. Plain data, no SDK runtime: Node runs this file directly (type stripping).
 */

export const CARD_TITLE = "Bugünün standup'ı";
export const DONE_ACTION = 'done';
export const DONE_LABEL = 'Tamamladım';
export const DONE_BADGE = 'Tamamlandı';

/** What the card shows; travels in the submit button's payload so the server can redraw it. */
export interface StandupCardData {
  /** `YYYY-MM-DD`. */
  day: string;
  /** What the person typed after `/standup` (may be empty). */
  note: string;
}

const MAX_NOTE = 400;

export function standupCardData(value: unknown): StandupCardData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { day, note } = value as Record<string, unknown>;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return { day, note: typeof note === 'string' ? note.slice(0, MAX_NOTE) : '' };
}

/** The card; `done: true` is the version after someone pressed "Tamamladım" (no submit button). */
export function standupCard(data: StandupCardData, options: { done?: boolean } = {}): AppCard {
  const note = data.note.trim().slice(0, MAX_NOTE);
  const lines = note ? note : 'Dün ne yaptın, bugün ne yapacaksın, engel var mı?';
  const nodes: AppCard['nodes'] = [
    { id: 1, type: 'Card', props: { title: CARD_TITLE, subtitle: data.day }, children: [2] },
    { id: 2, type: 'Stack', props: { gap: 'sm' }, children: options.done ? [3, 4] : [3, 5] },
    { id: 3, type: 'Text', props: { text: lines }, children: [] },
  ];
  if (options.done) {
    nodes.push({ id: 4, type: 'Badge', props: { text: DONE_BADGE, tone: 'success' }, children: [] });
  } else {
    nodes.push({
      id: 5,
      type: 'Button',
      props: { label: DONE_LABEL, variant: 'primary', action: { kind: 'submit', name: DONE_ACTION, payload: { day: data.day, note } } },
      children: [],
    });
  }
  return {
    version: 1,
    root: 1,
    nodes,
    fallbackText: `${options.done ? 'Standup tamamlandı' : 'Standup'} · ${data.day}${note ? `: ${note.slice(0, 200)}` : ''}`,
  };
}
