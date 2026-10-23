import { useState } from 'react';
import { Button, Screen, Stack, Text, defineApp, olan } from '@olan-app/sdk';

const TITLE = '{{appName}}';

/** The `app` surface. Surfaces are named components so the React hook rules apply. */
function Home() {
  const [count, setCount] = useState(0);
  return (
    <Screen title={TITLE}>
      <Stack gap="md" padding="md">
        <Text variant="heading" text="Merhaba!" />
        <Text tone="muted" text={`Düğmeye ${count} kez bastınız.`} />
        <Stack direction="horizontal" gap="sm">
          <Button label="Bas" variant="primary" onPress={() => setCount((value) => value + 1)} />
          <Button label="Bildirim göster" variant="secondary" onPress={() => olan.ui.toast({ text: 'Merhaba Olan!', tone: 'success' })} />
        </Stack>
      </Stack>
    </Screen>
  );
}

export default defineApp({ app: Home });
