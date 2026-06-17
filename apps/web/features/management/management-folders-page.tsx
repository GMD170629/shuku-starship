'use client';

import { Eye, Folder, FolderTree, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { ManagementNav } from './management-nav';

type WorkItem = {
  id: string;
  title: string;
  author?: string | null;
  seriesName?: string | null;
  workType: string;
  organizeStatus: string;
  updatedAt: string;
  sizeBytes: number;
  editionCount: number;
};

type FolderGroup = {
  name: string;
  count: number;
  sizeBytes: number;
  items: WorkItem[];
};

type SourceFolder = {
  id: string;
  name: string;
  rootPath: string;
  enabled: boolean;
  readable: boolean;
  writable: boolean;
  children: Array<{ name: string; path: string; type: string; sizeBytes: number }>;
};

type TreeNode = {
  name: string;
  path: string;
  type: string;
  children?: TreeNode[];
};

type FoldersPayload = {
  ok: boolean;
  data?: {
    logical: Record<'series' | 'authors' | 'formats' | 'sources', FolderGroup[]>;
    disk: { sources: SourceFolder[]; managed: { rootPath: string; tree: TreeNode } };
    works: WorkItem[];
  };
  error?: { message: string };
};

function formatBytes(value: number) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusTone(value: boolean): BadgeTone {
  return value ? 'green' : 'red';
}

function TreeView({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const children = node.children ?? [];
  return (
    <div>
      <div className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-slate-700" style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <Folder size={15} className={node.type === 'folder' ? 'text-blue-600' : 'text-slate-400'} />
        <span className="min-w-0 truncate">{node.name}</span>
      </div>
      {children.slice(0, depth > 2 ? 40 : 120).map((child) => <TreeView key={child.path} node={child} depth={depth + 1} />)}
      {children.length > (depth > 2 ? 40 : 120) ? <div className="px-2 py-1 text-xs text-slate-400" style={{ paddingLeft: `${24 + depth * 16}px` }}>还有 {children.length - (depth > 2 ? 40 : 120)} 项未展示</div> : null}
    </div>
  );
}

function WorkList({ items, onDelete }: { items: WorkItem[]; onDelete: (work: WorkItem) => void }) {
  return (
    <div className="mt-3 space-y-2">
      {items.map((work) => (
        <div key={work.id} className="flex flex-col gap-3 rounded-2xl bg-slate-50 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-950">{work.title}</div>
            <div className="mt-1 text-xs text-slate-500">{work.author || '未知作者'} · {work.workType} · {formatBytes(work.sizeBytes)}</div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link href={`/works/${work.id}`} className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Eye size={15} />打开</Link>
            <button type="button" onClick={() => onDelete(work)} className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100"><Trash2 size={15} />删除记录</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ManagementFoldersPage() {
  const [data, setData] = useState<FoldersPayload['data'] | null>(null);
  const [tab, setTab] = useState<'series' | 'sources' | 'authors' | 'formats' | 'disk'>('series');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/management/folders');
      const payload = (await response.json()) as FoldersPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '读取文件夹视图失败');
      setData(payload.data ?? null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取文件夹视图失败');
    } finally {
      setLoading(false);
    }
  }

  async function requestRescan() {
    setBusy('rescan');
    try {
      const response = await fetch('/api/import-tasks/rescan', { method: 'POST' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: { message: string } } | null;
      if (!payload?.ok) throw new Error(payload?.error?.message ?? '请求重新识别失败');
      toast.success('已请求重新识别监控文件夹');
    } catch (reason) {
      toast.error('请求重新识别失败', reason instanceof Error ? reason.message : '请稍后重试');
    } finally {
      setBusy('');
    }
  }

  async function deleteWork(work: WorkItem) {
    const typed = window.prompt(`删除书库记录，不删除来源文件。请输入作品名确认：${work.title}`);
    if (typed !== work.title) {
      toast.info('已取消删除');
      return;
    }
    setBusy(`delete:${work.id}`);
    try {
      const response = await fetch(`/api/works/${work.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { deletedFiles: number }; error?: { message: string } } | null;
      if (!payload?.ok) throw new Error(payload?.error?.message ?? '删除失败');
      toast.success(`已删除书库记录，移除派生文件 ${payload.data?.deletedFiles ?? 0} 个`);
      await load();
    } catch (reason) {
      toast.error('删除书库记录失败', reason instanceof Error ? reason.message : '请稍后重试');
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const groups = tab === 'disk' ? [] : (data?.logical[tab] ?? []);

  return (
    <div className="space-y-6">
      <PageTitle
        title="文件夹管理"
        desc="按逻辑组织和真实路径查看来源目录、引用文件与作品对象。"
        action={(
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={RefreshCw} loading={loading} loadingText="刷新中" onClick={() => void load()}>刷新</Button>
            <Button variant="secondary" icon={FolderTree} loading={busy === 'rescan'} loadingText="请求中" onClick={() => void requestRescan()}>重新识别</Button>
          </div>
        )}
      />
      <ManagementNav />
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="flex flex-wrap gap-2">
        {[
          ['series', '系列'],
          ['sources', '来源'],
          ['authors', '作者'],
          ['formats', '格式'],
          ['disk', '磁盘视图']
        ].map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key as typeof tab)} className={`min-h-10 rounded-2xl border px-3 text-sm font-medium ${tab === key ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
        ))}
      </div>
      {tab !== 'disk' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {groups.length === 0 && !loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无可展示的逻辑分组。</div> : null}
          {groups.map((group) => (
            <section key={group.name} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-slate-950">{group.name}</h2>
                  <div className="mt-1 text-sm text-slate-500">{group.count} 个作品 · {formatBytes(group.sizeBytes)}</div>
                </div>
                <Badge>{group.count}</Badge>
              </div>
              <WorkList items={group.items} onDelete={deleteWork} />
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="font-semibold text-slate-950">来源目录</div>
            <div className="mt-4 space-y-4">
              {(data?.disk.sources ?? []).length === 0 ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">尚未配置监控文件夹。</div> : null}
              {(data?.disk.sources ?? []).map((source) => (
                <div key={source.id} className="rounded-2xl bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-950">{source.name}</span>
                    <Badge tone={source.enabled ? 'green' : 'slate'}>{source.enabled ? '启用' : '停用'}</Badge>
                    <Badge>{source.enabled ? '启用' : '停用'}</Badge>
                    <Badge tone={statusTone(source.readable)}>可读</Badge>
                    <Badge tone={statusTone(source.writable)}>可写</Badge>
                  </div>
                  <div className="mt-2 break-words text-xs text-slate-500">{source.rootPath}</div>
                  <div className="mt-3 space-y-1">
                    {source.children.slice(0, 8).map((child) => (
                      <div key={child.path} className="flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span className="min-w-0 truncate">{child.type === 'folder' ? '目录' : '文件'} · {child.name}</span>
                        <span className="shrink-0">{formatBytes(child.sizeBytes)}</span>
                      </div>
                    ))}
                    {source.children.length > 8 ? <div className="text-xs text-slate-400">还有 {source.children.length - 8} 项</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="font-semibold text-slate-950">派生缓存</div>
            <div className="mt-1 break-words text-xs text-slate-500">{data?.disk.managed.rootPath}</div>
            <div className="mt-4 max-h-[620px] overflow-auto rounded-2xl bg-slate-50 p-3">
              {data?.disk.managed.tree ? <TreeView node={data.disk.managed.tree} /> : <div className="p-4 text-sm text-slate-500">暂无派生缓存。</div>}
            </div>
          </section>
        </div>
      )}
      {busy.startsWith('delete:') ? <div className="shuku-loading-panel p-4 text-sm" role="status" aria-live="polite">正在删除书库记录...</div> : null}
    </div>
  );
}
