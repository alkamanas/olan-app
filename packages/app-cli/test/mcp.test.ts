// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/commands/mcp';
import { manifest, tempProject } from './helpers';

const APP = `
import { useState } from 'react';
import { Button, Screen, Text, defineApp } from '@olan-app/sdk';
function Home() {
  const [count, setCount] = useState(0);
  return <Screen title="MCP"><Text text={'Sayı: ' + count} /><Button label="Artır" onPress={() => setCount(count + 1)} /></Screen>;
}
export default defineApp({ app: Home });
`;

describe('olan-app mcp', () => {
  const project = tempProject('mcp', { 'olan-app.json': manifest({ permissions: [] }), 'src/app.tsx': APP });
  afterAll(() => project.remove());

  it('lists the contract tools and renders and dispatches a session', async () => {
    const { server, dispose } = createMcpServer(project.dir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'olan_app_build',
        'olan_app_db',
        'olan_app_dispatch',
        'olan_app_docs_search',
        'olan_app_event_send',
        'olan_app_logs',
        'olan_app_render',
        'olan_app_request_send',
        'olan_app_test',
        'olan_app_tool_call',
        'olan_app_validate',
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
      const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as { ok: boolean; result?: any; errors?: any[] };

      const noSession = parse(await client.callTool({ name: 'olan_app_dispatch', arguments: { action: 'back' } }));
      expect(noSession).toMatchObject({ ok: false, errors: [{ code: 'mcp.no_session' }] });

      const rendered = parse(await client.callTool({ name: 'olan_app_render', arguments: {} }));
      expect(rendered.ok).toBe(true);
      expect(rendered.result.tree).toMatchObject({ type: 'Screen', props: { title: 'MCP' } });
      const pressed = parse(await client.callTool({ name: 'olan_app_dispatch', arguments: { action: 'press', label: 'Artır' } }));
      expect(pressed.result.text).toContain('Sayı: 1');

      const docs = parse(await client.callTool({ name: 'olan_app_docs_search', arguments: { query: 'useQuery refetch', limit: 2 } }));
      expect(docs.result.results.length).toBeGreaterThan(0);
    } finally {
      await dispose();
      await client.close();
    }
  });

  it('renders with fixtures.db and shows the mock database with olan_app_db', async () => {
    const data = { version: 1, collections: { notes: { scope: 'organization', fields: { title: { type: 'string', required: true, maxLength: 100, indexed: true } } } } };
    const dbProject = tempProject('mcp-db', {
      'olan-app.json': manifest({ sdk: '^1.1.0', permissions: ['db'], data }),
      'src/app.tsx': `
import { Button, List, Screen, defineApp, olan, useCollection } from '@olan-app/sdk';
function Home() {
  const notes = useCollection<{ title: string }>('notes');
  return <Screen title="Notlar"><List items={notes.rows.map((row) => ({ key: row.id, title: row.data.title }))} /><Button label="Ekle" onPress={() => olan.db.collection('notes').insert({ title: 'Yeni' })} /></Screen>;
}
export default defineApp({ app: Home });
`,
    });
    const { server, dispose } = createMcpServer(dbProject.dir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON output in assertions
    const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as { ok: boolean; result?: any; errors?: any[] };
    try {
      expect(parse(await client.callTool({ name: 'olan_app_db', arguments: {} }))).toMatchObject({ ok: false, errors: [{ code: 'mcp.no_session' }] });
      const rendered = parse(await client.callTool({ name: 'olan_app_render', arguments: { fixtures: { db: { notes: [{ data: { title: 'Bir' } }] } } } }));
      expect(rendered.result.text).toContain('Bir');
      await client.callTool({ name: 'olan_app_dispatch', arguments: { action: 'press', label: 'Ekle' } });
      const summary = parse(await client.callTool({ name: 'olan_app_db', arguments: {} }));
      expect(summary.result).toMatchObject({ collections: [{ name: 'notes', scope: 'organization', rowCount: 2 }], usage: { rows: 2 } });
      const rows = parse(await client.callTool({ name: 'olan_app_db', arguments: { collection: 'notes', where: { title: 'Yeni' } } }));
      expect(rows.result).toMatchObject({ collection: 'notes', total: 1, rows: [{ data: { title: 'Yeni' }, createdBy: '00000000-0000-4000-8000-000000000001', ownerUserId: null }] });
      expect(parse(await client.callTool({ name: 'olan_app_db', arguments: { collection: 'nope' } }))).toMatchObject({ ok: false, errors: [{ code: 'mcp.invalid_input' }] });
    } finally {
      await dispose();
      await client.close();
      dbProject.remove();
    }
  });
});
