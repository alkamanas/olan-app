import { useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  List,
  ProgressBar,
  Screen,
  Select,
  Stack,
  TextField,
  defineApp,
  isOlanError,
  olan,
  useProjectConfig,
  useQuery,
  useSurfaceParams,
  type JsonValue,
  type ProjectDetail,
} from '@olan-app/sdk';

/**
 * What the app keeps for each project (`olan.project.config`): the goal and the work package that
 * tracks it. The project itself stays generic; this app adds its own process on top of it, and only
 * in the projects a member added it to ("Uygulamalar" on the project page).
 */
interface Goal {
  goal: string;
  listId: string | null;
}

function readGoal(value: Record<string, JsonValue>): Goal {
  return {
    goal: typeof value.goal === 'string' ? value.goal : '',
    listId: typeof value.listId === 'string' && value.listId ? value.listId : null,
  };
}

const DONE = new Set(['completed', 'cancelled']);

/** The `project.tab` surface: a tab on the project page, opened with `params = { projectId }`. */
function GoalTab() {
  const { projectId } = useSurfaceParams<'project.tab'>();
  const config = useProjectConfig();
  const project = useQuery(() => olan.projects.get(projectId), [projectId]);
  const error = config.error ?? project.error;

  if (error) {
    const notEnabled = isOlanError(error, 'project_not_enabled');
    return (
      <Screen title="Hedef">
        <EmptyState title={notEnabled ? 'Uygulama bu projeye eklenmemiş' : 'Hedef yüklenemedi'} description={notEnabled ? undefined : error.message} />
      </Screen>
    );
  }
  const { goal, listId } = readGoal(config.value);
  const detail = project.data;
  const list = detail?.lists.find((candidate) => candidate.id === listId) ?? null;
  const tasks = (detail?.tasks ?? []).filter((task) => !list || task.listId === list.id);
  const done = tasks.filter((task) => DONE.has(task.status)).length;

  return (
    <Screen title={goal || 'Hedef belirlenmedi'} subtitle={detail?.project.name} loading={config.loading || project.loading}>
      {!goal && !config.loading ? (
        <EmptyState title="Bu projenin hedefi yok" description="Proje sayfasında Uygulamalar → Ayarlar'dan bir hedef yazın." icon="flag" />
      ) : null}
      <Card title={list ? list.name : 'Tüm görevler'} subtitle={`${done}/${tasks.length} tamamlandı`}>
        <ProgressBar value={tasks.length ? done / tasks.length : 0} tone={tasks.length && done === tasks.length ? 'success' : 'default'} />
        <List
          loading={project.loading}
          emptyText="Görev yok"
          items={tasks.map((task) => ({
            key: task.id,
            title: task.title,
            meta: task.due ?? undefined,
            badge: DONE.has(task.status) ? { text: 'Bitti', tone: 'success' as const } : task.status === 'in-process' ? { text: 'Sürüyor', tone: 'accent' as const } : undefined,
          }))}
        />
      </Card>
    </Screen>
  );
}

function GoalForm({ initial, detail, save }: { initial: Goal; detail: ProjectDetail; save: (goal: Goal) => Promise<void> }) {
  const [goal, setGoal] = useState(initial.goal);
  const [listId, setListId] = useState<string | null>(initial.listId);
  const [saving, setSaving] = useState(false);
  return (
    <Stack gap="md">
      <TextField name="goal" label="Hedef" value={goal} maxLength={200} onChange={({ value }) => setGoal(value)} />
      <Select
        name="listId"
        label="Takip edilen iş paketi"
        placeholder="Tüm görevler"
        value={listId}
        options={detail.lists.map((list) => ({ value: list.id, label: list.name }))}
        onChange={({ value }) => setListId(value || null)}
      />
      <Button
        label="Kaydet"
        loading={saving}
        onPress={async () => {
          setSaving(true);
          try {
            await save({ goal: goal.trim(), listId });
          } finally {
            setSaving(false);
          }
        }}
      />
    </Stack>
  );
}

/** The `project.settings` surface: the app's settings of one project, opened from "Uygulamalar". */
function GoalSettings() {
  const { projectId } = useSurfaceParams<'project.settings'>();
  const config = useProjectConfig();
  const project = useQuery(() => olan.projects.get(projectId), [projectId]);
  const error = config.error ?? project.error;
  if (error) {
    return (
      <Screen title="Hedef ayarları">
        <EmptyState title="Ayarlar yüklenemedi" description={error.message} />
      </Screen>
    );
  }
  return (
    <Screen title="Hedef ayarları" subtitle={project.data?.project.name} loading={config.loading || project.loading}>
      {config.data && project.data ? (
        <GoalForm
          key={config.data.revision}
          initial={readGoal(config.value)}
          detail={project.data}
          save={async (next) => {
            try {
              await config.save({ goal: next.goal, listId: next.listId });
              await olan.ui.toast({ text: 'Hedef kaydedildi', tone: 'success' });
            } catch (failure) {
              // Someone saved meanwhile (revision changed): load theirs and let the person decide again.
              if (isOlanError(failure, 'conflict')) {
                await config.refetch();
                await olan.ui.toast({ text: 'Hedef bu arada değişmiş; güncel hali yüklendi', tone: 'warning' });
              } else if (isOlanError(failure, 'permission_denied')) {
                await olan.ui.toast({ text: 'Bu projede ayarları değiştiremezsiniz', tone: 'danger' });
              } else throw failure;
            }
          }}
        />
      ) : null}
    </Screen>
  );
}

export default defineApp({ 'project.tab': GoalTab, 'project.settings': GoalSettings });
