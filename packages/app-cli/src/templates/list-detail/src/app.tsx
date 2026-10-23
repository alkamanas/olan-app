import {
  Card,
  EmptyState,
  List,
  Screen,
  Stack,
  Text,
  defineApp,
  olan,
  useNavigation,
  useQuery,
  type ProjectTask,
  type ProjectTaskStatus,
  type Tone,
} from '@olan-app/sdk';

const TITLE = '{{appName}}';

export const STATUS: Record<ProjectTaskStatus, { label: string; tone: Tone }> = {
  'needs-action': { label: 'Yapılacak', tone: 'default' },
  'in-process': { label: 'Sürüyor', tone: 'accent' },
  completed: { label: 'Tamamlandı', tone: 'success' },
  cancelled: { label: 'İptal', tone: 'muted' },
};

/** First screen ('index'): the projects. Selecting one pushes the 'project' screen. */
function ProjectsScreen() {
  const navigation = useNavigation();
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  const items = (projects.data?.items ?? []).map((project) => ({
    key: project.id,
    title: project.name,
    subtitle: project.description || undefined,
  }));
  return (
    <Screen title={TITLE} loading={projects.loading}>
      {projects.error ? (
        <EmptyState title="Projeler yüklenemedi" description={projects.error.message} action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }} />
      ) : (
        <List items={items} emptyText="Henüz proje yok" onSelect={({ key }) => navigation.push('project', { projectId: String(key) })} />
      )}
    </Screen>
  );
}

/** The tasks of one project. Selecting a task pushes the 'task' screen. */
function ProjectScreen({ projectId }: { projectId: string }) {
  const navigation = useNavigation();
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const items = (detail.data?.tasks ?? []).map((task) => ({
    key: task.id,
    title: task.title,
    meta: task.due ?? undefined,
    badge: { text: STATUS[task.status].label, tone: STATUS[task.status].tone },
  }));
  return (
    <Screen title={detail.data?.project.name ?? 'Proje'} loading={detail.loading}>
      <List items={items} emptyText="Bu projede görev yok" onSelect={({ key }) => navigation.push('task', { projectId, taskId: String(key) })} />
    </Screen>
  );
}

function TaskScreen({ projectId, taskId }: { projectId: string; taskId: string }) {
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const task: ProjectTask | undefined = detail.data?.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return <Screen title="Görev" loading={detail.loading} />;
  return (
    <Screen title={task.title}>
      <Card title="Ayrıntılar">
        <Stack gap="sm">
          <Text text={`Durum: ${STATUS[task.status].label}`} />
          <Text text={`Bitiş: ${task.due ?? 'yok'}`} />
          {task.description ? <Text tone="muted" text={task.description} /> : null}
        </Stack>
      </Card>
    </Screen>
  );
}

/** The `app` surface switches on the visible screen of the navigation stack. */
function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { projectId?: string; taskId?: string };
  if (screen === 'project' && p.projectId) return <ProjectScreen projectId={p.projectId} />;
  if (screen === 'task' && p.projectId && p.taskId) return <TaskScreen projectId={p.projectId} taskId={p.taskId} />;
  return <ProjectsScreen />;
}

export default defineApp({ app: App });
