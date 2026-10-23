import { describe, expect, it } from 'vitest';
import { COMPONENT_TYPES, componentPropSchemas, validateTree, type UiNode } from './index.js';

const h = (id: number) => ({ $handler: id });
const node = (id: number, type: string, props: UiNode['props'] = {}, children: number[] = []): UiNode => ({ id, type, props, children });

/** A realistic tree: Screen > Stack > [Text > #text, List, Button]. */
const sampleTree = (): UiNode[] => [
  node(1, 'Screen', { title: 'Projeler', actions: [{ key: 'refresh', label: 'Yenile', icon: 'arrow-clockwise', onPress: h(1) }] }, [2]),
  node(2, 'Stack', { direction: 'vertical', gap: 'md' }, [3, 5, 6]),
  node(3, 'Text', { variant: 'heading' }, [4]),
  node(4, '#text', { text: 'Geciken görevler' }),
  node(5, 'List', { items: [{ key: 'p1', title: 'Proje 1', badge: { text: '3', tone: 'danger' } }], onSelect: h(2) }),
  node(6, 'Button', { label: 'Rapor gönder', onPress: h(3), variant: 'primary' }),
];

const codesOf = (nodes: UiNode[] | Map<number, UiNode>, root: number | null) => validateTree(nodes, root).issues.map((i) => i.code);

describe('validateTree', () => {
  it('accepts a valid tree (array and map)', () => {
    expect(validateTree(sampleTree(), 1)).toEqual({ ok: true, issues: [] });
    expect(validateTree(new Map(sampleTree().map((n) => [n.id, n])), 1).ok).toBe(true);
    expect(validateTree([], null).ok).toBe(true);
  });

  it('detects missing root and children', () => {
    expect(codesOf(sampleTree(), 99)).toEqual(['tree.root_missing']);
    const nodes = sampleTree();
    nodes[1]!.children.push(42);
    expect(validateTree(nodes, 1).issues).toEqual([expect.objectContaining({ code: 'tree.child_missing', nodeId: 2 })]);
  });

  it('detects cycles', () => {
    const nodes = [node(1, 'Stack', {}, [2]), node(2, 'Card', {}, [3]), node(3, 'Stack', {}, [1])];
    expect(codesOf(nodes, 1)).toContain('tree.cycle');
    expect(codesOf([node(7, 'Stack', {}, [7])], 7)).toContain('tree.cycle');
  });

  it('detects cycles in detached subtrees', () => {
    const nodes = [node(1, 'Stack'), node(2, 'Stack', {}, [3]), node(3, 'Stack', {}, [2])];
    expect(codesOf(nodes, 1)).toContain('tree.cycle');
  });

  it('detects shared children', () => {
    const nodes = [node(1, 'Stack', {}, [3]), node(2, 'Stack', {}, [3]), node(3, 'Badge', { text: 'x' }), node(0, 'Stack', {}, [1, 2])];
    expect(codesOf(nodes, 0)).toEqual(['tree.shared_child']);
    expect(codesOf([node(1, 'Stack', {}, [2, 2]), node(2, 'Badge', { text: 'x' })], 1)).toEqual(['tree.shared_child']);
  });

  it('rejects unknown types', () => {
    expect(validateTree([node(1, 'div')], 1).issues).toEqual([expect.objectContaining({ code: 'tree.unknown_type', nodeId: 1 })]);
  });

  it('rejects unknown props with a path', () => {
    const issues = validateTree([node(1, 'Button', { label: 'x', onPress: h(1), color: 'red' })], 1).issues;
    expect(issues).toEqual([expect.objectContaining({ code: 'tree.unknown_prop', nodeId: 1, path: 'color' })]);
    const nested = validateTree([node(1, 'List', { items: [{ key: 'a', title: 'A', avatar: 'x' }] })], 1).issues;
    expect(nested).toEqual([expect.objectContaining({ code: 'tree.unknown_prop', path: 'items[0].avatar' })]);
  });

  it('rejects invalid prop values', () => {
    const cases: [string, UiNode['props']][] = [
      ['Button', { label: 'x' }], // missing onPress
      ['Button', { label: 'x', onPress: 'doIt' }], // handler must be a ref
      ['Button', { label: 'x', onPress: h(1), variant: 'link' }],
      ['Stack', { gap: 'xl' }],
      ['Text', { tone: 'purple' }],
      ['Menu', { items: [], onSelect: h(1) }], // needs label or icon
      ['DatePicker', { name: 'due', label: 'Due', value: '16/10/2026' }],
      ['Chart', { kind: 'pie', series: [] }],
      ['Table', { columns: [{ key: 'a', title: 'A' }], rows: [{ key: 'r', cells: { a: true } }] }],
      ['Form', {}],
    ];
    for (const [type, props] of cases) {
      const issues = validateTree([node(1, type, props)], 1).issues;
      expect(issues.map((i) => i.code), `${type} ${JSON.stringify(props)}`).toContain('tree.invalid_prop');
    }
  });

  it('validates #text nodes', () => {
    expect(codesOf([node(1, 'Text', {}, [2]), node(2, '#text', { text: 5 })], 1)).toEqual(['tree.text_invalid']);
    expect(codesOf([node(1, 'Text', {}, [2]), node(2, '#text', { text: 'a', bold: true })], 1)).toEqual(['tree.text_invalid']);
    expect(codesOf([node(1, 'Text', {}, [2]), node(2, '#text', { text: 'a' }, [3]), node(3, '#text', { text: 'b' })], 1)).toContain(
      'tree.text_invalid',
    );
  });

  it('only allows text inside Text and children inside containers', () => {
    expect(codesOf([node(1, 'Stack', {}, [2]), node(2, '#text', { text: 'loose' })], 1)).toEqual(['tree.text_outside_text']);
    expect(codesOf([node(1, '#text', { text: 'root' })], 1)).toEqual(['tree.text_outside_text']);
    expect(codesOf([node(1, 'Button', { label: 'x', onPress: h(1) }, [2]), node(2, 'Badge', { text: 'b' })], 1)).toEqual([
      'tree.children_not_allowed',
    ]);
    expect(codesOf([node(1, 'Text', {}, [2]), node(2, 'Badge', { text: 'b' })], 1)).toEqual(['tree.children_not_allowed']);
  });

  it('reports malformed nodes and id mismatches', () => {
    expect(codesOf([{ id: 1.5, type: 'Stack', props: {}, children: [] } as UiNode], null)).toEqual(['tree.invalid_node']);
    expect(codesOf(new Map([[5, node(6, 'Stack')]]), null)).toEqual(['tree.id_mismatch']);
    expect(codesOf([node(1, 'Stack'), node(1, 'Stack')], 1)).toEqual(['tree.invalid_node']);
  });
});

describe('componentPropSchemas', () => {
  it('has a strict schema for every component type', () => {
    expect(Object.keys(componentPropSchemas).sort()).toEqual([...COMPONENT_TYPES].sort());
    for (const type of COMPONENT_TYPES) {
      const result = componentPropSchemas[type].safeParse({ __unknown: 1 });
      expect(result.success, type).toBe(false);
    }
  });

  it('accepts complete prop sets from the contract table', () => {
    const valid: Record<string, unknown> = {
      Screen: { title: 't', subtitle: 's', actions: [{ key: 'a', label: 'A', onPress: h(1) }], loading: false, scroll: true },
      Stack: { direction: 'horizontal', gap: 'none', align: 'center', justify: 'between', wrap: true, padding: 'lg' },
      Text: { text: 'x', variant: 'caption', tone: 'muted', weight: 'semibold', truncate: true },
      List: { items: [{ key: 1, title: 'A', subtitle: 'B', meta: 'C', badge: { text: 'x' }, icon: 'folder', disabled: true }], onSelect: h(1), emptyText: 'none', loading: true },
      Table: { columns: [{ key: 'a', title: 'A', width: 120, align: 'end' }], rows: [{ key: 'r1', cells: { a: 1, b: null, c: 'x' } }], onSelectRow: h(1), emptyText: '-' },
      Form: { onSubmit: h(1), submitLabel: 'Kaydet', cancelLabel: 'İptal', onCancel: h(2) },
      TextField: { name: 'n', label: 'L', value: 'v', placeholder: 'p', multiline: true, secure: false, required: true, error: 'e', onChange: h(1) },
      Select: { name: 'n', label: 'L', value: null, options: [{ value: 'a', label: 'A' }], placeholder: 'p', onChange: h(1) },
      DatePicker: { name: 'n', label: 'L', value: '2026-10-16T09:30:00Z', mode: 'datetime', onChange: h(1) },
      Button: { label: 'L', onPress: h(1), variant: 'danger', icon: 'trash', disabled: true, loading: false },
      Menu: { icon: 'dots-three', items: [{ key: 'del', label: 'Sil', icon: 'trash', destructive: true, disabled: false }], onSelect: h(1) },
      Card: { title: 't', subtitle: 's', actions: [], padding: 'sm' },
      Badge: { text: 'x', tone: 'success' },
      EmptyState: { title: 't', description: 'd', icon: 'tray', action: { label: 'Ekle', onPress: h(1) } },
      Chart: { kind: 'line', series: [{ name: 'S', points: [{ x: 'Pzt', y: 3 }] }], height: 200 },
      Tabs: { items: [{ key: 'posts', label: 'Gönderiler', badge: 3 }, { key: 'ads', label: 'Reklamlar', disabled: true }], value: 'posts', label: 'İçerik bölümleri', onChange: h(1) },
      Switch: { label: 'Kanal açık', value: true, description: 'Instagram', disabled: false, onChange: h(1) },
      MultiSelect: { label: 'Kanallar', value: ['ig'], options: [{ value: 'ig', label: 'Instagram' }], placeholder: 'Seç', max: 3, disabled: false, onChange: h(1) },
      Stat: { label: 'Harcama', value: 1250.5, format: 'currency', currency: 'TRY', delta: -0.12, deltaGood: 'down', caption: 'Son 30 gün' },
      Banner: { tone: 'warning', title: 'Bağlantı', text: 'Süresi doldu', action: { label: 'Yeniden bağla', onPress: h(1) }, onDismiss: h(2) },
      Image: { src: 'https://cdn.example.com/a.jpg', alt: 'Görsel', aspectRatio: 1.5, fit: 'contain', poster: 'https://cdn.example.com/a-thumb.jpg' },
      Avatar: { name: 'Ayşe', src: 'https://cdn.example.com/ayse.png', size: 'sm' },
      ProgressBar: { value: 0.4, label: 'Yükleniyor', tone: 'default' },
    };
    for (const type of COMPONENT_TYPES) {
      const result = componentPropSchemas[type].safeParse(valid[type]);
      expect(result.error?.issues ?? [], type).toEqual([]);
    }
  });

  it('checks the Phase 5a props (formats, currency, tabs count, image URLs)', () => {
    const fails = (type: keyof typeof componentPropSchemas, props: unknown) => componentPropSchemas[type].safeParse(props).success === false;
    expect(fails('Stat', { label: 'L', value: 1, format: 'currency' })).toBe(true);
    expect(fails('Stat', { label: 'L', value: 1, format: 'currency', currency: 'try' })).toBe(true);
    expect(fails('Chart', { kind: 'line', series: [], stacked: true })).toBe(true);
    expect(fails('Chart', { kind: 'area', series: [], stacked: true, valueFormat: 'percent' })).toBe(false);
    expect(fails('Table', { columns: [{ key: 'a', title: 'A', format: 'currency' }], rows: [] })).toBe(true);
    expect(fails('Table', { columns: [{ key: 'a', title: 'A', format: 'number', sortable: true }], rows: [], defaultSort: { key: 'a', direction: 'desc' } })).toBe(false);
    expect(fails('Tabs', { items: [{ key: 'a', label: 'A' }], value: 'a', onChange: h(1) })).toBe(true);
    expect(fails('Tabs', { items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], value: 'a', label: 'x'.repeat(41), onChange: h(1) })).toBe(true);
    expect(fails('Image', { src: 'javascript:alert(1)', alt: '' })).toBe(true);
    expect(fails('Image', { src: 'https://x.example/a.png' })).toBe(true);
    expect(fails('ProgressBar', { value: 1.5 })).toBe(true);
    expect(fails('ProgressBar', {})).toBe(false);
    expect(fails('TextField', { name: 'n', label: 'L', maxLength: 0 })).toBe(true);
    expect(fails('TextField', { name: 'n', label: 'L', maxLength: 280 })).toBe(false);
  });
});
