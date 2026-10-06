/**
 * 前端本地的版本字段元数据（web 不依赖 @heirloom/shared，键名必须与后端
 * packages/shared/src/versions.ts 的 VERSION_FIELDS 保持一致）。
 */

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

export type VersionFieldKey =
  | 'title'
  | 'category'
  | 'visibility'
  | 'acquiredAt'
  | 'acquiredPrecision'
  | 'acquiredLabel'
  | 'acquiredNote'
  | 'placeText'
  | 'placeCity'
  | 'placeProvince'
  | 'placeCountry'
  | 'placeLat'
  | 'placeLng'
  | 'storyHtml'
  | 'condition'
  | 'storageLocation'
  | 'tags'
  | 'coverMediaId'
  | 'people'
  | 'shares';

export interface VersionFieldMeta {
  key: VersionFieldKey | 'status';
  label: string;
  group: VersionFieldGroup;
  kind: VersionFieldKind;
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

export interface VersionPersonRef {
  personId: string;
  role: string;
}

export interface VersionShareRef {
  userId: string;
  canEdit: boolean;
}

export interface FieldDiff extends VersionFieldMeta {
  changed: boolean;
  from: unknown;
  to: unknown;
  unsupported: Array<'from' | 'to'>;
}

export interface VersionRefs {
  people: Record<string, { name: string; deleted: boolean }>;
  users: Record<string, { displayName: string; disabled: boolean }>;
  media: Record<string, { originalName: string; deleted: boolean; kind: string }>;
}

export interface DiffResponse {
  fromVersion: { id: string | null; version: number | null };
  toVersion: { id: string; version: number };
  diff: { fields: FieldDiff[]; changedFields: VersionFieldKey[]; changedCount: number };
  refs: VersionRefs;
}

export interface VersionSummary {
  id: string;
  version: number;
  format: number;
  createdAt: string;
  createdBy: string;
  snapshot: { title?: string };
  unsupported: VersionFieldKey[];
}
