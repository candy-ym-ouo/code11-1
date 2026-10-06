import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Modal, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  CATEGORY_LABELS,
  PERSON_ROLE_LABELS,
  PRECISION_LABELS,
  STATUS_LABELS,
  VISIBILITY_LABELS,
} from '../../lib/constants';
import { mediaSrc } from '../../lib/media';
import type { ItemDetail } from '../../api/types';
import {
  VERSION_FIELD_GROUPS,
  type DiffResponse,
  type FieldDiff,
  type VersionFieldKey,
  type VersionPersonRef,
  type VersionShareRef,
  type VersionSummary,
} from './versionMeta';

const EMPTY = '（空）';

function htmlToText(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ScalarValue({ field, value }: { field: FieldDiff; value: unknown }) {
  if (field.kind === 'tags') {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    if (!tags.length) return <span className="muted">{EMPTY}</span>;
    return (
      <span className="vdiff-tags">
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </span>
    );
  }
  if (field.key === 'category' && typeof value === 'string') return <>{CATEGORY_LABELS[value as keyof typeof CATEGORY_LABELS] ?? value}</>;
  if (field.key === 'visibility' && typeof value === 'string') return <>{VISIBILITY_LABELS[value as keyof typeof VISIBILITY_LABELS] ?? value}</>;
  if (field.key === 'status' && typeof value === 'string') return <>{STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? value}</>;
  if (field.key === 'acquiredPrecision' && typeof value === 'string')
    return <>{PRECISION_LABELS[value as keyof typeof PRECISION_LABELS] ?? value}</>;
  if (field.kind === 'date' && typeof value === 'string') return <>{formatDate(value)}</>;
  if (field.kind === 'longtext') {
    const text = field.key === 'storyHtml' ? htmlToText(value) : String(value ?? '');
    if (!text) return <span className="muted">{EMPTY}</span>;
    return <span className="vdiff-text">{text}</span>;
  }
  if (value === null || value === undefined || value === '') return <span className="muted">{EMPTY}</span>;
  return <>{String(value)}</>;
}

function PersonList({ value, refs }: { value: unknown; refs: DiffResponse['refs'] }) {
  const list = Array.isArray(value) ? (value as VersionPersonRef[]) : [];
  if (!list.length) return <span className="muted">{EMPTY}</span>;
  return (
    <ul className="vdiff-list">
      {list.map((p) => {
        const person = refs.people[p.personId];
        return (
          <li key={`${p.personId}-${p.role}`}>
            {person ? person.name : <span className="muted">已删除的人物</span>}
            {person?.deleted ? <span className="tag tag--muted">已删除</span> : null}
            <span className="muted">（{PERSON_ROLE_LABELS[p.role as keyof typeof PERSON_ROLE_LABELS] ?? p.role}）</span>
          </li>
        );
      })}
    </ul>
  );
}

function ShareList({ value, refs }: { value: unknown; refs: DiffResponse['refs'] }) {
  const list = Array.isArray(value) ? (value as VersionShareRef[]) : [];
  if (!list.length) return <span className="muted">{EMPTY}</span>;
  return (
    <ul className="vdiff-list">
      {list.map((s) => {
        const user = refs.users[s.userId];
        return (
          <li key={s.userId}>
            {user ? user.displayName : <span className="muted">已离开的成员</span>}
            {user?.disabled ? <span className="tag tag--muted">已停用</span> : null}
            <span className="muted">（{s.canEdit ? '可编辑' : '仅查看'}）</span>
          </li>
        );
      })}
    </ul>
  );
}

function CoverValue({
  value,
  refs,
  itemData,
}: {
  value: unknown;
  refs: DiffResponse['refs'];
  itemData: ItemDetail | undefined;
}) {
  if (typeof value !== 'string' || !value) return <span className="muted">{EMPTY}</span>;
  const info = refs.media[value];
  const currentMedia = itemData?.media.find((m) => m.id === value && m.kind === 'image');
  return (
    <span className="vdiff-cover">
      {currentMedia ? (
        <img className="vdiff-cover__img" src={mediaSrc(currentMedia.thumbUrl ?? currentMedia.rawUrl)} alt="" loading="lazy" />
      ) : null}
      <span>
        {info ? info.originalName : '该版本记录的封面图片'}
        {info?.deleted || !info ? <span className="tag tag--warn">已删除·不可恢复</span> : null}
      </span>
    </span>
  );
}

function ValueCell({
  field,
  value,
  refs,
  itemData,
}: {
  field: FieldDiff;
  value: unknown;
  refs: DiffResponse['refs'];
  itemData: ItemDetail | undefined;
}) {
  if (field.kind === 'people') return <PersonList value={value} refs={refs} />;
  if (field.kind === 'shares') return <ShareList value={value} refs={refs} />;
  if (field.kind === 'cover') return <CoverValue value={value} refs={refs} itemData={itemData} />;
  return <ScalarValue field={field} value={value} />;
}

export function VersionDialog({
  open,
  fid,
  itemId,
  canEdit,
  onClose,
}: {
  open: boolean;
  fid: string;
  itemId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [base, setBase] = useState<string>('current');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [checked, setChecked] = useState<Set<VersionFieldKey>>(new Set());

  const versions = useQuery({
    queryKey: ['versions', fid, itemId],
    queryFn: () => api.get<{ versions: VersionSummary[] }>(`/families/${fid}/items/${itemId}/versions`),
    enabled: open,
  });

  const list = versions.data?.versions ?? [];
  const activeId = selectedId ?? list[0]?.id ?? null;

  const diff = useQuery({
    queryKey: ['version-diff', fid, itemId, activeId, base],
    queryFn: () =>
      api.get<DiffResponse>(
        `/families/${fid}/items/${itemId}/versions/${activeId}/diff?base=${encodeURIComponent(base)}`,
      ),
    enabled: open && Boolean(activeId),
  });

  const itemData = queryClient.getQueryData<{ item: ItemDetail }>(['item', fid, itemId])?.item;

  const data = diff.data;
  const selectable = useMemo(
    () =>
      (data?.diff.fields ?? []).filter(
        (f) => f.changed && f.rollbackable && f.unsupported.length === 0,
      ) as FieldDiff[],
    [data],
  );

  const toggle = (key: VersionFieldKey) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setChecked(new Set(selectable.map((f) => f.key as VersionFieldKey)));
  const clearAll = () => setChecked(new Set());

  const revert = useMutation({
    mutationFn: (fields: VersionFieldKey[]) =>
      api.post(`/families/${fid}/items/${itemId}/versions/${activeId}/revert`, { fields }),
    onSuccess: async () => {
      push('已按勾选字段回滚（回滚本身也记为一个新版本）', 'success');
      setChecked(new Set());
      await queryClient.invalidateQueries({ queryKey: ['item', fid, itemId] });
      await queryClient.invalidateQueries({ queryKey: ['versions', fid, itemId] });
      await queryClient.invalidateQueries({ queryKey: ['items', fid] });
      await diff.refetch();
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '回滚失败', 'error'),
  });

  const doRevert = () => {
    const fields = [...checked];
    if (!fields.length) return;
    const names = fields
      .map((k) => data?.diff.fields.find((f) => f.key === k)?.label)
      .filter(Boolean)
      .join('、');
    if (!window.confirm(`确认将以下字段回滚到该历史版本？\n${names}\n\n未勾选的字段保持现状。`)) return;
    revert.mutate(fields);
  };

  const visibleGroups = VERSION_FIELD_GROUPS.map((g) => ({
    ...g,
    fields: (data?.diff.fields ?? []).filter(
      (f) => f.group === g.key && (showUnchanged || f.changed),
    ),
  })).filter((g) => g.fields.length > 0);

  return (
    <Modal
      open={open}
      title="历史版本与差异对比"
      className="modal--wide"
      onClose={onClose}
      footer={
        canEdit && data ? (
          <div className="vdiff-footer">
            <span className="muted">
              {checked.size > 0 ? `已选 ${checked.size} 个字段` : '勾选要回滚的字段，未勾选的保持现状'}
            </span>
            <div className="vdiff-footer__actions">
              <Button size="sm" variant="ghost" onClick={selectAll} disabled={!selectable.length}>
                全选差异
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll} disabled={!checked.size}>
                清空
              </Button>
              <Button size="sm" onClick={doRevert} loading={revert.isPending} disabled={!checked.size}>
                回滚勾选字段
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="vdiff-layout">
        <aside className="vdiff-sidebar">
          {versions.isLoading ? (
            <Spinner />
          ) : (
            <ul className="vdiff-versions">
              {list.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`vdiff-version${v.id === activeId ? ' vdiff-version--active' : ''}`}
                    onClick={() => {
                      setSelectedId(v.id);
                      setChecked(new Set());
                      if (base !== 'current' && base === v.id) setBase('current');
                    }}
                  >
                    <strong>第 {v.version} 版</strong>
                    <span className="vdiff-version__time">{formatDateTime(v.createdAt)}</span>
                    <span className="vdiff-version__title">{v.snapshot.title ?? '—'}</span>
                    {v.format < 2 ? <span className="tag tag--muted">旧快照</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="vdiff-panel">
          {!activeId ? (
            <Spinner />
          ) : diff.isLoading ? (
            <Spinner />
          ) : diff.isError || !data ? (
            <p className="muted">差异加载失败</p>
          ) : (
            <>
              <div className="vdiff-toolbar">
                <label className="vdiff-base">
                  对比基准：
                  <select
                    value={base}
                    onChange={(e) => {
                      setBase(e.target.value);
                      setChecked(new Set());
                    }}
                  >
                    <option value="current">当前条目</option>
                    {list
                      .filter((v) => v.id !== activeId)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          第 {v.version} 版
                        </option>
                      ))}
                  </select>
                </label>
                <label className="vdiff-showall">
                  <input
                    type="checkbox"
                    checked={showUnchanged}
                    onChange={(e) => setShowUnchanged(e.target.checked)}
                  />
                  显示未变化字段
                </label>
                <span className="muted">
                  {data.fromVersion.version === null
                    ? '当前条目'
                    : `第 ${data.fromVersion.version} 版`}{' '}
                  → 第 {data.toVersion.version} 版，{data.diff.changedCount} 个可回滚差异
                </span>
              </div>

              {data.diff.changedCount === 0 && !showUnchanged ? (
                <p className="muted">该版本与对比基准没有可回滚的差异。</p>
              ) : (
                visibleGroups.map((g) => (
                  <div key={g.key} className="vdiff-group">
                    <h4 className="vdiff-group__title">{g.label}</h4>
                    <table className="vdiff-table">
                      <tbody>
                        {g.fields.map((f) => {
                          const disabled =
                            !canEdit || !f.rollbackable || f.unsupported.length > 0 || !f.changed;
                          return (
                            <tr
                              key={f.key}
                              className={f.changed ? 'vdiff-row vdiff-row--changed' : 'vdiff-row'}
                            >
                              <td className="vdiff-cell--check">
                                {f.rollbackable ? (
                                  <input
                                    type="checkbox"
                                    aria-label={`回滚${f.label}`}
                                    checked={checked.has(f.key as VersionFieldKey)}
                                    disabled={disabled}
                                    onChange={() => toggle(f.key as VersionFieldKey)}
                                  />
                                ) : (
                                  <span className="muted" title="状态随发布/归档流程变化，不支持回滚">
                                    ·
                                  </span>
                                )}
                              </td>
                              <th className="vdiff-cell--label">{f.label}</th>
                              <td className="vdiff-cell--from">
                                <ValueCell
                                  field={f}
                                  value={f.from}
                                  refs={data.refs}
                                  itemData={itemData}
                                />
                              </td>
                              <td className="vdiff-arrow">→</td>
                              <td className="vdiff-cell--to">
                                <ValueCell
                                  field={f}
                                  value={f.to}
                                  refs={data.refs}
                                  itemData={itemData}
                                />
                              </td>
                              <td className="vdiff-cell--note">
                                {f.unsupported.length > 0 ? (
                                  <span className="tag tag--muted" title="该历史版本没有保存此字段，无法回滚">
                                    旧版本未记录
                                  </span>
                                ) : !f.rollbackable && f.changed ? (
                                  <span className="tag tag--muted">不可回滚</span>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
