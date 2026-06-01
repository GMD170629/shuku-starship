'use client';

import { Check, Edit3, MoreHorizontal, Plus, Save, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import type { WorkView } from '../../lib/books';

type ShelfView = {
  id: string;
  name: string;
  description: string | null;
  bookCount: number;
  books: WorkView[];
  createdAt: string;
  updatedAt: string;
};

type ShelvesPayload = {
  ok: boolean;
  data?: { shelves: ShelfView[] };
  error?: { message: string };
};

type ShelfPayload = {
  ok: boolean;
  data?: { shelf: ShelfView };
  error?: { message: string };
};

type BooksPayload = {
  ok: boolean;
  data?: { books: WorkView[] };
  error?: { message: string };
};

const emptyForm = { name: '', description: '' };

export function ShelvesPage() {
  const [shelves, setShelves] = useState<ShelfView[]>([]);
  const [activeShelf, setActiveShelf] = useState<ShelfView | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchBooks, setSearchBooks] = useState<WorkView[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void loadShelves();
  }, []);

  useEffect(() => {
    if (!activeId || search.trim().length === 0) {
      setSearchBooks([]);
      return;
    }
    let active = true;
    const params = new URLSearchParams({ pageSize: '12', visibility: 'active', sort: 'title', search: search.trim() });
    fetch(`/api/works?${params}`)
      .then((response) => response.json() as Promise<BooksPayload>)
      .then((payload) => {
        if (!active) return;
        if (!payload.ok) throw new Error(payload.error?.message ?? '搜索图书失败');
        setSearchBooks(payload.data?.books ?? []);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : '搜索图书失败'));
    return () => {
      active = false;
    };
  }, [activeId, search]);

  const activeIsNew = activeId === 'new';
  const previewBooksById = useMemo(() => {
    const books = new Map<string, WorkView>();
    [...(activeShelf?.books ?? []), ...searchBooks].forEach((book) => books.set(book.id, book));
    return books;
  }, [activeShelf, searchBooks]);
  const selectedBooks = selectedBookIds.map((id) => previewBooksById.get(id)).filter(Boolean) as WorkView[];

  async function loadShelves() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/shelves');
      const payload = (await response.json()) as ShelvesPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '读取书架失败');
      setShelves(payload.data?.shelves ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取书架失败');
    } finally {
      setLoading(false);
    }
  }

  async function openShelf(id: string) {
    setActiveId(id);
    setDetailLoading(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/shelves/${id}`);
      const payload = (await response.json()) as ShelfPayload;
      if (!payload.ok || !payload.data) throw new Error(payload.error?.message ?? '读取书架详情失败');
      const shelf = payload.data.shelf;
      setActiveShelf(shelf);
      setForm({ name: shelf.name, description: shelf.description ?? '' });
      setSelectedBookIds(shelf.books.map((book) => book.id));
      setSearch('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取书架详情失败');
    } finally {
      setDetailLoading(false);
    }
  }

  function openCreate() {
    setActiveId('new');
    setActiveShelf(null);
    setForm(emptyForm);
    setSelectedBookIds([]);
    setSearch('');
    setSearchBooks([]);
    setMessage('');
    setError('');
  }

  function closeEditor() {
    setActiveId(null);
    setActiveShelf(null);
    setSelectedBookIds([]);
    setSearch('');
    setSearchBooks([]);
    setForm(emptyForm);
  }

  function toggleBook(bookId: string, checked: boolean) {
    setSelectedBookIds((current) => (checked ? [...new Set([...current, bookId])] : current.filter((id) => id !== bookId)));
  }

  async function saveShelf() {
    const name = form.name.trim();
    if (!name) {
      setError('书架名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(activeIsNew ? '/api/shelves' : `/api/shelves/${activeId}`, {
        method: activeIsNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: form.description,
          ...(activeIsNew ? {} : { bookIds: selectedBookIds })
        })
      });
      const payload = (await response.json()) as ShelfPayload;
      if (!payload.ok || !payload.data) throw new Error(payload.error?.message ?? '保存书架失败');
      let saved = payload.data.shelf;
      if (activeIsNew && selectedBookIds.length > 0) {
        const nextResponse = await fetch(`/api/shelves/${saved.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookIds: selectedBookIds })
        });
        const nextPayload = (await nextResponse.json()) as ShelfPayload;
        if (!nextPayload.ok || !nextPayload.data) throw new Error(nextPayload.error?.message ?? '保存图书列表失败');
        saved = nextPayload.data.shelf;
      }
      setMessage(activeIsNew ? '书架已创建' : '书架已更新');
      setActiveId(saved.id);
      setActiveShelf(saved);
      setForm({ name: saved.name, description: saved.description ?? '' });
      setSelectedBookIds(saved.books.map((book) => book.id));
      await loadShelves();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存书架失败');
    } finally {
      setSaving(false);
    }
  }

  async function deleteShelf() {
    if (!activeShelf || !window.confirm(`删除书架“${activeShelf.name}”？图书不会被删除。`)) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/shelves/${activeShelf.id}`, { method: 'DELETE' });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '删除书架失败');
      closeEditor();
      setMessage('书架已删除');
      await loadShelves();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除书架失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="书架" desc="创建自定义书架，按主题、系列或阅读计划整理图书。" action={<Button icon={Plus} onClick={openCreate}>创建书架</Button>} />

      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      {activeId ? (
        <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Edit3 size={16} />
              {activeIsNew ? '创建书架' : '编辑书架'}
            </div>
            <div className="flex flex-wrap gap-2">
              {!activeIsNew ? <Button disabled={saving || detailLoading} variant="danger" icon={Trash2} onClick={deleteShelf}>删除书架</Button> : null}
              <Button disabled={saving || detailLoading} variant="secondary" icon={X} onClick={closeEditor}>关闭</Button>
              <Button disabled={saving || detailLoading} icon={Save} onClick={saveShelf}>{saving ? '保存中...' : '保存书架'}</Button>
            </div>
          </div>

          {detailLoading ? <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">正在读取书架详情...</div> : null}

          {!detailLoading ? (
            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-[minmax(0,320px)_1fr]">
                  <label className="block">
                    <span className="text-xs font-medium text-slate-500">名称</span>
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
                      placeholder="例如：太空歌剧、2026 待读"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-500">描述</span>
                    <input
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      className="mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
                      placeholder="可选，用一句话说明这个书架"
                    />
                  </label>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-800">已加入图书</div>
                    <Badge>{selectedBookIds.length} 本</Badge>
                  </div>
                  {selectedBooks.length > 0 ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
                      {selectedBooks.map((book) => (
                        <div key={book.id} className="rounded-[18px] border border-slate-200 bg-slate-50 p-2.5">
                          <Cover book={book} className="aspect-[2/3] w-full" size="small" />
                          <div className="mt-2 line-clamp-1 text-sm font-medium text-slate-900">{book.title}</div>
                          <button onClick={() => toggleBook(book.id, false)} className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1 rounded-xl bg-white text-xs text-red-600 hover:bg-red-50">
                            <X size={13} /> 移除
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">还没有图书，右侧搜索后勾选加入。</div>
                  )}
                </div>
              </div>

              <aside className="rounded-[20px] border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-800">搜索并加入图书</div>
                <div className="mt-3 flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3">
                  <Search size={16} className="text-slate-400" />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者、标签" className="w-full bg-transparent text-sm outline-none" />
                </div>
                <div className="mt-4 space-y-2">
                  {search.trim() && searchBooks.length === 0 ? <div className="rounded-2xl bg-white p-4 text-sm text-slate-500">没有匹配的图书。</div> : null}
                  {searchBooks.map((book) => {
                    const checked = selectedBookIds.includes(book.id);
                    return (
                      <label key={book.id} className={cn('flex cursor-pointer items-center gap-3 rounded-2xl border bg-white p-2.5 transition', checked ? 'border-blue-200 ring-4 ring-blue-50' : 'border-slate-200 hover:border-blue-200')}>
                        <input type="checkbox" checked={checked} onChange={(event) => toggleBook(book.id, event.target.checked)} className="h-4 w-4 accent-blue-600" />
                        <Cover book={book} className="h-16 w-11 shrink-0" small />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-1 text-sm font-medium text-slate-900">{book.title}</div>
                          <div className="mt-1 line-clamp-1 text-xs text-slate-500">{book.author} · {book.format}</div>
                        </div>
                        {checked ? <Check size={16} className="text-blue-600" /> : null}
                      </label>
                    );
                  })}
                </div>
              </aside>
            </div>
          ) : null}
        </section>
      ) : null}

      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500">正在读取书架...</div> : null}
      {!loading && shelves.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8">
          <div className="text-sm text-slate-500">还没有自定义书架。创建一个书架后，就可以搜索并加入图书。</div>
          <Button className="mt-5" icon={Plus} onClick={openCreate}>创建第一个书架</Button>
        </div>
      ) : null}
      {!loading && shelves.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {shelves.map((shelf) => (
            <button
              key={shelf.id}
              type="button"
              onClick={() => void openShelf(shelf.id)}
              className={cn(
                'rounded-[24px] border bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
                activeId === shelf.id ? 'border-blue-300 ring-4 ring-blue-100' : 'border-slate-200'
              )}
            >
              <div className="flex h-32 items-end gap-2 rounded-3xl bg-slate-50 p-4">
                {shelf.books.map((book, index) => <Cover key={`${book.id}-${index}`} book={book} className="h-24 w-16 rotate-[-3deg]" small />)}
                {shelf.books.length === 0 ? <span className="text-sm text-slate-400">暂无图书</span> : null}
              </div>
              <div className="mt-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="line-clamp-1 font-semibold text-slate-950">{shelf.name}</div>
                  <div className="mt-1 text-sm text-slate-500">{shelf.bookCount} 本 · {shelf.description || '自定义书架'}</div>
                </div>
                <MoreHorizontal size={18} className="shrink-0 text-slate-400" />
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
