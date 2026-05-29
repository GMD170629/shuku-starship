'use client';

import { CheckCircle2, Copy, FileText, RefreshCw, Tags, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import type { BookView } from '../../lib/books';

type BooksResponse = {
  ok: boolean;
  data?: { books: BookView[] };
  error?: { message: string };
};

type BookResponse = {
  ok: boolean;
  data?: { book: BookView; mergedBookId?: string };
  error?: { message: string };
};

type MetaFormState = {
  title: string;
  author: string;
  format: string;
  tags: string;
  path: string;
};

const emptyForm: MetaFormState = {
  title: '',
  author: '',
  format: '',
  tags: '',
  path: ''
};

function formFromBook(book: BookView | null): MetaFormState {
  if (!book) return emptyForm;
  return {
    title: book.title,
    author: book.author === '未知作者' ? '' : book.author,
    format: book.format,
    tags: book.tags.join(', '),
    path: book.path
  };
}

function parseTags(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

function MetaForm({
  form,
  disabled,
  onChange
}: {
  form: MetaFormState;
  disabled: boolean;
  onChange: (field: keyof MetaFormState, value: string) => void;
}) {
  const fields: Array<{ label: string; field: keyof MetaFormState; readOnly?: boolean }> = [
    { label: '标题', field: 'title' },
    { label: '作者', field: 'author' },
    { label: '类型', field: 'format' },
    { label: '标签', field: 'tags' },
    { label: '源路径', field: 'path', readOnly: true }
  ];

  return (
    <div className="mt-5 space-y-4">
      {fields.map(({ label, field, readOnly }) => (
        <label key={label} className="block">
          <span className="text-sm text-slate-500">{label}</span>
          <input
            value={form[field]}
            readOnly={readOnly}
            disabled={disabled && !readOnly}
            onChange={(event) => onChange(field, event.target.value)}
            className={cn(
              'mt-2 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none focus:border-blue-500',
              readOnly ? 'bg-slate-50 text-slate-500' : ''
            )}
          />
        </label>
      ))}
    </div>
  );
}

export function OrganizePage() {
  const [books, setBooks] = useState<BookView[]>([]);
  const [selected, setSelected] = useState<BookView | null>(null);
  const [form, setForm] = useState<MetaFormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<BookView[]>([]);
  const [mergeLoading, setMergeLoading] = useState(false);

  const loadBooks = useCallback(() => {
    setLoading(true);
    fetch('/api/books?visibility=active&pageSize=30&sort=created')
      .then((response) => response.json() as Promise<BooksResponse>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取待整理读物失败');
        const nextBooks = payload.data?.books ?? [];
        setBooks(nextBooks);
        setSelected((current) => nextBooks.find((book) => book.id === current?.id) ?? nextBooks[0] ?? null);
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取待整理读物失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    setForm(formFromBook(selected));
  }, [selected]);

  const mergeQuery = useMemo(() => mergeSearch.trim(), [mergeSearch]);

  useEffect(() => {
    if (!mergeOpen || !selected) return;
    let active = true;
    setMergeLoading(true);
    const params = new URLSearchParams({ visibility: 'active', pageSize: '12', sort: 'title' });
    if (mergeQuery) params.set('search', mergeQuery);
    fetch(`/api/books?${params}`)
      .then((response) => response.json() as Promise<BooksResponse>)
      .then((payload) => {
        if (!active) return;
        if (!payload.ok) throw new Error(payload.error?.message ?? '搜索读物失败');
        const candidates = (payload.data?.books ?? []).filter(
          (book) => book.id !== selected.id && book.monitorFolderId === selected.monitorFolderId
        );
        setMergeCandidates(candidates);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : '搜索读物失败'))
      .finally(() => active && setMergeLoading(false));
    return () => {
      active = false;
    };
  }, [mergeOpen, mergeQuery, selected]);

  function selectBook(book: BookView) {
    setMessage('');
    setError('');
    setSelected(book);
  }

  function updateSelectedBook(book: BookView) {
    setBooks((current) => current.map((item) => (item.id === book.id ? book : item)));
    setSelected(book);
  }

  function removeSelectedBook(bookId: string) {
    setBooks((current) => {
      const index = current.findIndex((book) => book.id === bookId);
      const nextBooks = current.filter((book) => book.id !== bookId);
      setSelected(nextBooks[index] ?? nextBooks[index - 1] ?? nextBooks[0] ?? null);
      return nextBooks;
    });
  }

  async function patchSelected(body: Record<string, unknown>, successMessage: string) {
    if (!selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/books/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as BookResponse;
      if (!payload.ok || !payload.data?.book) throw new Error(payload.error?.message ?? '操作失败');
      updateSelectedBook(payload.data.book);
      setMessage(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveMetadata() {
    await patchSelected(
      {
        title: form.title,
        author: form.author,
        format: form.format,
        tags: parseTags(form.tags)
      },
      '识别信息已保存'
    );
  }

  async function addTags() {
    if (!selected) return;
    const tags = [...new Set([...selected.tags, ...parseTags(form.tags)])];
    await patchSelected({ tags }, '标签已添加');
  }

  async function ignoreSelected() {
    if (!selected) return;
    if (!window.confirm(`确认忽略「${selected.title}」吗？读物会从待整理列表隐藏，但不会删除文件。`)) return;
    const ignoredId = selected.id;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/books/${ignoredId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignored: true })
      });
      const payload = (await response.json()) as BookResponse;
      if (!payload.ok) throw new Error(payload.error?.message ?? '忽略失败');
      removeSelectedBook(ignoredId);
      setMessage('读物已忽略');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '忽略失败');
    } finally {
      setBusy(false);
    }
  }

  async function mergeBook(sourceBookId: string) {
    if (!selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/books/${selected.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceBookId })
      });
      const payload = (await response.json()) as BookResponse;
      if (!payload.ok || !payload.data?.book || !payload.data.mergedBookId) {
        throw new Error(payload.error?.message ?? '合并分卷失败');
      }
      const mergedBook = payload.data.book;
      const mergedBookId = payload.data.mergedBookId;
      setBooks((current) => current.filter((book) => book.id !== mergedBookId).map((book) => (book.id === mergedBook.id ? mergedBook : book)));
      setSelected(mergedBook);
      setMergeOpen(false);
      setMergeSearch('');
      setMessage('分卷已合并');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '合并分卷失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="待整理" desc="处理新扫描、识别失败、重复和缺少元数据的读物。" action={<Button icon={RefreshCw}>批量重新识别</Button>} />
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      <div className="grid h-[720px] grid-cols-12 gap-5">
        <div className="col-span-3 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex gap-2 overflow-x-auto pb-3">
            {['待识别', '识别失败', '疑似重复', '缺少封面'].map((item, index) => (
              <Badge key={item} tone={index === 1 ? 'red' : index === 2 ? 'amber' : 'slate'}>{item}</Badge>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {books.map((book) => (
              <button key={book.id} onClick={() => selectBook(book)} className={cn('w-full rounded-2xl border p-3 text-left text-sm', selected?.id === book.id ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white')}>
                <div className="font-medium">{book.title}</div>
                <div className="mt-1 text-xs text-slate-500">{book.ignored ? '已忽略' : book.coverStatus === 'FAILED' ? '缺少封面' : '来自扫描'}</div>
              </button>
            ))}
            {loading ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">正在读取待整理读物...</div> : null}
            {!loading && books.length === 0 ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">暂无待整理读物。</div> : null}
          </div>
        </div>
        <div className="col-span-5 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">文件预览</h2>
          <div className="mt-5 flex h-[580px] items-center justify-center rounded-3xl bg-slate-100">
            <div className="w-64 rounded-[28px] bg-gradient-to-br from-slate-400 to-slate-700 p-8 text-white shadow-xl">
              <FileText size={42} />
              <div className="mt-20 text-2xl font-semibold">{selected?.title ?? '暂无读物'}</div>
              <div className="mt-2 text-sm text-white/70">{selected ? `${selected.format} · ${selected.size}` : '请先扫描真实目录'}</div>
            </div>
          </div>
        </div>
        <div className="col-span-4 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">元数据编辑</h2>
          <MetaForm form={form} disabled={!selected || busy} onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))} />
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button disabled={!selected || busy} icon={CheckCircle2} onClick={saveMetadata}>保存识别</Button>
            <Button disabled={!selected || busy} variant="secondary" icon={Copy} onClick={() => setMergeOpen(true)}>合并分卷</Button>
            <Button disabled={!selected || busy || parseTags(form.tags).length === 0} variant="secondary" icon={Tags} onClick={addTags}>添加标签</Button>
            <Button disabled={!selected || busy} variant="danger" icon={X} onClick={ignoreSelected}>忽略文件</Button>
          </div>
        </div>
      </div>
      {mergeOpen && selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-6">
          <div className="w-full max-w-xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold">合并分卷</h2>
                <p className="mt-1 text-sm text-slate-500">选择要合并进「{selected.title}」的来源读物。</p>
              </div>
              <Button variant="ghost" icon={X} onClick={() => setMergeOpen(false)} />
            </div>
            <input
              value={mergeSearch}
              onChange={(event) => setMergeSearch(event.target.value)}
              placeholder="搜索标题、作者、标签、文件路径..."
              className="mt-5 h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm outline-none focus:border-blue-500"
            />
            <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              {mergeLoading ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">正在搜索...</div> : null}
              {!mergeLoading && mergeCandidates.length === 0 ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">没有可合并的同目录读物。</div> : null}
              {mergeCandidates.map((book) => (
                <button
                  key={book.id}
                  disabled={busy}
                  onClick={() => mergeBook(book.id)}
                  className="w-full rounded-2xl border border-slate-200 p-4 text-left text-sm hover:border-blue-200 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="font-medium text-slate-900">{book.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{book.author} · {book.format} · {book.size}</div>
                  <div className="mt-1 truncate text-xs text-slate-400">{book.path}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
