import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  diffSnapshots,
  isVersionFieldKey,
  normalizeSnapshot,
  scalarFieldsOf,
  valuesEqual,
  type VersionSnapshot,
} from './versioning';

const v2 = (over: Partial<VersionSnapshot> = {}): VersionSnapshot => ({
  schemaVersion: 2,
  title: '旧八仙桌',
  category: 'furniture',
  status: 'published',
  visibility: 'family',
  acquiredAt: '1998-06-01T00:00:00.000Z',
  acquiredPrecision: 'year',
  acquiredLabel: '搬进老宅那年',
  acquiredNote: null,
  placeText: null,
  placeCity: '苏州',
  placeProvince: '江苏',
  placeCountry: null,
  placeLat: null,
  placeLng: null,
  storyHtml: '<p>祖上留下的</p>',
  condition: '完好',
  storageLocation: null,
  tags: ['家具'],
  coverMediaId: 'cm1',
  people: [{ personId: 'p1', role: 'source' }],
  sharedWith: [{ userId: 'u1', canEdit: true }],
  ...over,
});

describe('normalizeSnapshot', () => {
  it('兼容 v1 快照：关联字段标记为未记录，其余给默认值', () => {
    const s = normalizeSnapshot({
      title: '票据',
      category: 'receipt',
      status: 'published',
      visibility: 'private',
      acquiredAt: '2001-01-01T00:00:00.000Z',
      acquiredPrecision: 'day',
      tags: ['a', 'b'],
      coverMediaId: 'cm9',
    });
    expect(s.schemaVersion).toBe(1);
    expect(s.people).toBeUndefined();
    expect(s.sharedWith).toBeUndefined();
    expect(s.tags).toEqual(['a', 'b']);
    expect(s.coverMediaId).toBe('cm9');
    expect(s.placeLat).toBeNull();
    expect(s.storyHtml).toBeNull();
  });

  it('脏数据不会击穿归一化：非法角色回落 source，过滤残缺行', () => {
    const s = normalizeSnapshot({
      schemaVersion: 2,
      people: [{ personId: 'p1', role: 'ghost' }, { personId: '', role: 'owner' }, null],
      sharedWith: [{ userId: 'u1', canEdit: 1 }, { userId: 42 }],
      placeLat: '31.3',
      tags: [1, 'x', null],
    });
    expect(s.people).toEqual([{ personId: 'p1', role: 'source' }]);
    expect(s.sharedWith).toEqual([{ userId: 'u1', canEdit: false }]);
    expect(s.placeLat).toBe(31.3);
    expect(s.tags).toEqual(['x']);
  });

  it('buildSnapshot 与 normalize 形状一致，且 Decimal 可经 toString 转数字', () => {
    const snap = buildSnapshot({
      title: 't',
      category: 'other',
      status: 'draft',
      visibility: 'family',
      acquiredAt: null,
      acquiredPrecision: 'unknown',
      acquiredLabel: null,
      acquiredNote: null,
      placeText: null,
      placeCity: null,
      placeProvince: null,
      placeCountry: null,
      placeLat: { toString: () => '30.100000' },
      placeLng: null,
      storyHtml: null,
      condition: null,
      storageLocation: null,
      tags: [],
      coverMediaId: null,
      people: [],
      sharedWith: [],
    });
    expect(snap.schemaVersion).toBe(2);
    expect(snap.placeLat).toBe(30.1);
    expect(normalizeSnapshot(snap)).toEqual(snap);
  });
});

describe('diffSnapshots', () => {
  it('逐字段标出变化，未变化的组 changed=false', () => {
    const diffs = diffSnapshots(v2(), v2({ title: '新名字' }));
    expect(diffs.find((d) => d.key === 'title')?.changed).toBe(true);
    expect(diffs.find((d) => d.key === 'category')?.changed).toBe(false);
  });

  it('人物关联按内容比较，行顺序不同不算差异', () => {
    const a = v2({ people: [
      { personId: 'p1', role: 'source' },
      { personId: 'p2', role: 'gifted' },
    ] });
    const b = v2({ people: [
      { personId: 'p2', role: 'gifted' },
      { personId: 'p1', role: 'source' },
    ] });
    expect(diffSnapshots(a, b).find((d) => d.key === 'people')?.changed).toBe(false);
  });

  it('授权差异只看 userId/canEdit，顺序无关', () => {
    const a = v2({ sharedWith: [
      { userId: 'u1', canEdit: false },
      { userId: 'u2', canEdit: true },
    ] });
    const b = v2({ sharedWith: [
      { userId: 'u2', canEdit: true },
      { userId: 'u1', canEdit: false },
    ] });
    expect(diffSnapshots(a, b).find((d) => d.key === 'sharedWith')?.changed).toBe(false);

    const c = v2({ sharedWith: [{ userId: 'u1', canEdit: true }] });
    expect(diffSnapshots(a, c).find((d) => d.key === 'sharedWith')?.changed).toBe(true);
  });

  it('v1 快照对比时，人物/授权组 snapshotted=false 且不算 changed', () => {
    const v1 = normalizeSnapshot({ title: '旧', category: 'other', status: 'draft', visibility: 'family' });
    const diffs = diffSnapshots(v2(), v1);
    const people = diffs.find((d) => d.key === 'people')!;
    const shares = diffs.find((d) => d.key === 'sharedWith')!;
    expect(people.snapshotted).toBe(false);
    expect(people.changed).toBe(false);
    expect(shares.snapshotted).toBe(false);
    // 封面 v1 就有记录
    expect(diffs.find((d) => d.key === 'coverMediaId')?.snapshotted).toBe(true);
  });

  it('地点是复合组，任一子字段变化整组标变化', () => {
    const a = v2();
    const b = v2({ placeCity: '杭州' });
    const place = diffSnapshots(a, b).find((d) => d.key === 'place')!;
    expect(place.composite).toBe(true);
    expect(place.changed).toBe(true);
    expect((place.target as Record<string, unknown>).placeCity).toBe('杭州');
  });
});

describe('field helpers', () => {
  it('valuesEqual 深比较数组', () => {
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a'], ['a', 'b'])).toBe(false);
    expect(valuesEqual(null, undefined)).toBe(false);
  });

  it('isVersionFieldKey 与 scalarFieldsOf', () => {
    expect(isVersionFieldKey('tags')).toBe(true);
    expect(isVersionFieldKey('status')).toBe(false);
    expect(scalarFieldsOf('place')).toEqual(['placeText', 'placeCity', 'placeProvince', 'placeCountry', 'placeLat', 'placeLng']);
    expect(scalarFieldsOf('people')).toEqual([]);
  });
});
