'use client';

import { ChevronDown, Filter, Grid3X3, List, Loader2, Plus, RefreshCw, Search, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BookCard } from '../../components/book/book-card';
import { BookTable } from '../../components/book/book-table';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { useConfirm, useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';
import type { WorkView } from '../../types/work';

type BooksResponse = {
  ok: boolean;
  data?: { books: WorkView[]; total: number; page: number; pageSize: number; totalPages: number };
  error?: { message: string };
};

type ImportResponse = { ok: boolean; data?: { title: string; duplicate?: boolean }; error?: { message: string } };

const visibilityOptions = [
  { value: 'active', label: '在库中' },
  { value: 'ignored', label: '已忽略' },
  { value: 'all', label: '全部' }
];

const sortOptions = [
  { value: 'recent_read', label: '最近阅读' },
  { value: 'recent_import', label: '最近导入' },
  { value: 'title', label: '标题' },
  { value: 'author', label: '作者' },
  { value: 'progress', label: '阅读进度' }
];

const formatOptions = [
  { value: '全部', label: '全部' },
  { value: 'ebook', label: '电子书' },
  { value: 'COMIC', label: '漫画' }
];

const statusOptions = [
  { value: 'WANT', label: '想读' },
  { value: 'READING', label: '在读' },
  { value: 'FINISHED', label: '已读' }
];

const publicationStatusOptions = [
  { value: 'UNKNOWN', label: '未知' },
  { value: 'ONGOING', label: '连载中' },
  { value: 'COMPLETED', label: '已完结' },
  { value: 'HIATUS', label: '休刊中' },
  { value: 'CANCELLED', label: '已腰斩' }
];

const trackingStatusOptions = [
  { value: 'NOT_TRACKING', label: '未追更' },
  { value: 'TRACKING', label: '追更中' },
  { value: 'PAUSED', label: '暂停追更' },
  { value: 'IGNORED', label: '忽略更新' }
];

export function LibraryPage() {
  const router = useRouter();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [filter, setFilter] = useState('全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [publicationStatusFilter, setPublicationStatusFilter] = useState('全部');
  const [trackingStatusFilter, setTrackingStatusFilter] = useState('全部');
  const [tagFilter, setTagFilter] = useState('');
  const [missingCoverOnly, setMissingCoverOnly] = useState(false);
  const [newImportOnly, setNewImportOnly] = useState(false);
  const [visibility, setVisibility] = useState<'active' | 'ignored' | 'all'>('active');
  const [sort, setSort] = useState('recent_read');
  const [search, setSearch] = useState('');
  const [books, setBooks] = useState<WorkView[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, pageSize: 24, totalPages: 1 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filter !== '全部') params.set('type', filter);
    if (statusFilter !== '全部') params.set('status', statusFilter);
    if (publicationStatusFilter !== '全部') params.set('publicationStatus', publicationStatusFilter);
    if (trackingStatusFilter !== '全部') params.set('trackingStatus', trackingStatusFilter);
    if (tagFilter.trim()) params.set('tag', tagFilter.trim());
    if (missingCoverOnly) params.set('missingCover', 'true');
    if (newImportOnly) params.set('newImport', 'true');
    params.set('visibility', visibility);
    params.set('sort', sort);
    params.set('page', String(page));
    return params.toString();
  }, [filter, missingCoverOnly, newImportOnly, page, publicationStatusFilter, search, sort, statusFilter, tagFilter, trackingStatusFilter, visibility]);

  useEffect(() => {
    setPage(1);
  }, [filter, missingCoverOnly, newImportOnly, publicationStatusFilter, search, sort, statusFilter, tagFilter, trackingStatusFilter, visibility]);

  useEffect(() => {
    const savedView = window.localStorage.getItem('shuku.library.view');
    if (savedView === 'grid' || savedView === 'list') setView(savedView);
  }, []);

  function updateView(nextView: 'grid' | 'list') {
    setView(nextView);
    window.localStorage.setItem('shuku.library.view', nextView);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/works?${query}`)
      .then((response) => response.json() as Promise<BooksResponse>)
      .then((payload) => {
        if (!active) return;
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取书库失败');
        const data = payload.data;
        if (data && page > data.totalPages && data.totalPages > 0) {
          setPage(data.totalPages);
          return;
        }
        setBooks(data?.books ?? []);
        setMeta({
          total: data?.total ?? 0,
          pageSize: data?.pageSize ?? 24,
          totalPages: data?.totalPages ?? 1
        });
        setError('');
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : '读取书库失败');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [page, query, reloadKey]);

  const activeFilterCount = [
    search.trim(),
    filter !== '全部',
    visibility !== 'active',
    statusFilter !== '全部',
    publicationStatusFilter !== '全部',
    trackingStatusFilter !== '全部',
    tagFilter.trim(),
    missingCoverOnly,
    newImportOnly
  ].filter(Boolean).length;

  async function uploadBook(file: File | null) {
    if (!file) return;
    setUploading(true);
    setError('');
    setMessage('');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/works/import', { method: 'POST', body: form });
      const text = await response.text();
      const payload = text ? JSON.parse(text) as ImportResponse : { ok: false, error: { message: response.ok ? '导入失败' : `上传失败（HTTP ${response.status}）` } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '导入失败');
      const successMessage = payload.data?.duplicate ? `《${payload.data.title}》已存在` : `《${payload.data?.title ?? file.name}》已导入`;
      setMessage(successMessage);
      toast.success(successMessage);
      setReloadKey((key) => key + 1);
    } catch (reason) {
      const nextError = reason instanceof SyntaxError ? '上传失败：服务器返回了无法解析的响应，请检查反向代理上传体积限制。' : reason instanceof Error ? reason.message : '导入失败';
      setError(nextError);
      toast.error('导入失败', nextError);
    } finally {
      setUploading(false);
    }
  }

  async function deleteBook(book: WorkView) {
    const confirmed = await confirm({
      title: '确认删除记录',
      description: `确认删除《${book.title}》的书库记录吗？来源文件会保留在监控目录中。`,
      confirmLabel: '删除记录和文件',
      tone: 'danger'
    });
    if (!confirmed) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${book.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除失败');
      setMessage('已删除书库记录');
      toast.success('已删除书库记录', '来源文件已保留');
      setReloadKey((key) => key + 1);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '删除失败';
      setError(nextError);
      toast.error('删除失败', nextError);
    }
  }

  function clearFilters() {
    setSearch('');
    setFilter('全部');
    setStatusFilter('全部');
    setPublicationStatusFilter('全部');
    setTrackingStatusFilter('全部');
    setTagFilter('');
    setMissingCoverOnly(false);
    setNewImportOnly(false);
    setVisibility('active');
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="我的书库"
        desc="上传、浏览、搜索和筛选 EPUB、PDF 与漫画读物。"
        action={
          <div className="flex flex-wrap gap-3">
            <label className={cn('inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-blue-700 focus-within:ring-2 focus-within:ring-blue-200', uploading ? 'cursor-not-allowed opacity-80' : '')}>
              {uploading ? <Loader2 size={17} className="animate-spin" strokeWidth={2.4} /> : <UploadCloud size={17} strokeWidth={2.2} />}
              {uploading ? '导入中' : '上传读物'}
              <input type="file" accept=".epub,.cbz,.zip,.pdf,application/epub+zip,application/zip,application/pdf" className="hidden" disabled={uploading} onChange={(event) => void uploadBook(event.target.files?.[0] ?? null)} />
            </label>
            <Button variant="secondary" icon={Plus} onClick={() => router.push('/settings')}>监控文件夹</Button>
          </div>
        }
      />
      <div className="rounded-[22px] border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            aria-expanded={filtersOpen}
          >
            <Search size={16} className="text-slate-500" />
            <span>{activeFilterCount > 0 ? `搜索与筛选 · ${activeFilterCount}` : '搜索与筛选'}</span>
            <ChevronDown size={15} className={cn('text-slate-400 transition', filtersOpen && 'rotate-180')} />
          </button>
          {message ? <span className="px-2 text-sm text-emerald-600">{message}</span> : null}
          <div className="ml-auto flex items-center gap-2">
            <Select value={sort} options={sortOptions} onChange={setSort} ariaLabel="排序方式" size="sm" className="min-w-[116px]" align="right" />
            <button
              type="button"
              title="网格"
              aria-label="网格"
              onClick={() => updateView('grid')}
              className={cn(
                'inline-flex h-10 w-10 items-center justify-center rounded-2xl border transition',
                view === 'grid' ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              )}
            >
              <Grid3X3 size={16} />
            </button>
            <button
              type="button"
              title="列表"
              aria-label="列表"
              onClick={() => updateView('list')}
              className={cn(
                'inline-flex h-10 w-10 items-center justify-center rounded-2xl border transition',
                view === 'list' ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              )}
            >
              <List size={16} />
            </button>
          </div>
        </div>
        {filtersOpen ? (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-slate-200 px-3 md:min-w-[360px]">
                <Search size={16} className="text-slate-400" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者、标签、格式..." className="w-full bg-transparent text-sm outline-none" />
              </div>
              <Button type="button" disabled={activeFilterCount === 0} variant="secondary" icon={Filter} className="h-10 px-3 py-0" onClick={clearFilters}>清除筛选</Button>
              <Select value={visibility} options={visibilityOptions} onChange={setVisibility} ariaLabel="可见性筛选" size="sm" />
              <Select value={statusFilter} options={[{ value: '全部', label: '全部状态' }, ...statusOptions]} onChange={setStatusFilter} ariaLabel="阅读状态筛选" size="sm" />
              <Select value={publicationStatusFilter} options={[{ value: '全部', label: '全部出版' }, ...publicationStatusOptions]} onChange={setPublicationStatusFilter} ariaLabel="出版状态筛选" size="sm" />
              <Select value={trackingStatusFilter} options={[{ value: '全部', label: '全部追更' }, ...trackingStatusOptions]} onChange={setTrackingStatusFilter} ariaLabel="追更状态筛选" size="sm" />
              <input value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="标签筛选" className="h-10 rounded-2xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-300" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {formatOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm',
                    filter === option.value ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
                  )}
                >
                  {option.label}
                </button>
              ))}
              {['EPUB', 'PDF', 'CBZ', 'ZIP'].map((item) => (
                <button
                  key={item}
                  onClick={() => setFilter(item)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm',
                    filter === item ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
                  )}
                >
                  {item}
                </button>
              ))}
              <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={missingCoverOnly} onChange={(event) => setMissingCoverOnly(event.target.checked)} className="h-4 w-4 accent-blue-600" />
                缺封面
              </label>
              <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={newImportOnly} onChange={(event) => setNewImportOnly(event.target.checked)} className="h-4 w-4 accent-blue-600" />
                新导入
              </label>
            </div>
          </div>
        ) : null}
      </div>
      {loading ? <div className="shuku-loading-panel p-8 text-sm" role="status" aria-live="polite">正在读取书库...</div> : null}
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div> : null}
      {!loading && !error && books.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8">
          <div className="text-sm text-slate-500">暂无读物，请上传 EPUB/PDF/CBZ/ZIP，或在系统设置中添加监控文件夹。</div>
          <div className="mt-5 flex flex-wrap gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
              <UploadCloud size={17} />上传读物
              <input type="file" accept=".epub,.cbz,.zip,.pdf,application/epub+zip,application/zip,application/pdf" className="hidden" disabled={uploading} onChange={(event) => void uploadBook(event.target.files?.[0] ?? null)} />
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={() => router.push('/settings')}>添加监控文件夹</Button>
          </div>
        </div>
      ) : null}
      {!loading && !error && books.length > 0 ? (
        <>
          {view === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,170px))] justify-start gap-4">
              {books.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onDelete={() => void deleteBook(book)}
                  onClick={() => router.push(`/works/${book.id}`)}
                />
              ))}
            </div>
          ) : (
            <BookTable books={books} onDelete={(book) => void deleteBook(book)} />
          )}
          <div className="flex flex-col gap-3 rounded-[28px] border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm md:flex-row md:items-center md:justify-between">
            <div>
              共 {meta.total} 本 · 第 {page}/{meta.totalPages} 页 · 每页 {meta.pageSize} 本
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</Button>
              <Button variant="secondary" disabled={page >= meta.totalPages || loading} onClick={() => setPage((current) => Math.min(meta.totalPages, current + 1))}>下一页</Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
