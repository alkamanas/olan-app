import {
  Badge,
  Card,
  EmptyState,
  List,
  Menu,
  OlanError,
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

/** Project Pulse: projects → a project's tasks with status badges → a task with a status menu. */

export const STATUS: Record<ProjectTaskStatus, { label: string; tone: Tone }> = {
  'needs-action': { label: 'Yapılacak', tone: 'default' },
  'in-process': { label: 'Sürüyor', tone: 'accent' },
  completed: { label: 'Tamamlandı', tone: 'success' },
  cancelled: { label: 'İptal', tone: 'muted' },
};

const STATUS_ORDER: ProjectTaskStatus[] = ['needs-action', 'in-process', 'completed', 'cancelled'];

const isOpen = (task: ProjectTask) => task.status === 'needs-action' || task.status === 'in-process';

/** First screen ('index'): every project the user can see. */
function ProjectsScreen() {
  const navigation = useNavigation();
  const projects = useQuery(() => olan.projects.list({ limit: 50 }));
  if (projects.error) {
    return (
      <Screen title="Project Pulse">
        <EmptyState
          title="Projeler yüklenemedi"
          description={projects.error.message}
          icon="warning"
          action={{ label: 'Tekrar dene', onPress: () => projects.refetch() }}
        />
      </Screen>
    );
  }
  const items = (projects.data?.items ?? []).map((project) => ({
    key: project.id,
    title: project.name,
    subtitle: project.description || undefined,
    icon: 'projects',
  }));
  return (
    <Screen title="Project Pulse" loading={projects.loading}>
      <List items={items} emptyText="Henüz proje yok" onSelect={({ key }) => navigation.push('project', { projectId: String(key) })} />
    </Screen>
  );
}

/** A project's tasks with a status summary. */
function ProjectScreen({ projectId }: { projectId: string }) {
  const navigation = useNavigation();
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const tasks = detail.data?.tasks ?? [];
  const open = tasks.filter(isOpen).length;
  const done = tasks.filter((task) => task.status === 'completed').length;
  const items = tasks.map((task) => ({
    key: task.id,
    title: task.title,
    meta: task.due ?? undefined,
    badge: { text: STATUS[task.status].label, tone: STATUS[task.status].tone },
  }));
  return (
    <Screen title={detail.data?.project.name ?? 'Proje'} loading={detail.loading}>
      <Stack gap="md" padding="md">
        {detail.data ? (
          <Stack direction="horizontal" gap="sm" wrap>
            <Badge text={`${open} açık`} tone="accent" />
            <Badge text={`${done} tamamlandı`} tone="success" />
          </Stack>
        ) : null}
        {detail.error ? <Text tone="danger" text={detail.error.message} /> : null}
        <List items={items} emptyText="Bu projede görev yok" onSelect={({ key }) => navigation.push('task', { projectId, taskId: String(key) })} />
      </Stack>
    </Screen>
  );
}

/** One task: details plus a Menu that changes its status through olan.projects.updateTask. */
function TaskScreen({ projectId, taskId }: { projectId: string; taskId: string }) {
  const detail = useQuery(() => olan.projects.get(projectId), [projectId]);
  const task = detail.data?.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return (
      <Screen title="Görev" loading={detail.loading}>
        {detail.loading ? null : <EmptyState title="Görev bulunamadı" icon="warning" />}
      </Screen>
    );
  }

  const changeStatus = async (status: ProjectTaskStatus) => {
    try {
      // `revision` is the version the change is based on; a stale one fails with invalid_params.
      await olan.projects.updateTask(projectId, task.id, { status, revision: task.revision });
      await olan.ui.toast({ text: `Durum: ${STATUS[status].label}`, tone: 'success' });
    } catch (error) {
      const message = error instanceof OlanError && error.code === 'permission_denied' ? 'Görevleri değiştirme izni yok' : 'Görev güncellenemedi';
      await olan.ui.toast({ text: message, tone: 'danger' });
    }
    await detail.refetch();
  };

  return (
    <Screen title={task.title}>
      <Stack gap="md" padding="md">
        <Card title="Ayrıntılar">
          <Stack gap="sm">
            <Stack direction="horizontal" gap="sm" align="center">
              <Text variant="label" text="Durum" />
              <Badge text={STATUS[task.status].label} tone={STATUS[task.status].tone} />
            </Stack>
            <Text text={`Bitiş: ${task.due ?? 'yok'}`} />
            {task.description ? <Text tone="muted" text={task.description} /> : null}
          </Stack>
        </Card>
        <Menu
          label="Durumu değiştir"
          icon="edit"
          items={STATUS_ORDER.map((status) => ({
            key: status,
            label: STATUS[status].label,
            disabled: status === task.status,
            destructive: status === 'cancelled',
          }))}
          onSelect={({ key }) => changeStatus(key as ProjectTaskStatus)}
        />
      </Stack>
    </Screen>
  );
}

/** The `app` surface renders the visible screen of the navigation stack. */
function App() {
  const { screen, params } = useNavigation();
  const p = (params ?? {}) as { projectId?: string; taskId?: string };
  if (screen === 'task' && p.projectId && p.taskId) return <TaskScreen projectId={p.projectId} taskId={p.taskId} />;
  if (screen === 'project' && p.projectId) return <ProjectScreen projectId={p.projectId} />;
  return <ProjectsScreen />;
}

export default defineApp({ app: App });
