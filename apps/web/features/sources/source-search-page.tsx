'use client';

import { Download, ExternalLink, Search, Settings } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';

type SourceView = {
  id: string;
  name: string;
  kind: 'novel' | 'comic' | 'mixed' | 'metadata';
  kindLabel: string;
  providerType: string;
  providerTypeLabel: string;
  enabled: boolean;
  priority: number;
};

type SourceSearchResult = {
  sourceId: string;
  providerType: string;
  externalId: string;
  title: string;
  subtitle?: string;
  author?: string;
  description?: string;
  coverUrl?: string;
  externalUrl?: string;
  format?: string;
  size?: string;
  language?: string;
  publishedAt?: string;
  downloadAvailable: boolean;
  downloadMeta?: unknown;
  raw?: unknown;
};

type SourceSearchRecordView = { id: string; externalId: string; status: string };
type SourcesPayload = { ok: boolean; data?: { sources: SourceView[] }; error?: { message: string } };
type SearchPayload = { ok: boolean; data?: { results: SourceSearchResult[]; records?: SourceSearchRecordView[] }; error?: { message: string } };
type CreateDownloadPayload = { ok: boolean; data?: { record: SourceSearchRecordView; alreadyQueued?: boolean }; error?: { message: string } };

const kindOptions = [
  { value: 'mixed', label: '混合' },
  { value: 'novel', label: '小说' },
  { value: 'comic', label: '漫画' }
];

export function SourceSearchPage() {
  const searchParams = useSearchParams();
  const urlKeyword = searchParams.get('keyword')?.trim() ?? '';
  const shouldAutoSearch = searchParams.get('auto') === '1';
  const [sources, setSources] = useState<SourceView[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [kind, setKind] = useState<'novel' | 'comic' | 'mixed'>('mixed');
  const [results, setResults] = useState<SourceSearchResult[]>([]);
  const [records, setRecords] = useState<SourceSearchRecordView[]>([]);
  const [saveResults, setSaveResults] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const lastAutoSearchRef = useRef('');

  const selectedSource = useMemo(() => sources.find((source) => source.id === sourceId) ?? null, [sourceId, sources]);
  const sourceOptions = useMemo(() => sources.map((source) => ({
    value: source.id,
    label: `${source.name} · ${source.providerTypeLabel}${source.enabled ? '' : '（已禁用）'}`,
    disabled: !source.enabled
  })), [sources]);

  const runSearch = useCallback(async (nextKeyword = keyword) => {
    const trimmedKeyword = nextKeyword.trim();
    if (!sourceId) {
      setError('请选择一个已启用的源');
      return;
    }
    if (!trimmedKeyword) {
      setError('请输入搜索关键词');
      return;
    }
    setLoading(true);
    setError('');
    setMessage('');
    setResults([]);
    setRecords([]);
    try {
      const response = await fetch(`/api/sources/${sourceId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: trimmedKeyword, kind, page: 1, pageSize: 20, saveResults })
      });
      const payload = (await response.json()) as SearchPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '搜索失败');
      const nextResults = payload.data?.results ?? [];
      setResults(nextResults);
      setRecords(payload.data?.records ?? []);
      setMessage(saveResults ? `找到 ${nextResults.length} 条结果，已写入历史记录` : `找到 ${nextResults.length} 条结果`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '搜索失败');
    } finally {
      setLoading(false);
    }
  }, [kind, keyword, saveResults, sourceId]);

  useEffect(() => {
    fetch('/api/sources')
      .then((response) => response.json() as Promise<SourcesPayload>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取源列表失败');
        const nextSources = payload.data?.sources ?? [];
        setSources(nextSources);
        const firstEnabled = nextSources.find((source) => source.enabled);
        if (firstEnabled) setSourceId(firstEnabled.id);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取源列表失败'));
  }, []);

  useEffect(() => {
    if (urlKeyword) setKeyword(urlKeyword);
  }, [urlKeyword]);

  useEffect(() => {
    if (!shouldAutoSearch || !sourceId || !urlKeyword) return;
    const autoSearchKey = `${sourceId}:${urlKeyword}`;
    if (lastAutoSearchRef.current === autoSearchKey) return;
    lastAutoSearchRef.current = autoSearchKey;
    void runSearch(urlKeyword);
  }, [runSearch, shouldAutoSearch, sourceId, urlKeyword]);

  function searchSources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch();
  }

  async function markResult(result: SourceSearchResult, status: 'saved' | 'ignored') {
    setBusy(`${status}:${result.externalId}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/source-search-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...result, status })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { record: SourceSearchRecordView }; error?: { message: string } };
      if (!payload.ok || !payload.data?.record) throw new Error(payload.error?.message ?? '操作失败');
      setRecords((current) => [...current.filter((record) => record.externalId !== result.externalId), payload.data!.record]);
      setMessage(status === 'saved' ? '搜索结果已保存' : '搜索结果已忽略');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  async function createDownloadTask(result: SourceSearchResult) {
    if (!result.downloadAvailable) return;
    setBusy(`download:${result.externalId}`);
    setError('');
    setMessage('');
    try {
      const existingRecord = records.find((record) => record.externalId === result.externalId);
      let record = existingRecord;
      if (!record) {
        const saveResponse = await fetch('/api/source-search-records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...result, status: 'saved' })
        });
        const savePayload = (await saveResponse.json()) as { ok: boolean; data?: { record: SourceSearchRecordView }; error?: { message: string } };
        if (!savePayload.ok || !savePayload.data?.record) throw new Error(savePayload.error?.message ?? '保存搜索结果失败');
        record = savePayload.data.record;
      }
      const response = await fetch(`/api/source-search-records/${record.id}/create-download-task`, { method: 'POST' });
      const payload = (await response.json()) as CreateDownloadPayload;
      if (!payload.ok || !payload.data?.record) throw new Error(payload.error?.message ?? '创建下载任务失败');
      setRecords((current) => [...current.filter((item) => item.externalId !== result.externalId), payload.data!.record]);
      setMessage(payload.data.alreadyQueued ? '已在下载队列中' : '已加入下载队列');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建下载任务失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="源搜索"
        desc="通过统一 SourceProvider 接口搜索已配置的来源，可选择保存搜索结果。"
        action={<Link href="/settings/sources" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"><Settings size={16} />源管理</Link>}
      />
      <form onSubmit={searchSources} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,280px)_160px_minmax(0,1fr)_auto] lg:items-end">
          <label className="text-sm text-slate-600">
            选择源
            <Select value={sourceId} options={sourceOptions} onChange={setSourceId} ariaLabel="选择源" className="mt-2 w-full" />
          </label>
          <label className="text-sm text-slate-600">
            内容类型
            <Select value={kind} options={kindOptions} onChange={setKind} ariaLabel="内容类型" className="mt-2 w-full" />
          </label>
          <label className="text-sm text-slate-600">
            关键词
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入书名、漫画名、章节关键词..." className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-slate-900 outline-none focus:border-blue-300" />
          </label>
          <Button disabled={loading || !sourceId} icon={Search}>{loading ? '搜索中' : '搜索'}</Button>
        </div>
        <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={saveResults} onChange={(event) => setSaveResults(event.target.checked)} className="h-4 w-4 accent-blue-600" />
          搜索后自动保存到历史结果
        </label>
        {selectedSource ? (
          <div className="mt-3 text-sm text-slate-500">
            当前源：{selectedSource.providerTypeLabel} · {selectedSource.kindLabel} · 优先级 {selectedSource.priority}
          </div>
        ) : null}
      </form>
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="space-y-3">
        {results.map((result) => {
          const record = records.find((item) => item.externalId === result.externalId);
          const queued = record?.status === 'download_created';
          return (
          <article key={`${result.sourceId}-${result.externalId}`} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="break-words text-lg font-semibold text-slate-900">{result.title}</h2>
                  <span className={cn('rounded-full px-2 py-1 text-xs', result.downloadAvailable ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                    {result.downloadAvailable ? '可下载' : '不可下载'}
                  </span>
                  {record ? (
                    <span className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">
                      {record.status === 'ignored' ? '已忽略' : queued ? '已加入队列' : '已保存'}
                    </span>
                  ) : null}
                </div>
                {result.subtitle ? <div className="mt-1 text-sm text-slate-500">{result.subtitle}</div> : null}
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                  <span className="rounded-full bg-slate-100 px-2 py-1">来源 {result.providerType}</span>
                  {result.author ? <span className="rounded-full bg-slate-100 px-2 py-1">作者 {result.author}</span> : null}
                  {result.format ? <span className="rounded-full bg-slate-100 px-2 py-1">格式 {result.format}</span> : null}
                  {result.size ? <span className="rounded-full bg-slate-100 px-2 py-1">大小 {result.size}</span> : null}
                  {result.language ? <span className="rounded-full bg-slate-100 px-2 py-1">语言 {result.language}</span> : null}
                  {result.publishedAt ? <span className="rounded-full bg-slate-100 px-2 py-1">发布 {result.publishedAt}</span> : null}
                </div>
                {result.description ? <p className="mt-3 text-sm leading-6 text-slate-600">{result.description}</p> : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button disabled={busy === `saved:${result.externalId}`} variant="secondary" onClick={() => void markResult(result, 'saved')}>保存</Button>
                <Button disabled={busy === `ignored:${result.externalId}`} variant="secondary" onClick={() => void markResult(result, 'ignored')}>忽略</Button>
                {result.downloadAvailable ? <Button disabled={queued || busy === `download:${result.externalId}`} variant="secondary" icon={Download} onClick={() => void createDownloadTask(result)}>{queued ? '已加入队列' : '加入下载队列'}</Button> : null}
                {result.externalUrl ? (
                  <a href={result.externalUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                    <ExternalLink size={15} />
                    外部链接
                  </a>
                ) : null}
              </div>
            </div>
          </article>
          );
        })}
        {!loading && results.length === 0 ? <div className="rounded-[24px] border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">输入关键词后执行搜索。未实现的源类型会显示明确错误。</div> : null}
      </div>
    </div>
  );
}
