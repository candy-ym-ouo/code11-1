import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  fieldMeta,
  normalizeSnapshot,
  pickSnapshotFields,
  SNAPSHOT_FORMAT,
  VERSION_FIELD_KEYS,
} from './versions';

describe('normalizeSnapshot', () => {
  it('兼容最早的 v1 快照：人物与授权标记为 unsupported，其余字段给默认值', () => {
    const { value, format, unsupported } = normalizeSnapshot({
      title: '旧桌子',
      category: 'furniture',
      tags: ['家具'],
      coverMediaId: null,
    });
    expect(format).toBe(1);
    expect(value.title).toBe('旧桌子');
    expect(value.visibility).toBeNull();
    expect(value.acquiredAt).toBeNull();
    expect(value.tags).toEqual(['家具']);
    expect(value.people).toBeUndefined();
    expect(value.shares).toBeUndefined();
    expect(unsupported).toEqual(['people', 'shares']);
  });

  it('脏数据不会击穿规整：非法枚举回退 null，标签数组只保留字符串', () => {
    const { value } = normalizeSnapshot({
      format: SNAPSHOT_FORMAT,
      category: 'hacked',
      acquiredPrecision: 42,
      placeLat: 'abc',
      tags: ['ok', 3, null],
      people: [{ personId: 'p1', role: 'gifted' }, { personId: 1, role: 'owner' }],
      shares: [{ userId: 'u1', canEdit: true }, { userId: 'u2' }],
    });
    expect(value.category).toBeNull();
    expect(value.acquiredPrecision).toBeNull();
    expect(value.placeLat).toBeNull();
    expect(value.tags).toEqual(['ok']);
    expect(value.people).toEqual([{ personId: 'p1', role: 'gifted' }]);
    expect(value.shares).toEqual([{ userId: 'u1', canEdit: true }]);
  });
});

describe('diffSnapshots', () => {
  it('逐字段标出标量变化，未变化字段 changed=false', () => {
    const a = normalizeSnapshot({
      format: 2,
      title: 'A',
      category: 'receipt',
      visibility: 'family',
      tags: ['x'],
      people: [],
      shares: [],
    });
    const b = normalizeSnapshot({
      format: 2,
      title: 'B',
      category: 'receipt',
      visibility: 'private',
      tags: ['x'],
      people: [],
      shares: [],
    });
    const diff = diffSnapshots(a, b);
    const byKey = new Map(diff.fields.map((f) => [f.key, f]));
    expect(byKey.get('title')?.changed).toBe(true);
    expect(byKey.get('title')?.from).toBe('A');
    expect(byKey.get('title')?.to).toBe('B');
    expect(byKey.get('category')?.changed).toBe(false);
    expect(byKey.get('visibility')?.changed).toBe(true);
    expect(byKey.get('tags')?.changed).toBe(false);
    expect(diff.changedFields).toContain('title');
    expect(diff.changedFields).toContain('visibility');
    expect(diff.changedFields).not.toContain('status');
  });

  it('人物/授权按内容集合比较，忽略顺序', () => {
    const a = normalizeSnapshot({
      format: 2,
      people: [
        { personId: 'p1', role: 'source' },
        { personId: 'p2', role: 'owner' },
      ],
      shares: [{ userId: 'u1', canEdit: false }],
    });
    const b = normalizeSnapshot({
      format: 2,
      people: [
        { personId: 'p2', role: 'owner' },
        { personId: 'p1', role: 'source' },
      ],
      shares: [{ userId: 'u1', canEdit: false }],
    });
    const diff = diffSnapshots(a, b);
    expect(diff.changedFields).toEqual([]);
  });

  it('角色不同视为人物关系变化', () => {
    const a = normalizeSnapshot({ format: 2, people: [{ personId: 'p1', role: 'source' }] });
    const b = normalizeSnapshot({ format: 2, people: [{ personId: 'p1', role: 'owner' }] });
    expect(diffSnapshots(a, b).changedFields).toContain('people');
  });

  it('v1 → v2 的人物/授权字段标记一侧 unsupported 且不可回滚该字段', () => {
    // v1 快照即使 JSON 里混入了 people 也不予采信（旧格式不保存关联数据）
    const old = normalizeSnapshot({ title: 'A', people: [{ personId: 'p1', role: 'source' }] });
    const now = normalizeSnapshot({
      format: 2,
      title: 'A',
      people: [{ personId: 'p1', role: 'source' }],
    });
    const diff = diffSnapshots(old, now);
    const people = diff.fields.find((f) => f.key === 'people')!;
    expect(people.changed).toBe(true);
    expect(people.unsupported).toEqual(['from']);
    expect(diff.changedFields).not.toContain('people');
  });

  it('所有 VERSION_FIELD_KEYS 都有元数据，且只有 status 不可回滚', () => {
    for (const key of VERSION_FIELD_KEYS) {
      expect(fieldMeta(key)?.rollbackable).toBe(true);
    }
    expect(fieldMeta('status')?.rollbackable).toBe(false);
  });
});

describe('pickSnapshotFields', () => {
  const current = normalizeSnapshot({
    format: SNAPSHOT_FORMAT,
    title: '现标题',
    category: 'furniture',
    visibility: 'family',
    acquiredAt: '2020-01-01T00:00:00.000Z',
    acquiredPrecision: 'year',
    acquiredLabel: '现在的说法',
    storyHtml: '<p>现在的故事</p>',
    tags: ['a', 'b'],
    coverMediaId: null,
    people: [{ personId: 'p1', role: 'owner' }],
    shares: [{ userId: 'u1', canEdit: true }],
  }).value;

  const target = normalizeSnapshot({
    format: SNAPSHOT_FORMAT,
    title: '旧标题',
    category: 'receipt',
    visibility: 'private',
    acquiredAt: '1990-05-05T00:00:00.000Z',
    acquiredPrecision: 'day',
    acquiredLabel: '过去的说法',
    storyHtml: '<p>过去的故事</p>',
    tags: ['x'],
    coverMediaId: 'm1',
    people: [
      { personId: 'p1', role: 'source' },
      { personId: 'p2', role: 'mentioned' },
    ],
    shares: [],
  }).value;

  it('只覆盖勾选的标量字段，其余保留当前值', () => {
    const out = pickSnapshotFields(current, target, ['title']);
    expect(out.title).toBe('旧标题');
    expect(out.category).toBe('furniture');
    expect(out.visibility).toBe('family');
    expect(out.tags).toEqual(['a', 'b']);
    expect(out.storyHtml).toBe('<p>现在的故事</p>');
    expect(out.acquiredAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('人物/授权按集合整体替换，不勾选时保持现状', () => {
    const keep = pickSnapshotFields(current, target, ['title']);
    expect(keep.people).toEqual([{ personId: 'p1', role: 'owner' }]);
    expect(keep.shares).toEqual([{ userId: 'u1', canEdit: true }]);

    const rollPeople = pickSnapshotFields(current, target, ['people']);
    expect(rollPeople.people).toHaveLength(2);
    expect(rollPeople.shares).toEqual([{ userId: 'u1', canEdit: true }]);

    const rollShares = pickSnapshotFields(current, target, ['shares']);
    expect(rollShares.people).toEqual([{ personId: 'p1', role: 'owner' }]);
    expect(rollShares.shares).toEqual([]);
  });

  it('勾选封面但目标为空时得到 null（即清除封面）', () => {
    const out = pickSnapshotFields(target, current, ['coverMediaId']);
    expect(out.coverMediaId).toBeNull();
    expect(out.title).toBe('旧标题');
  });

  it('合并获得时间字段时，每组各取所需，不牵连未勾选字段', () => {
    const out = pickSnapshotFields(current, target, ['acquiredAt', 'acquiredPrecision']);
    expect(out.acquiredAt).toBe('1990-05-05T00:00:00.000Z');
    expect(out.acquiredPrecision).toBe('day');
    // 未勾选的说法/说明保留现状，供服务端一起参与 sortAt 计算
    expect(out.acquiredLabel).toBe('现在的说法');
  });
});
