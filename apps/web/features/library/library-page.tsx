'use client';

import { CheckCircle2, EyeOff, Filter, Grid3X3, List, Plus, RefreshCw, Search, Tags, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BookCard } from '../../components/book/book-card';
import { BookTable } from '../../components/book/book-table';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';
import type { BookView } from '../../lib/books';

type BooksResponse = {
  ok: boolean;
  data?: { books: BookView[]; total: number; page: number; pageSize: number; totalPages: number };
  error?: { message: string };
};

const visibilityOptions = [
  { value: 'active', label: '在库中' },
  { value: 'ignored', label: '已忽略' },
  { value: 'all', label: '全部' }
];

const sortOptions = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '最近添加' },
  { value: 'title', label: '标题' }
];

const formatOptions = [
  { value: 'TXT', label: 'TXT' },
  { value: 'PDF', label: 'PDF' },
  { value: 'IMAGE', label: '图片' },
  { value: 'COMIC', label: '漫画' },
  { value: 'EPUB', label: 'EPUB' },
  { value: 'UNKNOWN', label: '未知' }
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
  const [visibility, setVisibility] = useState<'active' | 'ignored' | 'all'>('active');
  const [sort, setSort] = useState('updated');
  const [search, setSearch] = useState('');
  const [books, setBooks] = useState<BookView[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, pageSize: 24, totalPages: 1 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkFormat, setBulkFormat] = useState('COMIC');
  const [bulkStatus, setBulkStatus] = useState('READING');
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filter !== '全部') params.set('format', filter);
    params.set('visibility', visibility);
    params.set('sort', sort);
    params.set('page', String(page));
    return params.toString();
  }, [filter, page, search, sort, visibility]);

  useEffect(() => {
    setPage(1);
  }, [filter, search, sort, visibility]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/books?${query}`)
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
      const response = await fetch('/api/books/bulk', {
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

  return (
    <div className="space-y-6">
      <PageTitle title="我的书库" desc="浏览、搜索、筛选和批量管理所有读物。" action={<Button icon={Plus} onClick={() => router.push('/settings')}>添加目录</Button>} />
      <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl border border-slate-200 px-4 md:min-w-[360px]">
            <Search size={17} className="text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者、标签、格式..." className="w-full bg-transparent text-sm outline-none" />
          </div>
          <Button variant="secondary" icon={Filter}>高级筛选</Button>
          <Button variant={view === 'grid' ? 'primary' : 'secondary'} icon={Grid3X3} onClick={() => setView('grid')}>网格</Button>
          <Button variant={view === 'list' ? 'primary' : 'secondary'} icon={List} onClick={() => setView('list')}>列表</Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {['全部', '漫画', 'TXT', 'EPUB', 'PDF', '图片'].map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={cn(
                'rounded-full border px-4 py-2 text-sm',
                filter === item ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
              )}
            >
              {item}
            </button>
          ))}
          <Select value={visibility} options={visibilityOptions} onChange={setVisibility} ariaLabel="可见性筛选" />
          <Select value={sort} options={sortOptions} onChange={setSort} ariaLabel="排序方式" className="ml-auto" align="right" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleCurrentPage(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            选择当前页
          </label>
          {selected.length > 0 ? <button onClick={() => setSelected([])} className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900"><X size={14} />清空选择</button> : null}
          {message ? <span className="text-emerald-600">{message}</span> : null}
        </div>
        {selected.length > 0 ? (
          <div className="mt-4 space-y-3 rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <div className="flex flex-wrap items-center gap-3">
              <CheckCircle2 size={16} />
              已选择 {selected.length} 项
              <Select value={bulkFormat} options={formatOptions} onChange={setBulkFormat} ariaLabel="批量修改类型" tone="blue" size="sm" />
              <Button disabled={busy} variant="secondary" className="bg-white" icon={Filter} onClick={() => performBulk({ format: bulkFormat }, '已批量修改类型')}>修改类型</Button>
              <Select value={bulkStatus} options={statusOptions} onChange={setBulkStatus} ariaLabel="批量修改阅读状态" tone="blue" size="sm" />
              <Button disabled={busy} variant="secondary" className="bg-white" icon={CheckCircle2} onClick={() => performBulk({ status: bulkStatus }, '已批量修改阅读状态')}>修改状态</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="标签，用逗号分隔" className="h-10 min-w-[220px] flex-1 rounded-xl border border-blue-100 bg-white px-3 text-sm text-slate-700 outline-none" />
              <Button disabled={busy || parseTagInput().length === 0} variant="secondary" className="bg-white" icon={Tags} onClick={() => performBulk({ addTags: parseTagInput() }, '已批量添加标签')}>添加标签</Button>
              <Button disabled={busy || parseTagInput().length === 0} variant="secondary" className="bg-white" icon={Tags} onClick={() => performBulk({ removeTags: parseTagInput() }, '已批量移除标签')}>移除标签</Button>
              <Button disabled={busy} variant="secondary" className="bg-white" icon={RefreshCw} onClick={() => performBulk({ regenerateCover: true }, '已批量重新生成封面')}>重新生成封面</Button>
              <Button disabled={busy} variant="danger" icon={Trash2} onClick={() => performBulk({ ignored: true }, '已批量忽略读物')}>忽略</Button>
              {visibility !== 'active' ? <Button disabled={busy} variant="secondary" className="bg-white" icon={EyeOff} onClick={() => performBulk({ ignored: false }, '已恢复显示')}>恢复显示</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取书库...</div> : null}
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div> : null}
      {!loading && !error && books.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8">
          <div className="text-sm text-slate-500">暂无读物，请先在系统设置中添加书库路径，然后启动扫描。</div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button icon={Plus} onClick={() => router.push('/settings')}>去添加书库路径</Button>
            <Button variant="secondary" icon={RefreshCw} onClick={() => router.push('/scan-tasks')}>开始扫描</Button>
          </div>
        </div>
      ) : null}
      {!loading && !error && books.length > 0 ? (
        <>
          {view === 'grid' ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {books.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  selectionEnabled
                  selected={selected.includes(book.id)}
                  onSelectedChange={(checked) => setBookSelected(book.id, checked)}
                  onClick={() => router.push(`/books/${book.id}`)}
                />
              ))}
            </div>
          ) : (
            <BookTable books={books} selectedIds={selected} onSelectedChange={setBookSelected} />
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
