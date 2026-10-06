/**
 * 条目版本：历史快照的归一化、逐字段分组与比较。
 *
 * 这一层不依赖 Prisma / Express，既给 API 做回滚判定，也给前端做差异展示，
 * 保证「看到的字段」和「能回滚的字段」是同一套定义。
 *
 * 快照分两代：
 * - v1（init 迁移时上线）：只含 Item 主表标量字段，没有人物关联、封面和单独授权；
 * - v2：补齐 people / coverMediaId 之外的关联信息（人物、指定成员授权）。
 * 读历史版本必须走 normalizeSnapshot，不能直接信任 JSON 形状。
 */

export type SnapshotCategory = 'furniture' | 'souvenir' | 'receipt' | 'manuscript' | 'other';
export type SnapshotVisibility = 'private' | 'family' | 'selected' | 'link';
export type SnapshotPrecision = 'day' | 'month' | 'year' | 'decade' | 'unknown';
export type SnapshotPersonRole = 'source' | 'gifted' | 'inherited' | 'owner' | 'mentioned';

export interface SnapshotPerson {
  personId: string;
  role: SnapshotPersonRole;
}

export interface SnapshotShare {
  userId: string;
  canEdit: boolean;
}

/** 归一化后的版本快照。缺失的关联字段以 undefined 表示「该年代的快照没记录」。 */
export interface VersionSnapshot {
  schemaVersion: 1 | 2;
  title: string;
  category: SnapshotCategory;
  status: string;
  visibility: SnapshotVisibility;
  acquiredAt: string | null;
  acquiredPrecision: SnapshotPrecision;
  acquiredLabel: string | null;
  acquiredNote: string | null;
  placeText: string | null;
  placeCity: string | null;
  placeProvince: string | null;
  placeCountry: string | null;
  placeLat: number | null;
  placeLng: number | null;
  storyHtml: string | null;
  condition: string | null;
  storageLocation: string | null;
  tags: string[];
  coverMediaId: string | null;
  /** v1 快照没有记录人物关联，为 undefined。 */
  people?: SnapshotPerson[];
  /** v1 快照没有记录「指定成员」授权，为 undefined。 */
  sharedWith?: SnapshotShare[];
}

/** 可以参与逐字段对比 / 选择性回滚的字段组定义。status 不在其中：发布状态不走版本回滚。 */
export const VERSION_FIELD_GROUPS = [
  { key: 'title', label: '标题' },
  { key: 'category', label: '分类' },
  { key: 'visibility', label: '可见范围' },
  { key: 'acquiredAt', label: '获得时间' },
  { key: 'acquiredLabel', label: '获得时间（口述）' },
  { key: 'acquiredNote', label: '获得经过备注' },
  {
    key: 'place',
    label: '地点',
    fields: ['placeText', 'placeCity', 'placeProvince', 'placeCountry', 'placeLat', 'placeLng'],
  },
  { key: 'storyHtml', label: '故事正文' },
  { key: 'condition', label: '品相' },
  { key: 'storageLocation', label: '存放位置' },
  { key: 'tags', label: '标签' },
  { key: 'people', label: '来源人物', relation: true },
  { key: 'coverMediaId', label: '封面', relation: true },
  { key: 'sharedWith', label: '指定成员授权', relation: true },
] as const;

export type VersionFieldKey = (typeof VERSION_FIELD_GROUPS)[number]['key'];
export const VERSION_FIELD_KEYS = VERSION_FIELD_GROUPS.map((g) => g.key) as VersionFieldKey[];

const SCALAR_KEYS = [
  'title',
  'category',
  'visibility',
  'acquiredAt',
  'acquiredPrecision',
  'acquiredLabel',
  'acquiredNote',
  'placeText',
  'placeCity',
  'placeProvince',
  'placeCountry',
  'placeLat',
  'placeLng',
  'storyHtml',
  'condition',
  'storageLocation',
  'tags',
  'coverMediaId',
] as const;

const PERSON_ROLES = ['source', 'gifted', 'inherited', 'owner', 'mentioned'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asPeople(v: unknown): SnapshotPerson[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    .map((x) => ({
      personId: typeof x.personId === 'string' ? x.personId : '',
      role: (PERSON_ROLES as readonly string[]).includes(x.role as string)
        ? (x.role as SnapshotPersonRole)
        : 'source',
    }))
    .filter((p) => p.personId.length > 0);
}

function asShares(v: unknown): SnapshotShare[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    .map((x) => ({
      userId: typeof x.userId === 'string' ? x.userId : '',
      canEdit: x.canEdit === true,
    }))
    .filter((s) => s.userId.length > 0);
}

/**
 * 把任意历史 JSON 快照归一化成当前形状。
 * v1 快照缺少 people / sharedWith（保留 undefined，由调用方按「该版本未记录」处理）。
 */
export function normalizeSnapshot(raw: unknown): VersionSnapshot {
  const s = (raw ?? {}) as Record<string, unknown>;
  const people = asPeople(s.people);
  const sharedWith = asShares(s.sharedWith);
  const schemaVersion: 1 | 2 = s.schemaVersion === 2 || people !== undefined || sharedWith !== undefined ? 2 : 1;

  return {
    schemaVersion,
    title: typeof s.title === 'string' ? s.title : '',
    category: (str(s.category) as SnapshotCategory) ?? 'other',
    status: str(s.status) ?? 'draft',
    visibility: (str(s.visibility) as SnapshotVisibility) ?? 'family',
    acquiredAt: str(s.acquiredAt),
    acquiredPrecision: (str(s.acquiredPrecision) as SnapshotPrecision) ?? 'unknown',
    acquiredLabel: str(s.acquiredLabel),
    acquiredNote: str(s.acquiredNote),
    placeText: str(s.placeText),
    placeCity: str(s.placeCity),
    placeProvince: str(s.placeProvince),
    placeCountry: str(s.placeCountry),
    placeLat: num(s.placeLat),
    placeLng: num(s.placeLng),
    storyHtml: str(s.storyHtml),
    condition: str(s.condition),
    storageLocation: str(s.storageLocation),
    tags: asTags(s.tags),
    coverMediaId: str(s.coverMediaId),
    ...(people !== undefined ? { people } : {}),
    ...(sharedWith !== undefined ? { sharedWith } : {}),
  };
}

/**
 * 从「当前条目 + 关联行」构造快照。写库路径统一走这里，
 * 保证新快照（v2）与 normalizeSnapshot 的形状一致。
 */
export function buildSnapshot(input: {
  title: string;
  category: string;
  status: string;
  visibility: string;
  acquiredAt: Date | string | null;
  acquiredPrecision: string;
  acquiredLabel: string | null;
  acquiredNote: string | null;
  placeText: string | null;
  placeCity: string | null;
  placeProvince: string | null;
  placeCountry: string | null;
  placeLat: number | { toString(): string } | null;
  placeLng: number | { toString(): string } | null;
  storyHtml: string | null;
  condition: string | null;
  storageLocation: string | null;
  tags: string[];
  coverMediaId: string | null;
  people?: SnapshotPerson[];
  sharedWith?: SnapshotShare[];
}): VersionSnapshot {
  return {
    schemaVersion: 2,
    title: input.title,
    category: input.category as SnapshotCategory,
    status: input.status,
    visibility: input.visibility as SnapshotVisibility,
    acquiredAt: input.acquiredAt instanceof Date ? input.acquiredAt.toISOString() : input.acquiredAt,
    acquiredPrecision: input.acquiredPrecision as SnapshotPrecision,
    acquiredLabel: input.acquiredLabel,
    acquiredNote: input.acquiredNote,
    placeText: input.placeText,
    placeCity: input.placeCity,
    placeProvince: input.placeProvince,
    placeCountry: input.placeCountry,
    placeLat: input.placeLat === null ? null : Number(input.placeLat),
    placeLng: input.placeLng === null ? null : Number(input.placeLng),
    storyHtml: input.storyHtml,
    condition: input.condition,
    storageLocation: input.storageLocation,
    tags: [...input.tags],
    coverMediaId: input.coverMediaId,
    people: input.people ?? [],
    sharedWith: input.sharedWith ?? [],
  };
}

/** 标量深比较（JSON 原生值 / 数组 / 普通对象）。 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * 人物关联按 (personId, role) 排序后比较，避免行顺序导致假差异；
 * 授权按 userId 比较，canEdit 参与比对。
 */
function relationEqual(key: 'people' | 'sharedWith', a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (key === 'people') {
    const pa = [...(a as SnapshotPerson[])].sort((x, y) => x.personId.localeCompare(y.personId) || x.role.localeCompare(y.role));
    const pb = [...(b as SnapshotPerson[])].sort((x, y) => x.personId.localeCompare(y.personId) || x.role.localeCompare(y.role));
    return valuesEqual(pa, pb);
  }
  const sa = [...(a as SnapshotShare[])].sort((x, y) => x.userId.localeCompare(y.userId));
  const sb = [...(b as SnapshotShare[])].sort((x, y) => x.userId.localeCompare(y.userId));
  return valuesEqual(sa, sb);
}

export interface FieldGroupDiff {
  key: VersionFieldKey;
  label: string;
  /** 该组是否由多个标量字段组成（如地点）。 */
  composite: boolean;
  /** 是否为关联数据（人物 / 封面 / 授权），需要服务端补充实体现状。 */
  relation: boolean;
  /** 目标历史版本是否记录了该字段；v1 快照对人物/授权为 false。 */
  snapshotted: boolean;
  changed: boolean;
  current: unknown;
  target: unknown;
}

/**
 * 逐字段对比两个归一化快照。
 * @param current 当前（或较新）版本
 * @param target  历史版本（回滚目标）
 */
export function diffSnapshots(current: VersionSnapshot, target: VersionSnapshot): FieldGroupDiff[] {
  return VERSION_FIELD_GROUPS.map((group) => {
    const key = group.key;
    const relation = 'relation' in group && group.relation === true;
    const fields = 'fields' in group ? group.fields : [key];

    if (relation) {
      if (key === 'coverMediaId') {
        return {
          key,
          label: group.label,
          composite: false,
          relation: true,
          snapshotted: true,
          changed: !valuesEqual(current.coverMediaId, target.coverMediaId),
          current: current.coverMediaId,
          target: target.coverMediaId,
        };
      }
      const relKey = key as 'people' | 'sharedWith';
      const snapshotted = target[relKey] !== undefined;
      return {
        key,
        label: group.label,
        composite: false,
        relation: true,
        snapshotted,
        changed: snapshotted && !relationEqual(relKey, current[relKey], target[relKey]),
        current: current[relKey] ?? [],
        target: target[relKey] ?? [],
      };
    }

    const get = (s: VersionSnapshot, f: string) => (s as unknown as Record<string, unknown>)[f];
    const changed = fields.some((f) => !valuesEqual(get(current, f), get(target, f)));
    if (fields.length === 1) {
      return {
        key,
        label: group.label,
        composite: false,
        relation: false,
        snapshotted: true,
        changed,
        current: get(current, key),
        target: get(target, key),
      };
    }
    return {
      key,
      label: group.label,
      composite: true,
      relation: false,
      snapshotted: true,
      changed,
      current: Object.fromEntries(fields.map((f) => [f, get(current, f)])),
      target: Object.fromEntries(fields.map((f) => [f, get(target, f)])),
    };
  });
}

export function isVersionFieldKey(key: string): key is VersionFieldKey {
  return (VERSION_FIELD_KEYS as string[]).includes(key);
}

/** 标量字段名集合，供回滚时映射到 Item 列。acquiredAt 组连带 precision。 */
export function scalarFieldsOf(key: VersionFieldKey): string[] {
  const group = VERSION_FIELD_GROUPS.find((g) => g.key === key);
  if (!group || ('relation' in group && group.relation)) return [];
  return 'fields' in group ? [...group.fields] : [key];
}

export { SCALAR_KEYS };
