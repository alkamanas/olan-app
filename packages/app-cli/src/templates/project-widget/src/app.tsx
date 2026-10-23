import { Card, EmptyState, List, defineApp, olan, useQuery, type SurfaceProps } from '@olan-app/sdk';

/**
 * The `project.widget` surface: a card on a project's page. The host passes
 * `params = { projectId }`.
 */
function OpenTasks({ params }: SurfaceProps) {
  const projectId = (params as { projectId?: string } | null)?.projectId ?? '';
  const tasks = useQuery(() => olan.projects.tasks(projectId), [projectId]);
  const open = (tasks.data ?? []).filter((task) => task.status === 'needs-action' || task.status === 'in-process');

  if (tasks.error) return <EmptyState title="Görevler yüklenemedi" description={tasks.error.message} />;
  if (!tasks.loading && open.length === 0) return <EmptyState title="Açık görev yok" icon="check" />;
  return (
    <Card title="Açık görevler" subtitle={`${open.length} görev`}>
      <List
        loading={tasks.loading}
        items={open.map((task) => ({
          key: task.id,
          title: task.title,
          meta: task.due ?? undefined,
          badge: task.status === 'in-process' ? { text: 'Sürüyor', tone: 'accent' } : undefined,
        }))}
      />
    </Card>
  );
}

export default defineApp({ 'project.widget': OpenTasks });
