import type { FamilyRole, Item, ItemPerson, ItemShare, Prisma } from '@prisma/client';
import { sortAt as computeSortAt, timelineGroupKey, type Category, type Precision, type Visibility } from '@heirloom/shared';
import {
  diffSnapshots,
  normalizeSnapshot,
  pickSnapshotFields,
  SNAPSHOT_FORMAT,
  VERSION_FIELD_KEYS,
  type NormalizedSnapshot,
  type RevertVersionInput,
  type VersionFieldKey,
  type VersionSnapshot,
} from '@heirloom/shared';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { cleanStory } from '../utils/sanitize';
import { toPage, type CursorPage } from '../utils/pagination';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toItemDto } from '../serializers';
import { itemVisibilityWhere } from './visibility';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface ItemInput {
  title?: string;
  category?: Category;
  acquiredAt?: string | null;
  acquiredPrecision?: Precision;
  acquiredLabel?: string | null;
  acquiredNote?: string | null;
  placeText?: string | null;
  placeCity?: string | null;
  placeProvince?: string | null;
  placeCountry?: string | null;
  placeLat?: number | null;
  placeLng?: number | null;
  storyHtml?: string | null;
  condition?: string | null;
  storageLocation?: string | null;
  tags?: string[];
  visibility?: Visibility;
  people?: { personId: string; role: string }[];
  sharedWith?: { userId: string; canEdit: boolean }[];
}

export interface ListQuery {
  q?: string;
  category?: Category;
  personId?: string;
  status?: 'draft' | 'published' | 'archived';
  visibility?: Visibility;
  from?: string;
  to?: string;
  tag?: string;
  sort: 'time' | 'updated' | 'created';
  limit: number;
  cursor?: string;
}

const LIST_INCLUDE = {
  media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  people: { include: { person: true } },
  _count: { select: { notes: true, media: true } },
} satisfies Prisma.ItemInclude;

/** 构造版本快照需要的关联行：人物关系与成员授权（ItemPerson/ItemShare 无软删除）。 */
export const SNAPSHOT_INCLUDE = {
  people: { select: { personId: true, role: true } },
  shares: { select: { userId: true, canEdit: true } },
} satisfies Prisma.ItemInclude;

type ItemWithSnapshotRels = Item & {
  people: Pick<ItemPerson, 'personId' | 'role'>[];
  shares: Pick<ItemShare, 'userId' | 'canEdit'>[];
};

export async function listItems(
  userId: string,
  ctx: FamilyContext,
  query: ListQuery,
): Promise<CursorPage<ReturnType<typeof toItemDto>>> {
  const and: Prisma.ItemWhereInput[] = [
    { familyId: ctx.familyId },
    { deletedAt: null },
    { status: query.status ? query.status : { not: 'trashed' } },
    itemVisibilityWhere(userId, ctx.role),
  ];

  if (query.category) and.push({ category: query.category });
  if (query.visibility) and.push({ visibility: query.visibility });
  if (query.tag) and.push({ tags: { has: query.tag } });
  if (query.personId) and.push({ people: { some: { personId: query.personId } } });
  if (query.from || query.to) {
    and.push({
      sortAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      },
    });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { storyText: contains },
        { placeText: contains },
        { storageLocation: contains },
        { acquiredLabel: contains },
        { tags: { has: query.q } },
        { people: { some: { person: { name: contains } } } },
        { media: { some: { deletedAt: null, transcript: contains } } },
      ],
    });
  }

  const orderBy: Prisma.ItemOrderByWithRelationInput[] =
    query.sort === 'updated'
      ? [{ updatedAt: 'desc' }, { id: 'desc' }]
      : query.sort === 'created'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ sortAt: 'desc' }, { id: 'desc' }];

  const rows = await prisma.item.findMany({
    where: { AND: and },
    include: LIST_INCLUDE,
    orderBy,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = toPage(rows, query.limit);
  return { items: page.items.map((row) => toItemDto(row, ctx.familyId)), nextCursor: page.nextCursor };
}

export async function getItemDetail(userId: string, ctx: FamilyContext, itemId: string) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const full = await prisma.item.findUniqueOrThrow({
    where: { id: item.id },
    include: {
      ...LIST_INCLUDE,
      creator: { select: { id: true, displayName: true, avatarColor: true } },
      notes: {
        where: { status: { not: 'rejected' } },
        include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
        orderBy: { createdAt: 'asc' },
      },
      shares: { include: { item: false } },
      _count: { select: { notes: true, media: true, versions: true } },
    },
  });
  const shares = await prisma.itemShare.findMany({ where: { itemId }, include: { item: false } });
  const sharedUsers = shares.length
    ? await prisma.familyMember.findMany({
        where: { familyId: ctx.familyId, userId: { in: shares.map((s) => s.userId) } },
        include: { user: { select: { id: true, displayName: true, avatarColor: true } } },
      })
    : [];

  return {
    ...toItemDto(full, ctx.familyId),
    creator: full.creator,
    notes: full.notes.map((n) => ({
      id: n.id,
      type: n.type,
      body: n.body,
      status: n.status,
      rejectReason: n.rejectReason,
      createdAt: n.createdAt.toISOString(),
      decidedAt: n.decidedAt?.toISOString() ?? null,
      author: n.author,
    })),
    sharedWith: sharedUsers.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      avatarColor: m.user.avatarColor,
      canEdit: shares.find((s) => s.userId === m.userId)?.canEdit ?? false,
    })),
    versionCount: full._count.versions,
    permissions: {
      canEdit: access.canEdit,
      canDelete: access.canDelete,
      canComment: access.canComment,
      canManageMedia: access.canManageMedia,
    },
  };
}

async function assertPeopleBelongToFamily(
  familyId: string,
  personIds: string[],
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (personIds.length === 0) return;
  const uniqueIds = [...new Set(personIds)];
  const found = await db.person.count({
    where: { familyId, id: { in: uniqueIds }, deletedAt: null },
  });
  if (found !== uniqueIds.length) throw badRequest('存在不属于该家庭的来源人物');
}

async function assertUsersBelongToFamily(
  familyId: string,
  userIds: string[],
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (userIds.length === 0) return;
  const uniqueIds = [...new Set(userIds)];
  const found = await db.familyMember.count({
    where: { familyId, userId: { in: uniqueIds }, status: 'active' },
  });
  if (found !== uniqueIds.length) throw badRequest('存在不属于该家庭的成员');
}

export async function createItem(userId: string, ctx: FamilyContext, input: ItemInput, meta: ActorMeta) {
  if (!input.title || !input.category) throw badRequest('标题与分类为必填项');
  const story = cleanStory(input.storyHtml);
  const acquiredAt = input.acquiredAt ? new Date(input.acquiredAt) : null;
  const precision = input.acquiredPrecision ?? 'unknown';
  const sortValue = computeSortAt({ acquiredAt, acquiredPrecision: precision }, new Date());

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  return prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        familyId: ctx.familyId,
        title: input.title!,
        category: input.category!,
        status: 'draft',
        visibility: input.visibility ?? family.defaultVisibility,
        acquiredAt,
        acquiredPrecision: precision,
        acquiredLabel: input.acquiredLabel ?? null,
        acquiredNote: input.acquiredNote ?? null,
        placeText: input.placeText ?? null,
        placeCity: input.placeCity ?? null,
        placeProvince: input.placeProvince ?? null,
        placeCountry: input.placeCountry ?? null,
        placeLat: input.placeLat ?? null,
        placeLng: input.placeLng ?? null,
        storyHtml: story.html,
        storyText: story.text || null,
        condition: input.condition ?? null,
        storageLocation: input.storageLocation ?? null,
        tags: input.tags ?? [],
        sortAt: sortValue,
        createdBy: userId,
        people: input.people?.length
          ? { create: input.people.map((p) => ({ personId: p.personId, role: p.role as never })) }
          : undefined,
        shares: input.sharedWith?.length
          ? { create: input.sharedWith.map((s) => ({ userId: s.userId, canEdit: s.canEdit })) }
          : undefined,
      },
    });

    const snapshotRow = await tx.item.findUniqueOrThrow({ where: { id: created.id }, include: SNAPSHOT_INCLUDE });
    await tx.itemVersion.create({
      data: { itemId: created.id, version: 1, snapshot: toVersionSnapshot(snapshotRow), createdBy: userId },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.create',
        targetType: 'item',
        targetId: created.id,
        diff: { title: created.title, category: created.category } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: created.id }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

export function toVersionSnapshot(item: ItemWithSnapshotRels): Prisma.InputJsonValue {
  return {
    format: SNAPSHOT_FORMAT,
    title: item.title,
    category: item.category,
    status: item.status,
    visibility: item.visibility,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    acquiredNote: item.acquiredNote,
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    placeCountry: item.placeCountry,
    placeLat: item.placeLat ? Number(item.placeLat) : null,
    placeLng: item.placeLng ? Number(item.placeLng) : null,
    storyHtml: item.storyHtml,
    storyText: item.storyText,
    condition: item.condition,
    storageLocation: item.storageLocation,
    tags: item.tags,
    coverMediaId: item.coverMediaId,
    people: item.people.map((p) => ({ personId: p.personId, role: p.role })),
    shares: item.shares.map((s) => ({ userId: s.userId, canEdit: s.canEdit })),
  } as unknown as Prisma.InputJsonValue;
}

export async function updateItem(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: ItemInput,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  if (item.status === 'trashed') throw conflict('回收站中的条目不可编辑，请先恢复');

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  const story = input.storyHtml === undefined ? { html: null as string | null, text: '' } : cleanStory(input.storyHtml);
  const nextAcquiredAt =
    input.acquiredAt === undefined ? item.acquiredAt : input.acquiredAt === null ? null : new Date(input.acquiredAt);
  const nextPrecision = input.acquiredPrecision ?? item.acquiredPrecision;
  const nextSortAt =
    input.acquiredAt === undefined && input.acquiredPrecision === undefined
      ? item.sortAt
      : computeSortAt({ acquiredAt: nextAcquiredAt, acquiredPrecision: nextPrecision }, new Date());

  return prisma.$transaction(async (tx) => {
    // 锁住条目行：并发编辑/回滚在此排队，版本号递增不会撞唯一约束
    await tx.$queryRaw`SELECT id FROM items WHERE id = ${itemId} FOR UPDATE`;

    // 先在事务内拍「改前」快照，保证审计/版本与实际写入看到同一行
    const beforeRow = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: SNAPSHOT_INCLUDE });

    await tx.item.update({
      where: { id: itemId },
      data: {
        title: input.title ?? undefined,
        category: input.category ?? undefined,
        visibility: input.visibility ?? undefined,
        acquiredAt: input.acquiredAt === undefined ? undefined : nextAcquiredAt,
        acquiredPrecision: input.acquiredPrecision ?? undefined,
        acquiredLabel: input.acquiredLabel === undefined ? undefined : input.acquiredLabel,
        acquiredNote: input.acquiredNote === undefined ? undefined : input.acquiredNote,
        placeText: input.placeText === undefined ? undefined : input.placeText,
        placeCity: input.placeCity === undefined ? undefined : input.placeCity,
        placeProvince: input.placeProvince === undefined ? undefined : input.placeProvince,
        placeCountry: input.placeCountry === undefined ? undefined : input.placeCountry,
        placeLat: input.placeLat === undefined ? undefined : input.placeLat,
        placeLng: input.placeLng === undefined ? undefined : input.placeLng,
        storyHtml: input.storyHtml === undefined ? undefined : story.html,
        storyText: input.storyHtml === undefined ? undefined : story.text || null,
        condition: input.condition === undefined ? undefined : input.condition,
        storageLocation: input.storageLocation === undefined ? undefined : input.storageLocation,
        tags: input.tags ?? undefined,
        sortAt: nextSortAt,
      },
    });

    if (input.people) {
      await tx.itemPerson.deleteMany({ where: { itemId } });
      if (input.people.length) {
        await tx.itemPerson.createMany({
          data: input.people.map((p) => ({ itemId, personId: p.personId, role: p.role as never })),
        });
      }
    }
    if (input.sharedWith) {
      await tx.itemShare.deleteMany({ where: { itemId } });
      if (input.sharedWith.length) {
        await tx.itemShare.createMany({
          data: input.sharedWith.map((s) => ({ itemId, userId: s.userId, canEdit: s.canEdit })),
        });
      }
    }

    const afterRow = await tx.item.findUniqueOrThrow({
      where: { id: itemId },
      include: SNAPSHOT_INCLUDE,
    });
    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(afterRow),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.update',
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf(toVersionSnapshot(beforeRow), toVersionSnapshot(afterRow)),
        ...meta,
      },
      tx,
    );

    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

type StatusAction = 'publish' | 'archive' | 'restore' | 'trash';

const STATUS_TARGET: Record<StatusAction, Item['status']> = {
  publish: 'published',
  archive: 'archived',
  restore: 'published',
  trash: 'trashed',
};

export async function changeStatus(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  action: StatusAction,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);

  if (action === 'trash') {
    if (!access.canDelete) throw forbidden();
  } else if (action === 'restore') {
    if (!access.canDelete) throw forbidden();
  } else if (!access.canEdit) {
    throw forbidden();
  }

  if (action === 'publish') {
    const mediaCount = await prisma.itemMedia.count({ where: { itemId, deletedAt: null } });
    const hasClue = Boolean(item.acquiredAt || item.acquiredLabel || item.placeText || item.storyText);
    if (!hasClue && mediaCount === 0) {
      throw badRequest('发布前请至少补充一条线索：获得时间、地点、故事或一张图片');
    }
  }

  const target = STATUS_TARGET[action];
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.item.update({
      where: { id: itemId },
      data: { status: target, deletedAt: action === 'trash' ? new Date() : null },
      include: LIST_INCLUDE,
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: `item.${action}` as string,
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf({ status: item.status }, { status: target }),
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toItemDto(updated, ctx.familyId);
}

/** 彻底删除：先删库，再清理磁盘文件；审计保留（合规与追溯需要）。 */
export async function purgeItem(userId: string, ctx: FamilyContext, itemId: string, meta: ActorMeta) {
  const item = await prisma.item.findFirst({ where: { id: itemId, familyId: ctx.familyId } });
  if (!item) throw notFound('条目不存在');
  if (item.status !== 'trashed') throw conflict('只有回收站中的条目才能彻底删除');

  const media = await prisma.itemMedia.findMany({ where: { itemId } });
  await prisma.$transaction(async (tx) => {
    await tx.item.delete({ where: { id: itemId } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.purge',
        targetType: 'item',
        targetId: itemId,
        diff: { title: item.title, mediaCount: media.length } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
  return media.flatMap((m) => [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey].filter(Boolean) as string[]);
}

export async function listTrash(ctx: FamilyContext, limit = 100) {
  const rows = await prisma.item.findMany({
    where: { familyId: ctx.familyId, status: 'trashed' },
    include: LIST_INCLUDE,
    orderBy: { deletedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => toItemDto(r, ctx.familyId));
}

export interface VersionSummary {
  id: string;
  version: number;
  format: number;
  createdAt: string;
  createdBy: string;
  snapshot: unknown;
  unsupported: VersionFieldKey[];
}

export async function listVersions(ctx: FamilyContext, itemId: string): Promise<VersionSummary[]> {
  const versions = await prisma.itemVersion.findMany({
    where: { itemId, item: { familyId: ctx.familyId } },
    orderBy: { version: 'desc' },
    take: 50,
  });
  return versions.map((v) => {
    const norm = normalizeSnapshot(v.snapshot);
    return {
      id: v.id,
      version: v.version,
      format: norm.format,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      snapshot: v.snapshot,
      unsupported: norm.unsupported,
    };
  });
}

async function loadVersionRow(ctx: FamilyContext, itemId: string, versionId: string) {
  const row = await prisma.itemVersion.findFirst({
    where: { id: versionId, itemId, item: { familyId: ctx.familyId } },
  });
  if (!row) throw notFound('版本不存在');
  return row;
}

async function currentSnapshot(itemId: string): Promise<NormalizedSnapshot> {
  const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId }, include: SNAPSHOT_INCLUDE });
  return normalizeSnapshot(toVersionSnapshot(row));
}

export interface ResolvedRefs {
  people: Record<string, { name: string; deleted: boolean }>;
  users: Record<string, { displayName: string; disabled: boolean }>;
  media: Record<string, { originalName: string; deleted: boolean; kind: string }>;
}

/** 为差异展示补人名/成员名/文件名：引用的人或媒体被删除时给出明确标记，而不是裸 ID。 */
async function resolveRefs(ctx: FamilyContext, a: NormalizedSnapshot, b: NormalizedSnapshot): Promise<ResolvedRefs> {
  const personIds = new Set<string>();
  const userIds = new Set<string>();
  const mediaIds = new Set<string>();
  for (const snap of [a, b]) {
    for (const p of snap.value.people ?? []) personIds.add(p.personId);
    for (const s of snap.value.shares ?? []) userIds.add(s.userId);
    if (snap.value.coverMediaId) mediaIds.add(snap.value.coverMediaId);
  }

  const [people, users, media] = await Promise.all([
    personIds.size
      ? prisma.person.findMany({ where: { familyId: ctx.familyId, id: { in: [...personIds] } }, select: { id: true, name: true, deletedAt: true } })
      : [],
    userIds.size
      ? prisma.user.findMany({
          where: { memberships: { some: { familyId: ctx.familyId, userId: { in: [...userIds] } } } },
          select: { id: true, displayName: true, status: true, memberships: { select: { status: true }, where: { familyId: ctx.familyId } } },
        })
      : [],
    mediaIds.size
      ? prisma.itemMedia.findMany({
          where: { id: { in: [...mediaIds] }, item: { familyId: ctx.familyId } },
          select: { id: true, originalName: true, deletedAt: true, kind: true },
        })
      : [],
  ]);

  const peopleMap: ResolvedRefs['people'] = {};
  for (const p of people) peopleMap[p.id] = { name: p.name, deleted: Boolean(p.deletedAt) };
  const usersMap: ResolvedRefs['users'] = {};
  for (const u of users) {
    usersMap[u.id] = {
      displayName: u.displayName,
      disabled: u.status === 'disabled' || u.memberships.some((m) => m.status === 'disabled'),
    };
  }
  const mediaMap: ResolvedRefs['media'] = {};
  for (const m of media) mediaMap[m.id] = { originalName: m.originalName, deleted: Boolean(m.deletedAt), kind: m.kind };
  return { people: peopleMap, users: usersMap, media: mediaMap };
}

/**
 * 逐字段差异对比。
 * GET /items/:id/versions/:versionId/diff?base=current|<versionId>
 * 默认基准为「当前条目」；也可传另一个版本记录 ID 做版本间对比。
 */
export async function diffVersion(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  versionId: string,
  base: string | undefined,
) {
  await itemWithAccess(userId, ctx, itemId);
  const targetRow = await loadVersionRow(ctx, itemId, versionId);
  const target = normalizeSnapshot(targetRow.snapshot);

  let from: NormalizedSnapshot;
  let fromVersion: { id: string | null; version: number | null };
  if (!base || base === 'current') {
    from = await currentSnapshot(itemId);
    fromVersion = { id: null, version: null };
  } else {
    const baseRow = await loadVersionRow(ctx, itemId, base);
    from = normalizeSnapshot(baseRow.snapshot);
    fromVersion = { id: baseRow.id, version: baseRow.version };
  }

  // 语义：from = 当前/基准（旧），to = 被查看的版本。前端默认场景「当前 → 历史」，
  // 回滚按钮作用于被查看版本，因此保证 to 始终是 target。
  const refs = await resolveRefs(ctx, from, target);
  return {
    fromVersion,
    toVersion: { id: targetRow.id, version: targetRow.version },
    diff: diffSnapshots(from, target),
    refs,
  };
}

function parseAcquired(snap: VersionSnapshot): { acquiredAt: Date | null; precision: Precision } {
  const acquiredAt = snap.acquiredAt ? new Date(snap.acquiredAt) : null;
  const precision = (snap.acquiredPrecision as Precision | null) ?? 'unknown';
  return { acquiredAt, precision };
}

/**
 * 选择性回滚：只覆盖勾选字段，未勾选字段保持现状。
 * 人物、封面、授权与条目标量在同一个事务内写入：
 * - 人物必须仍属于该家庭且未删除
 * - 封面必须仍是该条目下未删除的图片
 * - 被授权成员必须仍是该家庭的活跃成员
 * 任一校验失败整体回滚，不会出现「人物回滚了但授权没回滚」的中间态。
 */
export async function revertVersion(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  versionId: string,
  input: RevertVersionInput,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  if (item.status === 'trashed') throw conflict('回收站中的条目不可回滚，请先恢复');

  const version = await loadVersionRow(ctx, itemId, versionId);
  const target = normalizeSnapshot(version.snapshot);

  const fields = [...new Set(input.fields)];
  const invalid = fields.filter((f) => !VERSION_FIELD_KEYS.includes(f));
  if (invalid.length) throw badRequest(`不支持回滚的字段：${invalid.join(', ')}`);
  const unsupported = fields.filter((f) => target.unsupported.includes(f));
  if (unsupported.length) throw badRequest(`该历史版本未保存这些字段，无法回滚：${unsupported.join(', ')}`);
  const snap = target.value;

  const wants = (f: VersionFieldKey): boolean => fields.includes(f);
  const acquiredTouched =
    wants('acquiredAt') || wants('acquiredPrecision') || wants('acquiredLabel') || wants('acquiredNote');

  return prisma.$transaction(async (tx) => {
    // 锁住条目行：并发的回滚/编辑在此排队，保证后续校验、写入与版本号递增看到一致状态
    await tx.$queryRaw`SELECT id FROM items WHERE id = ${itemId} FOR UPDATE`;

    // ---- 引用完整性校验必须在事务内：以同一事务看到的数据库事实为准，----
    // ---- 避免「校验通过后、提交前人物/成员/媒体被删」造成悬空引用。 ----
    if (wants('people')) {
      const people = snap.people ?? [];
      await assertPeopleBelongToFamily(
        ctx.familyId,
        people.map((p) => p.personId),
        tx,
      );
    }
    if (wants('shares')) {
      const shares = snap.shares ?? [];
      await assertUsersBelongToFamily(
        ctx.familyId,
        shares.map((s) => s.userId),
        tx,
      );
    }
    if (wants('coverMediaId') && snap.coverMediaId) {
      const media = await tx.itemMedia.findFirst({
        where: { id: snap.coverMediaId, itemId, deletedAt: null },
        select: { kind: true },
      });
      if (!media) throw badRequest('该版本的封面图片已被删除，无法恢复封面（可回滚后重新选择封面）');
      if (media.kind !== 'image') throw badRequest('封面必须是一张图片');
    }

    const beforeRow = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: SNAPSHOT_INCLUDE });
    const currentSnap = normalizeSnapshot(toVersionSnapshot(beforeRow)).value;
    // 合并出回滚后的目标形态：勾选字段取历史值，其余保持现状
    const picked = pickSnapshotFields(currentSnap, snap, fields);
    if (!picked.title) throw badRequest('标题不能为空');
    if (!picked.category) throw badRequest('该历史版本的分类字段已损坏，无法回滚');

    // 故事 HTML 仍需再过一遍白名单净化（历史快照只信任存储时已净化的内容，回滚时防御性重洗）
    const story = cleanStory(picked.storyHtml);
    const { acquiredAt: nextAcquiredAt, precision: nextPrecision } = parseAcquired(picked);

    await tx.item.update({
      where: { id: itemId },
      data: {
        title: picked.title,
        category: picked.category,
        visibility: picked.visibility ?? currentSnap.visibility ?? item.visibility,
        acquiredAt: nextAcquiredAt,
        acquiredPrecision: nextPrecision,
        acquiredLabel: acquiredTouched ? picked.acquiredLabel : undefined,
        acquiredNote: acquiredTouched ? picked.acquiredNote : undefined,
        placeText: picked.placeText,
        placeCity: picked.placeCity,
        placeProvince: picked.placeProvince,
        placeCountry: picked.placeCountry,
        placeLat: picked.placeLat,
        placeLng: picked.placeLng,
        storyHtml: wants('storyHtml') ? story.html : undefined,
        storyText: wants('storyHtml') ? story.text || null : undefined,
        condition: picked.condition,
        storageLocation: picked.storageLocation,
        tags: picked.tags,
        coverMediaId: wants('coverMediaId') ? picked.coverMediaId : undefined,
        // 只要回滚涉及获得时间任一字段，就用合并后的整组值重算排序时间
        sortAt: acquiredTouched
          ? computeSortAt({ acquiredAt: nextAcquiredAt, acquiredPrecision: nextPrecision }, new Date())
          : undefined,
      },
    });

    // 人物：整体替换为快照中的关系集合（人物角色与快照一致）
    if (wants('people')) {
      const people = picked.people ?? [];
      await tx.itemPerson.deleteMany({ where: { itemId } });
      if (people.length) {
        await tx.itemPerson.createMany({
          data: people.map((p) => ({ itemId, personId: p.personId, role: p.role })),
        });
      }
    }

    // 授权：整体替换为快照中的成员授权
    if (wants('shares')) {
      const shares = picked.shares ?? [];
      await tx.itemShare.deleteMany({ where: { itemId } });
      if (shares.length) {
        await tx.itemShare.createMany({
          data: shares.map((s) => ({ itemId, userId: s.userId, canEdit: s.canEdit })),
        });
      }
    }

    const afterRow = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: SNAPSHOT_INCLUDE });
    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(afterRow),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.revert',
        targetType: 'item',
        targetId: itemId,
        diff: {
          revertedTo: version.version,
          fields,
          before: toVersionSnapshot(beforeRow),
          after: toVersionSnapshot(afterRow),
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );

    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

export interface TimelineGroup {
  key: string;
  label: string;
  count: number;
  items: ReturnType<typeof toItemDto>[];
}

export async function timeline(userId: string, ctx: FamilyContext, limitGroups = 20): Promise<TimelineGroup[]> {
  const rows = await prisma.item.findMany({
    where: {
      AND: [
        { familyId: ctx.familyId },
        { deletedAt: null },
        { status: { in: ['published', 'archived'] } },
        itemVisibilityWhere(userId, ctx.role),
      ],
    },
    include: LIST_INCLUDE,
    orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
    take: 2000,
  });

  const groups = new Map<string, TimelineGroup>();
  for (const row of rows) {
    const key = timelineGroupKey(
      { acquiredAt: row.acquiredAt, acquiredPrecision: row.acquiredPrecision, acquiredLabel: row.acquiredLabel },
      row.createdAt,
    );
    const label = key === 'unknown' ? '时间不详' : key.endsWith('s') ? `${key.slice(0, -1)} 年代` : `${key} 年`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label, count: 0, items: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.items.length < 12) group.items.push(toItemDto(row, ctx.familyId));
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return b.key.localeCompare(a.key);
    })
    .slice(0, limitGroups);
}
