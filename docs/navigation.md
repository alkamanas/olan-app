# Navigation

Each surface has its own navigation stack, kept inside the app. The first screen is named
`'index'` and its params are the surface params. `push` adds a screen, `pop` removes the top one,
`replace` swaps the top one. Olan is told about every change so it can show its own back control;
when the user presses back (or swipes back on iOS, or uses the Android back button), Olan pops the
stack.

The pattern: one surface component reads `useNavigation()` and renders the visible screen.

```tsx
import { List, Screen, defineApp, olan, useNavigation, useQuery } from '@olan-app/sdk';

function ProjectsScreen() {
  const navigation = useNavigation();
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const items = (projects.data?.items ?? []).map((p) => ({ key: p.id, title: p.name }));
  return (
    <Screen title="Projeler" loading={projects.loading}>
      <List items={items} onSelect={({ key }) => navigation.push('project', { projectId: String(key) })} />
    </Screen>
  );
}

function ProjectScreen({ projectId }: { projectId: string }) {
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const items = (detail.data?.tasks ?? []).map((t) => ({ key: t.id, title: t.title }));
  return (
    <Screen title={detail.data?.project.name ?? 'Proje'} loading={detail.loading}>
      <List items={items} emptyText="Görev yok" />
    </Screen>
  );
}

function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { projectId?: string };
  if (screen === 'project' && p.projectId) return <ProjectScreen projectId={p.projectId} />;
  return <ProjectsScreen />;
}

export default defineApp({ app: App });
```

Rules:

- Screen names and params are yours; params must be JSON (strings, numbers, booleans, null,
  arrays, objects).
- Each screen component gets fresh state when it is pushed; screens below keep nothing (they
  re-render from their queries when they become visible again).
- Do not add your own "Geri" (back) button for the stack; Olan shows one. A button that calls
  `pop()` after finishing a task (e.g. after a form submit) is fine.
- `pop()` on the first screen keeps the stack; Olan closes a modal surface, other surfaces stay open.
- `project.widget` surfaces are small cards; keep them to one screen.
- An app address (`https://<Olan web>/apps/a/<appId>/<screen>?id=…`, SDK 1.5, links.md) opens the
  `app` surface on that screen: the stack starts as `[index, <screen>]` with the query as the
  screen's params (`index` alone gets them as its params), and back returns to `index`. So read
  every screen's params defensively: they may come from a link, as strings.

Testing navigation (testing.md):

```ts
const app = await renderApp();
await app.press('Lansman');                 // List item title
app.navigation();                           // [{ action: 'push', screen: 'project', params: { projectId: 'launch' } }]
await app.back();                           // the host's back control
```
