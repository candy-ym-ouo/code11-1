import { z } from 'zod';
import {
  CATEGORIES,
  ITEM_STATUSES,
  PERSON_ROLES,
  PRECISIONS,
  VISIBILITIES,
  type Category,
  type ItemStatus,
  type PersonRole,
  type Precision,
  type Visibility,
} from './enums';

/**
 * 历史快照格式：
 * - 1：仅条目标量字段 + coverMediaId（最早版本，不含人物/授权）
 * - 2：增加 people、shares、storyText
 * 旧快照永远只读，靠 normalizeSnapshot 兼容，不做迁移改写。
 */
export const SNAPSHOT_FORMAT = 2;

export interface VersionPersonRef {
  personId: string;
  role: PersonRole;
}

export interface VersionShareRef {
  userId: string;
  canEdit: boolean;
}

export interface VersionSnapshot {
  format?: number;
  title: string | null;
  category: Category | null;
  status: ItemStatus | null;
  visibility: Visibility | null;
  acquiredAt: string | null;
  acquiredPrecision: Precision | null;
  acquiredLabel: string | null;
  acquiredNote: string | null;
  placeText: string | null;
  placeCity: string | null;
  placeProvince: string | null;
  placeCountry: string | null;
  placeLat: number | null;
  placeLng: number | null;
  storyHtml: string | null;
  storyText?: string | null;
  condition: string | null;
  storageLocation: string | null;
  tags: string[];
  coverMediaId: string | null;
  people?: VersionPersonRef[];
  shares?: VersionShareRef[];
}

export type VersionFieldGroup = 'basic' | 'acquisition' | 'place' | 'story' | 'relations';
export type VersionFieldKind =
  | 'text'
  | 'longtext'
  | 'enum'
  | 'date'
  | 'number'
  | 'tags'
  | 'cover'
  | 'people'
  | 'shares';

/** 可选择性回滚的字段（status 只展示差异，不能回滚，避免绕过发布/回收站流程）。 */
export const VERSION_FIELD_KEYS = [
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
  'people',
  'shares',
] as const;
export type VersionFieldKey = (typeof VERSION_FIELD_KEYS)[number];

export interface VersionFieldMeta {
  key: VersionFieldKey | 'status';
  label: string;
  group: VersionFieldGroup;
  kind: VersionFieldKind;
  /** false 表示只能看差异，不能回滚（目前只有 status）。 */
  rollbackable: boolean;
}

export const VERSION_FIELD_GROUPS: { key: VersionFieldGroup; label: string }[] = [
  { key: 'basic', label: '基本信息' },
  { key: 'acquisition', label: '获得时间' },
  { key: 'place', label: '地点' },
  { key: 'story', label: '故事与现状' },
  { key: 'relations', label: '人物、封面与授权' },
];

export const VERSION_FIELDS: VersionFieldMeta[] = [
  { key: 'title', label: '标题', group: 'basic', kind: 'text', rollbackable: true },
  { key: 'category', label: '分类', group: 'basic', kind: 'enum', rollbackable: true },
  { key: 'visibility', label: '可见范围', group: 'basic', kind: 'enum', rollbackable: true },
  { key: 'status', label: '状态', group: 'basic', kind: 'enum', rollbackable: false },
  { key: 'acquiredAt', label: '获得日期', group: 'acquisition', kind: 'date', rollbackable: true },
  { key: 'acquiredPrecision', label: '时间精度', group: 'acquisition', kind: 'enum', rollbackable: true },
  { key: 'acquiredLabel', label: '口头说法', group: 'acquisition', kind: 'text', rollbackable: true },
  { key: 'acquiredNote', label: '时间说明', group: 'acquisition', kind: 'longtext', rollbackable: true },
  { key: 'placeText', label: '地点', group: 'place', kind: 'text', rollbackable: true },
  { key: 'placeCity', label: '城市', group: 'place', kind: 'text', rollbackable: true },
  { key: 'placeProvince', label: '省/州', group: 'place', kind: 'text', rollbackable: true },
  { key: 'placeCountry', label: '国家', group: 'place', kind: 'text', rollbackable: true },
  { key: 'placeLat', label: '纬度', group: 'place', kind: 'number', rollbackable: true },
  { key: 'placeLng', label: '经度', group: 'place', kind: 'number', rollbackable: true },
  { key: 'storyHtml', label: '故事正文', group: 'story', kind: 'longtext', rollbackable: true },
  { key: 'condition', label: '品相', group: 'story', kind: 'text', rollbackable: true },
  { key: 'storageLocation', label: '存放位置', group: 'story', kind: 'text', rollbackable: true },
  { key: 'tags', label: '标签', group: 'story', kind: 'tags', rollbackable: true },
  { key: 'coverMediaId', label: '封面', group: 'relations', kind: 'cover', rollbackable: true },
  { key: 'people', label: '关联人物', group: 'relations', kind: 'people', rollbackable: true },
  { key: 'shares', label: '成员授权', group: 'relations', kind: 'shares', rollbackable: true },
];

const FIELD_META_BY_KEY = new Map(VERSION_FIELDS.map((f) => [f.key, f]));

export function fieldMeta(key: string): VersionFieldMeta | undefined {
  return FIELD_META_BY_KEY.get(key as VersionFieldKey);
}

export interface NormalizedSnapshot {
  value: VersionSnapshot;
  format: number;
  /** 该快照没有保存、因此无法回滚的字段。 */
  unsupported: VersionFieldKey[];
}

function enumOrNull<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 把任意历史版本的 JSON 快照规整成统一形态。
 * 旧格式缺字段时用 null/空数组占位，并在 unsupported 里标出，调用方据此禁用对应勾选项。
 */
export function normalizeSnapshot(raw: unknown): NormalizedSnapshot {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const format = typeof s.format === 'number' && s.format > 0 ? Math.floor(s.format) : 1;

  const value: VersionSnapshot = {
    title: textOrNull(s.title),
    category: enumOrNull(s.category, CATEGORIES),
    status: enumOrNull(s.status, ITEM_STATUSES),
    visibility: enumOrNull(s.visibility, VISIBILITIES),
    acquiredAt: textOrNull(s.acquiredAt),
    acquiredPrecision: enumOrNull(s.acquiredPrecision, PRECISIONS),
    acquiredLabel: textOrNull(s.acquiredLabel),
    acquiredNote: textOrNull(s.acquiredNote),
    placeText: textOrNull(s.placeText),
    placeCity: textOrNull(s.placeCity),
    placeProvince: textOrNull(s.placeProvince),
    placeCountry: textOrNull(s.placeCountry),
    placeLat: numberOrNull(s.placeLat),
    placeLng: numberOrNull(s.placeLng),
    storyHtml: textOrNull(s.storyHtml),
    storyText: textOrNull(s.storyText),
    condition: textOrNull(s.condition),
    storageLocation: textOrNull(s.storageLocation),
    tags: stringArray(s.tags),
    coverMediaId: textOrNull(s.coverMediaId),
  };

  const unsupported: VersionFieldKey[] = [];
  if (format >= 2) {
    value.people = Array.isArray(s.people)
      ? s.people
          .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
          .flatMap((p) =>
            typeof p.personId === 'string' && enumOrNull(p.role, PERSON_ROLES)
              ? [{ personId: p.personId, role: enumOrNull(p.role, PERSON_ROLES) as PersonRole }]
              : [],
          )
      : [];
    value.shares = Array.isArray(s.shares)
      ? s.shares
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .flatMap((x) =>
            typeof x.userId === 'string' && typeof x.canEdit === 'boolean'
              ? [{ userId: x.userId, canEdit: x.canEdit }]
              : [],
          )
      : [];
  } else {
    unsupported.push('people', 'shares');
  }

  return { value, format, unsupported };
}

function peopleSet(s: VersionSnapshot): string[] {
  return (s.people ?? [])
    .map((p) => `${p.personId}::${p.role}`)
    .sort();
}

function sharesSet(s: VersionSnapshot): string[] {
  return (s.shares ?? [])
    .map((x) => `${x.userId}::${x.canEdit ? 1 : 0}`)
    .sort();
}

function isChanged(from: VersionSnapshot, to: VersionSnapshot, key: string): boolean {
  switch (key) {
    case 'tags':
      return JSON.stringify(from.tags) !== JSON.stringify(to.tags);
    case 'people':
      return JSON.stringify(peopleSet(from)) !== JSON.stringify(peopleSet(to));
    case 'shares':
      return JSON.stringify(sharesSet(from)) !== JSON.stringify(sharesSet(to));
    default: {
      const a = (from as unknown as Record<string, unknown>)[key] ?? null;
      const b = (to as unknown as Record<string, unknown>)[key] ?? null;
      return a !== b;
    }
  }
}

export interface FieldDiff extends VersionFieldMeta {
  changed: boolean;
  from: unknown;
  to: unknown;
  /** 哪一侧的快照不支持该字段（旧版本可能没有人物/授权）。 */
  unsupported: Array<'from' | 'to'>;
}

export interface SnapshotDiff {
  fields: FieldDiff[];
  changedFields: VersionFieldKey[];
  changedCount: number;
}

/** 逐字段对比两份快照；字段顺序与分组由 VERSION_FIELDS 固定，前后端展示一致。 */
export function diffSnapshots(from: NormalizedSnapshot, to: NormalizedSnapshot): SnapshotDiff {
  const fields: FieldDiff[] = VERSION_FIELDS.map((meta) => {
    const unsupported: Array<'from' | 'to'> = [];
    let changed = false;
    if (meta.rollbackable) {
      if (from.unsupported.includes(meta.key as VersionFieldKey)) unsupported.push('from');
      if (to.unsupported.includes(meta.key as VersionFieldKey)) unsupported.push('to');
    }
    // 两侧都能比较（或都不支持）才判定；一侧缺失时直接视为「无法比较/有差异」
    if (unsupported.length === 0) {
      changed = isChanged(from.value, to.value, meta.key);
    } else if (unsupported.length === 1) {
      changed = true;
    }
    return {
      ...meta,
      changed,
      unsupported,
      from: (from.value as unknown as Record<string, unknown>)[meta.key] ?? null,
      to: (to.value as unknown as Record<string, unknown>)[meta.key] ?? null,
    };
  });

  // 只有两侧都支持、确实变化、且允许回滚的字段才能进入勾选列表
  const changedFields = fields
    .filter((f) => f.changed && f.rollbackable && f.unsupported.length === 0)
    .map((f) => f.key as VersionFieldKey);

  return { fields, changedFields, changedCount: changedFields.length };
}

export const revertVersionSchema = z.object({
  fields: z.array(z.enum(VERSION_FIELD_KEYS)).min(1, '请至少勾选一个要回滚的字段').max(40),
});
export type RevertVersionInput = z.infer<typeof revertVersionSchema>;

/**
 * 按勾选字段，把目标快照叠加到当前快照上：勾选的取目标值，未勾选的保留当前值。
 * 获得时间类字段（日期/精度/说法/说明）只严格覆盖勾选项；调用方负责用合并后的
 * 整组值重算 sortAt，避免日期与精度错配。
 * 调用方需先用 normalizeSnapshot 保证两侧结构一致、fields 合法。
 */
export function pickSnapshotFields(
  current: VersionSnapshot,
  target: VersionSnapshot,
  fields: readonly string[],
): VersionSnapshot {
  const out: VersionSnapshot = { ...current, people: current.people ?? [], shares: current.shares ?? [] };
  for (const key of fields) {
    if (!VERSION_FIELD_KEYS.includes(key as VersionFieldKey)) continue;
    (out as unknown as Record<string, unknown>)[key] =
      (target as unknown as Record<string, unknown>)[key] ?? null;
  }
  // 关联集合缺省为空数组而不是 undefined
  if (fields.includes('people')) out.people = target.people ?? [];
  if (fields.includes('shares')) out.shares = target.shares ?? [];
  return out;
}

export const versionDiffQuerySchema = z.object({
  /** 对比基准版本：current（默认，对比当前条目）或版本记录 ID。 */
  base: z.string().max(40).optional(),
});
