'use client';

import { CheckCircle2, ChevronDown, EyeOff, Filter, Grid3X3, List, Plus, RefreshCw, Search, Tags, Trash2, UploadCloud, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BookCard } from '../../components/book/book-card';
import { BookTable } from '../../components/book/book-table';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';
import type { WorkView } from '../../lib/books';

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
  { value: 'comic', label: '漫画' }
];

const bulkFormatOptions = [
  { value: 'EPUB', label: 'EPUB' },
  { value: 'COMIC', label: '漫画' }
];

const statusOptions = [
  { value: 'WANT', label: '想读' },
  { value: 'READING', label: '在读' },
  { value: 'FINISHED', label: '已读' }
];

export function LibraryPage() {
  const router = useRouter();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [filter, setFilter] = useState('全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [tagFilter, setTagFilter] = useState('');
  const [missingCoverOnly, setMissingCoverOnly] = useState(false);
  const [newImportOnly, setNewImportOnly] = useState(false);
  const [visibility, setVisibility] = useState<'active' | 'ignored' | 'all'>('active');
  const [sort, setSort] = useState('updated');
  const [search, setSearch] = useState('');
  const [books, setBooks] = useState<WorkView[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, pageSize: 24, totalPages: 1 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkFormat, setBulkFormat] = useState('EPUB');
  const [bulkStatus, setBulkStatus] = useState('READING');
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filter !== '全部') params.set('type', filter);
    if (statusFilter !== '全部') params.set('status', statusFilter);
    if (tagFilter.trim()) params.set('tag', tagFilter.trim());
    if (missingCoverOnly) params.set('missingCover', 'true');
    if (newImportOnly) params.set('newImport', 'true');
    params.set('visibility', visibility);
    params.set('sort', sort);
    params.set('page', String(page));
    return params.toString();
  }, [filter, missingCoverOnly, newImportOnly, page, search, sort, statusFilter, tagFilter, visibility]);

  useEffect(() => {
    setPage(1);
  }, [filter, missingCoverOnly, newImportOnly, search, sort, statusFilter, tagFilter, visibility]);

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
  }, [query, reloadKey]);

  const visibleBookIds = useMemo(() => books.map((book) => book.id), [books]);
  const allVisibleSelected = visibleBookIds.length > 0 && visibleBookIds.every((id) => selected.includes(id));
  const activeFilterCount = [search.trim(), filter !== '全部', visibility !== 'active', statusFilter !== '全部', tagFilter.trim(), missingCoverOnly, newImportOnly].filter(Boolean).length;

  function setBookSelected(bookId: string, checked: boolean) {
    setSelected((current) => (checked ? [...new Set([...current, bookId])] : current.filter((id) => id !== bookId)));
  }

  function toggleCurrentPage(checked: boolean) {
    setSelected((current) => {
      if (!checked) return current.filter((id) => !visibleBookIds.includes(id));
      return [...new Set([...current, ...visibleBookIds])];
    });
  }

  function parseTagInput() {
    return tagInput
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  async function performBulk(body: Record<string, unknown>, successMessage: string) {
    if (selected.length === 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/works/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selected, ...body })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '批量操作失败');
      setMessage(successMessage);
      if ('addTags' in body || 'removeTags' in body) setTagInput('');
      setReloadKey((key) => key + 1);
      setSelected([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量操作失败');
    } finally {
      setBusy(false);
    }
  }

  function confirmBulk(body: Record<string, unknown>, successMessage: string, prompt?: string) {
    if (prompt && !window.confirm(prompt)) return;
    void performBulk(body, successMessage);
  }

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
      setMessage(payload.data?.duplicate ? `《${payload.data.title}》已存在` : `《${payload.data?.title ?? file.name}》已导入`);
      setReloadKey((key) => key + 1);
    } catch (reason) {
      setError(reason instanceof SyntaxError ? '上传失败：服务器返回了无法解析的响应，请检查反向代理上传体积限制。' : reason instanceof Error ? reason.message : '导入失败');
    } finally {
      setUploading(false);
    }
  }

  async function deleteBook(book: WorkView) {
    if (!window.confirm(`确认删除《${book.title}》的数据库记录吗？源文件不会被删除。`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${book.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除失败');
      setMessage('已删除数据库记录，源文件未删除');
      setSelected((current) => current.filter((id) => id !== book.id));
      setReloadKey((key) => key + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="我的书库"
        desc="上传、浏览、搜索、筛选和批量管理 EPUB 与漫画读物。"
        action={
          <div className="flex flex-wrap gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
              <UploadCloud size={17} />
              {uploading ? '导入中...' : '上传读物'}
              <input type="file" accept=".epub,.cbz,.zip,application/epub+zip,application/zip" className="hidden" disabled={uploading} onChange={(event) => void uploadBook(event.target.files?.[0] ?? null)} />
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
          <label className="flex h-10 items-center gap-2 rounded-2xl border border-slate-200 px-3 text-sm text-slate-600">
            <input type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleCurrentPage(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            选择当前页
          </label>
          {selected.length > 0 ? <button onClick={() => setSelected([])} className="inline-flex h-10 items-center gap-1 rounded-2xl px-2 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-900"><X size={14} />清空</button> : null}
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
              <Button variant="secondary" icon={Filter} className="h-10 px-3 py-0">高级筛选</Button>
              <Select value={visibility} options={visibilityOptions} onChange={setVisibility} ariaLabel="可见性筛选" size="sm" />
              <Select value={statusFilter} options={[{ value: '全部', label: '全部状态' }, ...statusOptions]} onChange={setStatusFilter} ariaLabel="阅读状态筛选" size="sm" />
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
              {['EPUB', 'CBZ', 'ZIP'].map((item) => (
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
        {selected.length > 0 ? (
          <div className="mt-4 space-y-3 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <div className="flex flex-wrap items-center gap-3">
              <CheckCircle2 size={16} />
              已选择 {selected.length} 项
              <Select value={bulkFormat} options={bulkFormatOptions} onChange={setBulkFormat} ariaLabel="批量修改类型" tone="blue" size="sm" />
              <Button disabled={busy} variant="secondary" className="bg-white" icon={Filter} onClick={() => performBulk({ format: bulkFormat }, '已批量修改类型')}>修改类型</Button>
              <Select value={bulkStatus} options={statusOptions} onChange={setBulkStatus} ariaLabel="批量修改阅读状态" tone="blue" size="sm" />
              <Button disabled={busy} variant="secondary" className="bg-white" icon={CheckCircle2} onClick={() => performBulk({ status: bulkStatus }, '已批量修改阅读状态')}>修改状态</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="标签，用逗号分隔" className="h-10 min-w-[220px] flex-1 rounded-xl border border-blue-100 bg-white px-3 text-sm text-slate-700 outline-none" />
              <Button disabled={busy || parseTagInput().length === 0} variant="secondary" className="bg-white" icon={Tags} onClick={() => performBulk({ addTags: parseTagInput() }, '已批量添加标签')}>添加标签</Button>
              <Button disabled={busy || parseTagInput().length === 0} variant="secondary" className="bg-white" icon={Tags} onClick={() => performBulk({ removeTags: parseTagInput() }, '已批量移除标签')}>移除标签</Button>
              <Button disabled={busy} variant="secondary" className="bg-white" icon={RefreshCw} onClick={() => performBulk({ regenerateCover: true }, '已批量重新生成封面')}>重新生成封面</Button>
              <Button disabled={busy} variant="danger" icon={Trash2} onClick={() => confirmBulk({ ignored: true }, '已批量隐藏读物', `确认隐藏选中的 ${selected.length} 本读物吗？不会删除源文件。`)}>隐藏</Button>
              <Button disabled={busy} variant="danger" icon={Trash2} onClick={() => confirmBulk({ deleteRecords: true }, '已删除数据库记录，源文件未删除', `确认删除选中的 ${selected.length} 条数据库记录吗？NAS 源文件不会被删除。`)}>删除记录</Button>
              {visibility !== 'active' ? <Button disabled={busy} variant="secondary" className="bg-white" icon={EyeOff} onClick={() => performBulk({ ignored: false }, '已恢复显示')}>恢复显示</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取书库...</div> : null}
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div> : null}
      {!loading && !error && books.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8">
          <div className="text-sm text-slate-500">暂无读物，请上传 EPUB/CBZ/ZIP，或在系统设置中添加监控文件夹。</div>
          <div className="mt-5 flex flex-wrap gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
              <UploadCloud size={17} />上传读物
              <input type="file" accept=".epub,.cbz,.zip,application/epub+zip,application/zip" className="hidden" disabled={uploading} onChange={(event) => void uploadBook(event.target.files?.[0] ?? null)} />
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
                  selectionEnabled
                  selected={selected.includes(book.id)}
                  onSelectedChange={(checked) => setBookSelected(book.id, checked)}
                  onDelete={() => void deleteBook(book)}
                  onClick={() => router.push(`/works/${book.id}`)}
                />
              ))}
            </div>
          ) : (
            <BookTable books={books} selectedIds={selected} onSelectedChange={setBookSelected} onDelete={(book) => void deleteBook(book)} />
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
