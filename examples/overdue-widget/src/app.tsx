import { Card, EmptyState, List, defineApp, olan, useQuery, useSettings, type ProjectTask, type SurfaceProps } from '@olan-app/sdk';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two ISO dates (`YYYY-MM-DD`): `later - earlier`. */
function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

/** Open tasks whose due date is more than `graceDays` days before `today`, most overdue first. */
export function overdueTasks(tasks: ProjectTask[], today: string, graceDays: number): (ProjectTask & { daysLate: number })[] {
  return tasks
    .filter((task) => (task.status === 'needs-action' || task.status === 'in-process') && task.due !== null)
    .map((task) => ({ ...task, daysLate: daysBetween((task.due ?? today).slice(0, 10), today) }))
    .filter((task) => task.daysLate > graceDays)
    .sort((a, b) => b.daysLate - a.daysLate);
}

/**
 * The `project.widget` surface: a card on each project's page. Olan opens it with
 * `params = { projectId }`.
 */
function OverdueCard({ params }: SurfaceProps) {
  const projectId = (params as { projectId?: string } | null)?.projectId ?? '';
  const settings = useSettings();
  const graceDays = typeof settings.graceDays === 'number' ? settings.graceDays : 0;
  const tasks = useQuery(() => olan.projects.tasks(projectId), [projectId]);

  if (tasks.error) {
    return (
      <EmptyState
        title="Görevler yüklenemedi"
        description={tasks.error.message}
        icon="warning"
        action={{ label: 'Tekrar dene', onPress: () => tasks.refetch() }}
      />
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const overdue = overdueTasks(tasks.data ?? [], today, graceDays);
  if (!tasks.loading && overdue.length === 0) {
    return <EmptyState title="Geciken görev yok" description="Bu projede her şey zamanında." icon="check-circle" />;
  }
  return (
    <Card title="Geciken görevler" subtitle={tasks.loading ? undefined : `${overdue.length} görev`}>
      <List
        loading={tasks.loading}
        items={overdue.map((task) => ({
          key: task.id,
          title: task.title,
          subtitle: `Bitiş: ${(task.due ?? '').slice(0, 10)}`,
          meta: `${task.daysLate} gün`,
          badge: task.daysLate > 7 ? { text: 'Çok gecikti', tone: 'danger' } : { text: 'Gecikti', tone: 'warning' },
        }))}
      />
    </Card>
  );
}

export default defineApp({ 'project.widget': OverdueCard });
