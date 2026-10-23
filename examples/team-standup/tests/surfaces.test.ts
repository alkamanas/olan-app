import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderApp } from '@olan-app/cli/testing';

// Built-in mock data: projects p0 "Web sitesi", p1, p2; calendar cal-0 with ev-0 (the user's own
// event), ev-meeting (an Olan meeting, protected); no chat fixtures (chat.action opens on a sample message);
// mail-0 "Teklif hakkında" from Ayşe Yılmaz; meeting mt-0 "Ürün toplantısı".

type TaskParams = { projectId: string; title: string; description?: string };
type Node = { type: string; props: Record<string, unknown>; children: number[] };

test('app: lists projects with open and overdue counts', async () => {
  const app = await renderApp({ surface: 'app', now: '2026-10-17T09:00:00Z' });
  app.expectText('Team Standup');
  app.expectText('Web sitesi');
  app.expectText('Mobil uygulama');
  app.expectText('3 açık görev');
  app.expectText('3 gecikmiş');
  await app.dispose();
});

test('chat.action: the message becomes a task in the chosen project', async () => {
  const app = await renderApp({
    surface: 'chat.action',
    params: {
      conversationId: 'conversation-0',
      message: { id: 'm-1', body: 'API dokümanını güncelle\nDetay: sürüm 2', senderId: 'u-2', senderKind: 'user', createdAt: '2026-10-17T08:00:00Z', threadRootId: null },
    },
  });
  app.expectText('API dokümanını güncelle');
  await app.select('Proje', 'p1');
  await app.press('Göreve çevir');
  const call = app.calls('projects.createTask')[0]!;
  assert.equal(call.ok, true);
  const params = call.params as TaskParams;
  assert.equal(params.projectId, 'p1');
  assert.equal(params.title, 'API dokümanını güncelle');
  assert.equal(params.description, 'API dokümanını güncelle\nDetay: sürüm 2');
  assert.deepEqual(app.toasts(), [{ text: 'Görev oluşturuldu', tone: 'success' }]);
  assert.ok(app.host.data.projects[1]!.tasks.some((task) => task.title === 'API dokümanını güncelle'));
  await app.dispose();
});

test('chat.action: defaults to the first project and reports a missing tasks:write', async () => {
  const app = await renderApp({ surface: 'chat.action', permissions: ['projects:read'] });
  await app.press('Göreve çevir');
  const call = app.calls('projects.createTask')[0]!;
  assert.equal((call.params as TaskParams).projectId, 'p0');
  assert.equal(call.error?.code, 'permission_denied');
  assert.equal(app.toasts()[0]?.tone, 'danger');
  await app.dispose();
});

test('chat.command: /standup posts the standup card with a submit button', async () => {
  const app = await renderApp({
    surface: 'chat.command',
    params: { conversationId: 'conversation-0', text: 'Dün: API, bugün: testler', threadRootId: null },
    now: '2026-10-17T09:00:00Z',
  });
  app.expectText("Bugünün standup'ı");
  app.expectText('Dün: API, bugün: testler');
  await app.press('Kartı gönder');
  assert.equal(app.calls('chat.postCard')[0]?.ok, true);
  assert.deepEqual(app.toasts(), [{ text: 'Kart gönderildi', tone: 'success' }]);
  const [posted] = app.host.cards;
  assert.equal(posted?.conversationId, 'conversation-0');
  const nodes = posted!.card.nodes as unknown as Node[];
  assert.equal(nodes.find((node) => node.type === 'Card')?.props.title, "Bugünün standup'ı");
  const button = nodes.find((node) => node.type === 'Button');
  assert.equal(button?.props.label, 'Tamamladım');
  assert.deepEqual(button?.props.action, { kind: 'submit', name: 'done', payload: { day: '2026-10-17', note: 'Dün: API, bugün: testler' } });
  assert.match(posted!.card.fallbackText, /^Standup · 2026-10-17/);
  app.expectText('Gönderildi');
  // The modal closes: pop() on its first screen reaches the host.
  assert.deepEqual(app.navigation().map((entry) => entry.action), ['pop']);
  await app.dispose();
});

test('chat.command: without chat:write the card is not posted', async () => {
  const app = await renderApp({ surface: 'chat.command', permissions: [] });
  await app.press('Kartı gönder');
  assert.equal(app.calls('chat.postCard')[0]?.error?.code, 'permission_denied');
  assert.equal(app.host.cards.length, 0);
  await app.dispose();
});

test('calendar.event.action: adds a standup note to the event', async () => {
  const app = await renderApp({ surface: 'calendar.event.action', now: '2026-10-17T09:00:00Z' });
  app.expectText('Haftalık planlama');
  await app.fill('Not', 'Sprint hedefleri konuşuldu');
  await app.press('Not ekle');
  const call = app.calls('calendar.updateEvent')[0]!;
  assert.equal(call.ok, true);
  assert.deepEqual(call.params, { eventId: 'ev-0', patch: { description: 'Standup notu (2026-10-17): Sprint hedefleri konuşuldu' } });
  assert.deepEqual(app.toasts(), [{ text: 'Not eklendi', tone: 'success' }]);
  await app.dispose();
});

test('calendar.event.action: creates a follow-up event and deletes it (audited)', async () => {
  const app = await renderApp({ surface: 'calendar.event.action' });
  await app.press('Takip etkinliği oluştur ve sil');
  const created = app.calls('calendar.createEvent')[0]!;
  assert.equal(created.ok, true);
  const event = created.result as { id: string; title: string };
  assert.equal(event.title, 'Takip: Haftalık planlama');
  assert.deepEqual(app.calls('calendar.deleteEvent')[0]?.params, { eventId: event.id });
  assert.equal(app.calls('calendar.deleteEvent')[0]?.ok, true);
  assert.deepEqual(app.host.audit(), [{ action: 'record.delete', detail: { kind: 'event', recordId: event.id, title: 'Takip: Haftalık planlama' } }]);
  assert.deepEqual(app.toasts(), [{ text: 'Takip etkinliği oluşturuldu ve silindi', tone: 'success' }]);
  await app.dispose();
});

test('calendar.event.action: deleting an Olan meeting is refused (system_record) and audited', async () => {
  const app = await renderApp({
    surface: 'calendar.event.action',
    params: {
      calendarId: 'cal-0', eventId: 'ev-meeting', uid: 'mt-0@olan.app', title: 'Ürün toplantısı',
      start: '2026-10-19T14:00:00+03:00', end: '2026-10-19T15:00:00+03:00', timeZone: 'Europe/Istanbul', isAllDay: false, location: null, isOrganizer: true,
    },
  });
  await app.press('Bu etkinliği sil');
  assert.equal(app.calls('calendar.deleteEvent')[0]?.error?.code, 'forbidden_record');
  assert.deepEqual(app.toasts(), [{ text: 'Bu kayıt korunuyor: system_record', tone: 'danger' }]);
  app.expectText('Bu kayıt korunuyor: system_record');
  assert.deepEqual(app.host.audit(), [{ action: 'record.delete_denied', detail: { kind: 'event', recordId: 'ev-meeting', reason: 'system_record' } }]);
  assert.ok(app.host.data.calendarEvents.some((event) => event.id === 'ev-meeting'));
  await app.dispose();
});

test('mail.action: the email becomes a task with its sender and text', async () => {
  const app = await renderApp({ surface: 'mail.action' });
  app.expectText('Teklif hakkında');
  app.expectText('Gönderen: Ayşe Yılmaz <ayse@example.com>');
  await app.select('Proje', 'p2');
  await app.press('Göreve çevir');
  assert.deepEqual(app.calls('mail.getMessage')[0]?.params, { messageId: 'mail-0' });
  const call = app.calls('projects.createTask')[0]!;
  assert.equal(call.ok, true);
  assert.deepEqual(call.params, {
    projectId: 'p2', title: 'Teklif hakkında',
    description: 'Gönderen: Ayşe Yılmaz <ayse@example.com>\n\nMerhaba, teklifimizi ekte bulabilirsiniz.',
  });
  assert.deepEqual(app.toasts(), [{ text: 'Görev oluşturuldu', tone: 'success' }]);
  app.expectText('Görev oluşturuldu: Teklif hakkında');
  await app.dispose();
});

test('mail.sidebar: shows the email, its text and attachments; follows the panel to another email', async () => {
  const app = await renderApp({
    surface: 'mail.sidebar',
    fixtures: { mail: [
      { id: 'mail-0', subject: 'Teklif hakkında', from: { name: 'Ayşe Yılmaz', email: 'ayse@example.com' }, textBody: 'Merhaba, teklifimizi ekte bulabilirsiniz.', attachments: [{ name: 'teklif.pdf', type: 'application/pdf', size: 48213 }] },
      { id: 'mail-1', subject: 'Fatura', from: { name: null, email: 'muhasebe@firma.com' }, textBody: 'Ekim faturası' },
    ] },
  });
  app.expectText('Konu: Teklif hakkında');
  app.expectText('Gönderen: Ayşe Yılmaz <ayse@example.com>');
  app.expectText('Merhaba, teklifimizi ekte bulabilirsiniz.');
  app.expectText('1 ek');
  await app.setParams({ messageId: 'mail-1', threadId: null, subject: 'Fatura', from: { name: null, email: 'muhasebe@firma.com' }, to: [], cc: [], receivedAt: '2026-10-16T10:00:00Z' });
  app.expectText('Konu: Fatura');
  app.expectText('Gönderen: muhasebe@firma.com');
  app.expectText('Ekim faturası');
  await app.press('Göreve çevir');
  assert.deepEqual(app.calls('projects.createTask')[0]?.params, { projectId: 'p0', title: 'Fatura', description: 'Gönderen: muhasebe@firma.com\n\nEkim faturası' });
  await app.dispose();
});

test('mail.sidebar: without mail:read the summary still shows and the task has no body', async () => {
  const app = await renderApp({ surface: 'mail.sidebar', permissions: ['projects:read', 'tasks:write'] });
  app.expectText('Konu: Teklif hakkında');
  assert.equal(app.calls('mail.getMessage')[0]?.error?.code, 'permission_denied');
  app.expectText(/İçerik okunamadı/);
  await app.press('Göreve çevir');
  assert.deepEqual(app.calls('projects.createTask')[0]?.params, { projectId: 'p0', title: 'Teklif hakkında', description: 'Gönderen: Ayşe Yılmaz <ayse@example.com>' });
  await app.dispose();
});

test('meeting.panel: the meeting, the open tasks of a project and a new task from the meeting', async () => {
  const app = await renderApp({ surface: 'meeting.panel' });
  app.expectText('Toplantı: Ürün toplantısı');
  assert.deepEqual(app.calls('meetings.get')[0]?.params, { meetingId: 'mt-0' });
  app.expectText('1 katılımcı');
  app.expectText('Görev 2');
  await app.select('Proje', 'p1');
  assert.deepEqual(app.calls('projects.tasks').at(-1)?.params, { projectId: 'p1' });
  await app.fill('Yeni görev', 'Yol haritasını paylaş');
  await app.press('Görev ekle');
  const call = app.calls('projects.createTask')[0]!;
  assert.equal(call.ok, true);
  assert.deepEqual(call.params, { projectId: 'p1', title: 'Yol haritasını paylaş', description: 'Toplantı: Ürün toplantısı' });
  assert.deepEqual(app.toasts(), [{ text: 'Görev eklendi', tone: 'success' }]);
  app.expectText('Yol haritasını paylaş');
  await app.dispose();
});

test('meeting.panel: a meeting of a project opens on that project', async () => {
  const app = await renderApp({
    surface: 'meeting.panel',
    params: { meetingId: 'mt-0', slug: 'urun-toplantisi', title: 'Ürün toplantısı', startsAt: '2026-10-19T14:00:00+03:00', endsAt: null, role: 'participant', projectId: 'p2' },
  });
  assert.deepEqual(app.calls('projects.tasks')[0]?.params, { projectId: 'p2' });
  await app.dispose();
});

test('meeting.panel: without meetings:read it shows the role from the params', async () => {
  const app = await renderApp({ surface: 'meeting.panel', permissions: ['projects:read', 'tasks:write'] });
  app.expectText('Toplantı: Ürün toplantısı');
  assert.equal(app.calls('meetings.get')[0]?.error?.code, 'permission_denied');
  app.expectText('Düzenleyen sizsiniz');
  app.expectText('Görev 2');
  await app.dispose();
});
