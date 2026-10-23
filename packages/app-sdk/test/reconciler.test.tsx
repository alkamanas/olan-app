import { Suspense, useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { Button, Card, List, Screen, Stack, Text } from '../src/components';
import type { UiPatch } from '../src/protocol';
import { createUiRoot, type UiRoot } from '../src/reconciler';
import { applyPatches, createUiTree, snapshotTree, treeText } from '../src/tree';

function setup() {
  const batches: { seq: number; patches: UiPatch[] }[] = [];
  const tree = createUiTree();
  const errors: unknown[] = [];
  const root = createUiRoot({
    onPatches: (seq, patches) => {
      batches.push({ seq, patches });
      applyPatches(tree, JSON.parse(JSON.stringify(patches)) as UiPatch[]);
    },
    onUncaughtError: (error) => errors.push(error),
  });
  return { root, batches, tree, errors, last: () => batches[batches.length - 1] };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function findByType(tree: ReturnType<typeof createUiTree>, type: string) {
  return [...tree.nodes.values()].filter((node) => node.type === type);
}

function press(root: UiRoot, tree: ReturnType<typeof createUiTree>, label: string) {
  const button = findByType(tree, 'Button').find((node) => node.props.label === label);
  if (!button) throw new Error(`No button "${label}"`);
  const ref = button.props.onPress as { $handler: number };
  return root.dispatch(ref.$handler, null);
}

describe('reconciler', () => {
  it('emits create patches (children first) and the root on mount', () => {
    const { root, batches, tree } = setup();
    root.render(
      <Screen title="Projeler">
        <Text variant="heading">Merhaba</Text>
        <Badge2 />
      </Screen>,
    );
    expect(batches).toHaveLength(1);
    const { seq, patches } = batches[0];
    expect(seq).toBe(1);
    const ops = patches.map((patch) => patch.op);
    expect(ops[ops.length - 1]).toBe('root');
    expect(ops.slice(0, -1).every((op) => op === 'create')).toBe(true);
    // Every create references only ids created before it.
    const created = new Set<number>();
    for (const patch of patches) {
      if (patch.op !== 'create') continue;
      for (const child of patch.node.children) expect(created.has(child)).toBe(true);
      created.add(patch.node.id);
    }
    expect(snapshotTree(tree)).toEqual({
      type: 'Screen',
      props: { title: 'Projeler' },
      children: [
        { type: 'Text', props: { variant: 'heading' }, children: [{ type: '#text', props: { text: 'Merhaba' }, children: [] }] },
        { type: 'Text', props: { text: 'Sabit', tone: 'muted' }, children: [] },
      ],
    });
    expect(tree.root).not.toBe(0);
  });

  it('turns function props into handler refs and dispatches events to them', async () => {
    const { root, tree, batches } = setup();
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <Screen>
          <Text text={`Sayaç: ${count}`} />
          <Button label="Artır" onPress={() => setCount((value) => value + 1)} />
        </Screen>
      );
    }
    root.render(<Counter />);
    const button = findByType(tree, 'Button')[0];
    expect(button.props.onPress).toEqual({ $handler: expect.any(Number) });
    const handlerBefore = button.props.onPress;

    expect(press(root, tree, 'Artır').found).toBe(true);
    await flush();
    expect(treeText(tree)).toContain('Sayaç: 1');
    // The new arrow function reuses the handler id: only the text changed.
    const update = batches[batches.length - 1];
    expect(update.seq).toBe(2);
    expect(update.patches).toEqual([{ op: 'props', id: expect.any(Number), set: { text: 'Sayaç: 1' }, unset: [] }]);
    expect(findByType(tree, 'Button')[0].props.onPress).toEqual(handlerBefore);
  });

  it('sends set and unset for changed props', async () => {
    const { root, last } = setup();
    let setVariant: (value: 'title' | undefined) => void = () => {};
    function Title() {
      const [variant, set] = useState<'title' | undefined>('title');
      setVariant = set;
      return <Text text="Başlık" variant={variant} tone="accent" />;
    }
    root.render(<Title />);
    setVariant(undefined);
    await flush();
    expect(last().patches).toEqual([{ op: 'props', id: expect.any(Number), set: {}, unset: ['variant'] }]);
  });

  it('updates text nodes in place', async () => {
    const { root, tree, last } = setup();
    let setName: (value: string) => void = () => {};
    function Greeting() {
      const [name, set] = useState('Ada');
      setName = set;
      return <Text>Merhaba {name}</Text>;
    }
    root.render(<Greeting />);
    const texts = findByType(tree, '#text');
    expect(texts.map((node) => node.props.text)).toEqual(['Merhaba ', 'Ada']);
    setName('Utku');
    await flush();
    expect(last().patches).toEqual([{ op: 'props', id: texts[1].id, set: { text: 'Utku' }, unset: [] }]);
  });

  it('removes subtrees, sends the new child list and frees their handlers', async () => {
    const { root, tree, last } = setup();
    let toggle: () => void = () => {};
    function Toggle() {
      const [open, setOpen] = useState(true);
      toggle = () => setOpen((value) => !value);
      return (
        <Stack>
          <Text text="Üst" />
          {open && (
            <Card title="Kart">
              <Button label="İç" onPress={() => {}} />
              <Button label="İç 2" onPress={() => {}} />
            </Card>
          )}
        </Stack>
      );
    }
    root.render(<Toggle />);
    const handlersWithCard = root.container.handlerCount;
    expect(handlersWithCard).toBe(2);
    const card = findByType(tree, 'Card')[0];
    const stack = findByType(tree, 'Stack')[0];

    toggle();
    await flush();
    expect(last().patches).toEqual([
      { op: 'children', id: stack.id, children: [findByType(tree, 'Text')[0].id] },
      { op: 'remove', id: card.id },
    ]);
    expect(root.container.handlerCount).toBe(0);
    expect(findByType(tree, 'Button')).toHaveLength(0);
    // A stale event for a removed handler is reported as not found.
    expect(root.dispatch(1, null).found).toBe(false);

    toggle();
    await flush();
    expect(findByType(tree, 'Card')).toHaveLength(1);
    expect(root.container.handlerCount).toBe(2);
  });

  it('keeps keyed order with a children patch when items move', async () => {
    const { root, tree, last } = setup();
    let reverse: () => void = () => {};
    function Ordered() {
      const [items, setItems] = useState(['a', 'b', 'c']);
      reverse = () => setItems((value) => [...value].reverse());
      return <Stack>{items.map((item) => <Text key={item} text={item} />)}</Stack>;
    }
    root.render(<Ordered />);
    reverse();
    await flush();
    expect(last().patches.map((patch) => patch.op)).toEqual(['children']);
    const stack = findByType(tree, 'Stack')[0];
    expect(stack.children.map((id) => tree.nodes.get(id)!.props.text)).toEqual(['c', 'b', 'a']);
  });

  it('assigns handler ids inside arrays (Screen actions, List onSelect)', () => {
    const { root, tree } = setup();
    const selected: unknown[] = [];
    root.render(
      <Screen actions={[{ key: 'add', label: 'Ekle', onPress: () => selected.push('add') }]}>
        <List items={[{ key: 'p1', title: 'Proje 1' }]} onSelect={(payload) => selected.push(payload)} />
      </Screen>,
    );
    const screen = findByType(tree, 'Screen')[0];
    const action = (screen.props.actions as { onPress: { $handler: number } }[])[0];
    root.dispatch(action.onPress.$handler, null);
    const list = findByType(tree, 'List')[0];
    root.dispatch((list.props.onSelect as { $handler: number }).$handler, { key: 'p1' });
    expect(selected).toEqual(['add', { key: 'p1' }]);
  });

  it('hides suspended content by leaving it out of the child list', async () => {
    const { root, tree } = setup();
    let resolve: () => void = () => {};
    let ready = false;
    const promise = new Promise<void>((r) => {
      resolve = () => {
        ready = true;
        r();
      };
    });
    function Slow(): ReactNode {
      if (!ready) throw promise;
      return <Text text="Hazır" />;
    }
    let showSlow: () => void = () => {};
    function Shell() {
      const [show, setShow] = useState(false);
      showSlow = () => setShow(true);
      return (
        <Stack>
          <Text text="Sabit" />
          <Suspense fallback={<Text text="Yükleniyor" />}>{show && <Slow />}</Suspense>
        </Stack>
      );
    }
    root.render(<Shell />);
    showSlow();
    await flush();
    expect(treeText(tree)).toContain('Yükleniyor');
    resolve();
    await promise;
    // React throttles revealing a resolved boundary (about 300 ms).
    await waitFor(() => treeText(tree).includes('Hazır'));
    expect(treeText(tree)).not.toContain('Yükleniyor');
  });

  it('numbers batches monotonically and emits nothing for no-op renders', async () => {
    const { root, batches } = setup();
    let rerender: () => void = () => {};
    function Same() {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      return <Text text="Aynı" />;
    }
    root.render(<Same />);
    rerender();
    await flush();
    expect(batches.map((batch) => batch.seq)).toEqual([1]);
  });

  it('serialises a 1000-item list as one prop', () => {
    const { root, batches, tree } = setup();
    const items = Array.from({ length: 1000 }, (_, index) => ({ key: `k${index}`, title: `Öğe ${index}` }));
    root.render(<List items={items} />);
    expect(batches).toHaveLength(1);
    const list = findByType(tree, 'List')[0];
    expect((list.props.items as unknown[]).length).toBe(1000);
  });

  it('unmounts to an empty root', () => {
    const { root, tree } = setup();
    root.render(<Text text="x" />);
    root.unmount();
    expect(tree.root).toBeNull();
    expect(tree.nodes.size).toBe(0);
  });
});

function Badge2() {
  return <Text text="Sabit" tone="muted" />;
}
