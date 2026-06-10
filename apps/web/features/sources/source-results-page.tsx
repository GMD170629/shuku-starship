'use client';

import { Download, ExternalLink, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { useConfirm, useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';

type SourceView = { id: string; name: string; providerTypeLabel: string; enabled: boolean };
type SourceSearchRecordView = {
  id: string;
  sourceId: string;
  sourceName?: string;
  providerType: string;
  externalId: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  description: string | null;
  externalUrl: string | null;
  format: string | null;
  size: string | null;
  language: string | null;
  publishedAt: string | null;
  downloadAvailable: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type SourcesPayload = { ok: boolean; data?: { sources: SourceView[] }; error?: { message: string } };
type RecordsPayload = { ok: boolean; data?: { records: SourceSearchRecordView[]; record?: SourceSearchRecordView }; error?: { message: string } };
type CreateDownloadPayload = { ok: boolean; data?: { record: SourceSearchRecordView; alreadyQueued?: boolean }; error?: { message: string } };

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'new', label: '新结果' },
  { value: 'saved', label: '已保存' },
  { value: 'ignored', label: '已忽略' },
  { value: 'download_created', label: '已建下载' },
  { value: 'completed', label: '已导入' },
  { value: 'failed', label: '失败' }
];

const providerOptions = [
  { value: 'all', label: '全部类型' },
  { value: 'manual', label: '手动源' },
  { value: 'telegram', label: 'Z-Library Telegram Bot' },
  { value: 'pt_rss', label: 'PT RSS' },
  { value: 'comic_api', label: '漫画 API' },
  { value: 'rss', label: 'RSS' },
  { value: 'http', label: 'HTTP' }
];

function statusLabel(status: string) {
  return { new: '新结果', saved: '已保存', ignored: '已忽略', download_created: '已建下载', completed: '已导入', imported: '已导入', failed: '失败' }[status] ?? status;
}

function dateLabel(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function SourceResultsPage() {
  const [sources, setSources] = useState<SourceView[]>([]);
  const [records, setRecords] = useState<SourceSearchRecordView[]>([]);
  const [sourceId, setSourceId] = useState('all');
  const [status, setStatus] = useState('all');
  const [providerType, setProviderType] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const confirm = useConfirm();
  const toast = useToast();

  const sourceOptions = useMemo(() => [{ value: 'all', label: '全部源' }, ...sources.map((source) => ({ value: source.id, label: `${source.name} · ${source.providerTypeLabel}` }))], [sources]);

  useEffect(() => {
    fetch('/api/sources')
      .then((response) => response.json() as Promise<SourcesPayload>)
      .then((payload) => payload.ok && setSources(payload.data?.sources ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (sourceId !== 'all') params.set('sourceId', sourceId);
    if (status !== 'all') params.set('status', status);
    if (providerType !== 'all') params.set('providerType', providerType);
    if (keyword.trim()) params.set('keyword', keyword.trim());
    fetch(`/api/source-search-records?${params}`)
      .then((response) => response.json() as Promise<RecordsPayload>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取搜索结果失败');
        setRecords(payload.data?.records ?? []);
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取搜索结果失败'));
  }, [keyword, providerType, reloadKey, sourceId, status]);

  async function postAction(record: SourceSearchRecordView, action: 'save' | 'ignore') {
    setBusy(`${action}:${record.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/source-search-records/${record.id}/${action}`, { method: 'POST' });
      const payload = (await response.json()) as RecordsPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '操作失败');
      const successMessage = action === 'save' ? '结果已保存' : '结果已忽略';
      setMessage(successMessage);
      toast.success(successMessage);
      setReloadKey((key) => key + 1);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '操作失败';
      setError(nextError);
      toast.error('操作失败', nextError);
    } finally {
      setBusy('');
    }
  }

  async function deleteRecord(record: SourceSearchRecordView) {
    const confirmed = await confirm({
      title: '删除搜索结果',
      description: `删除搜索结果「${record.title}」？`,
      confirmLabel: '删除',
      tone: 'danger'
    });
    if (!confirmed) return;
    setBusy(`delete:${record.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/source-search-records/${record.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除失败');
      setMessage('搜索结果已删除');
      toast.success('搜索结果已删除');
      setReloadKey((key) => key + 1);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '删除失败';
      setError(nextError);
      toast.error('删除失败', nextError);
    } finally {
      setBusy('');
    }
  }

  async function createDownloadTask(record: SourceSearchRecordView) {
    if (!record.downloadAvailable) return;
    setBusy(`download:${record.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/source-search-records/${record.id}/create-download-task`, { method: 'POST' });
      const payload = (await response.json()) as CreateDownloadPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '创建下载任务失败');
      const successMessage = payload.data?.alreadyQueued ? '已在下载队列中' : '已加入下载队列';
      setMessage(successMessage);
      toast.success(successMessage);
      setReloadKey((key) => key + 1);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '创建下载任务失败';
      setError(nextError);
      toast.error('创建下载任务失败', nextError);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="搜索结果"
        desc="管理手动搜索保存的外部资源，可保存、忽略或为后续下载任务做准备。"
        action={<Link href="/sources/search" className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-blue-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-blue-700"><Search size={16} />去搜索</Link>}
      />
      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <Select value={sourceId} options={sourceOptions} onChange={setSourceId} ariaLabel="源筛选" size="sm" />
          <Select value={providerType} options={providerOptions} onChange={setProviderType} ariaLabel="类型筛选" size="sm" />
          <Select value={status} options={statusOptions} onChange={setStatus} ariaLabel="状态筛选" size="sm" />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、作者..." className="h-9 min-w-[220px] flex-1 rounded-2xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-300" />
        </div>
      </div>
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="space-y-3">
        {records.map((record) => (
          <article key={record.id} className={cn('rounded-[24px] border bg-white p-5 shadow-sm', record.status === 'ignored' ? 'border-slate-100 opacity-70' : 'border-slate-200')}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="break-words text-lg font-semibold text-slate-900">{record.title}</h2>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{statusLabel(record.status)}</span>
                  <span className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">{record.sourceName ?? record.providerType}</span>
                </div>
                {record.subtitle ? <div className="mt-1 text-sm text-slate-500">{record.subtitle}</div> : null}
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                  {record.author ? <span className="rounded-full bg-slate-100 px-2 py-1">作者 {record.author}</span> : null}
                  {record.format ? <span className="rounded-full bg-slate-100 px-2 py-1">格式 {record.format}</span> : null}
                  {record.size ? <span className="rounded-full bg-slate-100 px-2 py-1">大小 {record.size}</span> : null}
                  {record.language ? <span className="rounded-full bg-slate-100 px-2 py-1">语言 {record.language}</span> : null}
                  {record.publishedAt ? <span className="rounded-full bg-slate-100 px-2 py-1">发布 {dateLabel(record.publishedAt)}</span> : null}
                  <span className={cn('rounded-full px-2 py-1', record.downloadAvailable ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{record.downloadAvailable ? '可下载' : '不可下载'}</span>
                </div>
                {record.description ? <p className="mt-3 text-sm leading-6 text-slate-600">{record.description}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button loading={busy === `save:${record.id}`} loadingText="保存中" variant="secondary" onClick={() => void postAction(record, 'save')}>保存</Button>
                <Button loading={busy === `ignore:${record.id}`} loadingText="处理中" variant="secondary" onClick={() => void postAction(record, 'ignore')}>忽略</Button>
                {record.downloadAvailable && record.status !== 'download_created' ? <Button loading={busy === `download:${record.id}`} loadingText="加入中" variant="secondary" icon={Download} onClick={() => void createDownloadTask(record)}>加入下载队列</Button> : null}
                {record.status === 'download_created' ? <Link href="/downloads" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download size={15} />查看下载任务</Link> : null}
                {record.externalUrl ? <a href={record.externalUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><ExternalLink size={15} />外部链接</a> : null}
                <Button loading={busy === `delete:${record.id}`} loadingText="删除中" variant="danger" icon={Trash2} onClick={() => void deleteRecord(record)}>删除</Button>
              </div>
            </div>
          </article>
        ))}
        {records.length === 0 ? <div className="rounded-[24px] border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">暂无搜索结果记录。</div> : null}
      </div>
    </div>
  );
}
