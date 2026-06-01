'use client';

import { CheckCircle2, EyeOff, RefreshCw, Tags, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookCard } from '../../components/book/book-card';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { PageTitle } from '../../components/ui/page-title';
import { Select } from '../../components/ui/select';
import type { WorkView } from '../../lib/books';

type Issue = { code: string; label: string };
type Duplicate = { bookId: string; otherBookId: string; reasons: Array<{ code: string; label: string }> };
type PendingResponse = {
  ok: boolean;
  data?: { books: WorkView[]; issues: Record<string, Issue[]>; duplicates: Duplicate[]; total: number };
  error?: { message: string };
};

const statusOptions = [
  { value: 'WANT', label: '未读' },
  { value: 'READING', label: '在读' },
  { value: 'FINISHED', label: '已读' }
];

function parseTags(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

export function OrganizePage() {
  const router = useRouter();
  const [books, setBooks] = useState<WorkView[]>([]);
  const [issues, setIssues] = useState<Record<string, Issue[]>>({});
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [status, setStatus] = useState('READING');
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [duplicateOpenFor, setDuplicateOpenFor] = useState<string | null>(null);

  const loadPending = useCallback(() => {
    setLoading(true);
    fetch('/api/organize/pending?pageSize=100')
      .then((response) => response.json() as Promise<PendingResponse>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取待整理读物失败');
        setBooks(payload.data?.books ?? []);
        setIssues(payload.data?.issues ?? {});
        setDuplicates(payload.data?.duplicates ?? []);
        setSelectedIds((current) => current.filter((id) => (payload.data?.books ?? []).some((book) => book.id === id)));
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取待整理读物失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  const allSelected = books.length > 0 && books.every((book) => selectedIds.includes(book.id));
  const duplicateForOpenBook = useMemo(() => {
    if (!duplicateOpenFor) return [];
    return duplicates.filter((item) => item.bookId === duplicateOpenFor || item.otherBookId === duplicateOpenFor);
  }, [duplicateOpenFor, duplicates]);

  function setSelected(bookId: string, selected: boolean) {
    setSelectedIds((current) => (selected ? [...new Set([...current, bookId])] : current.filter((id) => id !== bookId)));
  }

  async function performBulk(body: Record<string, unknown>, successMessage: string, confirmText?: string) {
    if (selectedIds.length === 0) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/works/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds, ...body })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '批量操作失败');
      setMessage(successMessage);
      setTagInput('');
      setSelectedIds([]);
      loadPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function hideOne(book: WorkView) {
    if (!window.confirm(`确认隐藏「${book.title}」吗？不会删除源文件。`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/works/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [book.id], ignored: true })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '隐藏失败');
      setMessage('已隐藏重复记录，源文件未删除');
      setDuplicateOpenFor(null);
      loadPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '隐藏失败');
    } finally {
      setBusy(false);
    }
  }

  function otherBook(match: Duplicate) {
    const otherId = match.bookId === duplicateOpenFor ? match.otherBookId : match.bookId;
    return books.find((book) => book.id === otherId);
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="待整理"
        desc="集中处理新导入、缺封面、元数据异常、解析失败和疑似重复的读物。"
        action={<Button variant="secondary" icon={RefreshCw} onClick={loadPending}>刷新</Button>}
      />
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2 text-slate-600">
            <input type="checkbox" checked={allSelected} onChange={(event) => setSelectedIds(event.target.checked ? books.map((book) => book.id) : [])} className="h-4 w-4 accent-blue-600" />
            全选当前列表
          </label>
          <span className="text-slate-500">已选择 {selectedIds.length} 本</span>
          <Select value={status} options={statusOptions} onChange={setStatus} ariaLabel="阅读状态" size="sm" />
          <Button disabled={busy || selectedIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void performBulk({ status }, '阅读状态已更新')}>设置状态</Button>
          <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="标签，用逗号分隔" className="h-10 min-w-[220px] flex-1 rounded-2xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-300" />
          <Button disabled={busy || selectedIds.length === 0 || parseTags(tagInput).length === 0} variant="secondary" icon={Tags} onClick={() => void performBulk({ addTags: parseTags(tagInput) }, '标签已添加')}>添加标签</Button>
          <Button disabled={busy || selectedIds.length === 0 || parseTags(tagInput).length === 0} variant="secondary" icon={Tags} onClick={() => void performBulk({ removeTags: parseTags(tagInput) }, '标签已移除')}>移除标签</Button>
          <Button disabled={busy || selectedIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void performBulk({ markOrganized: true }, '已标记为整理完成')}>确认整理</Button>
          <Button disabled={busy || selectedIds.length === 0} variant="danger" icon={EyeOff} onClick={() => void performBulk({ ignored: true }, '已隐藏，源文件未删除', `确认隐藏 ${selectedIds.length} 本读物吗？`)}>隐藏</Button>
          <Button disabled={busy || selectedIds.length === 0} variant="danger" icon={Trash2} onClick={() => void performBulk({ deleteRecords: true }, '数据库记录已删除，源文件未删除', `确认删除 ${selectedIds.length} 条数据库记录吗？NAS 源文件不会被删除。`)}>删除记录</Button>
        </div>
      </div>

      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取待整理读物...</div> : null}
      {!loading && books.length === 0 ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无待整理读物。</div> : null}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,220px))] gap-4">
        {books.map((book) => (
          <div key={book.id} className="space-y-2">
            <BookCard book={book} selectionEnabled selected={selectedIds.includes(book.id)} onSelectedChange={(checked) => setSelected(book.id, checked)} onClick={() => router.push(`/works/${book.id}`)} />
            <div className="flex flex-wrap gap-1.5">
              {(issues[book.id] ?? []).map((issue) => (
                <button key={issue.code} type="button" onClick={() => issue.code === 'DUPLICATE' ? setDuplicateOpenFor(book.id) : undefined}>
                  <Badge tone={issue.code === 'IMPORT_FAILED' ? 'red' : issue.code === 'DUPLICATE' ? 'amber' : 'slate'}>{issue.label}</Badge>
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500">{book.format} · 导入 {new Date(book.importedAt).toLocaleString()}</div>
          </div>
        ))}
      </div>

      {duplicateOpenFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4">
          <div className="w-full max-w-3xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">疑似重复对比</h2>
                <p className="mt-1 text-sm text-slate-500">可隐藏其中一条记录，不会自动删除源文件。</p>
              </div>
              <Button variant="ghost" icon={X} onClick={() => setDuplicateOpenFor(null)} />
            </div>
            <div className="mt-5 space-y-3">
              {duplicateForOpenBook.map((match) => {
                const current = books.find((book) => book.id === duplicateOpenFor);
                const other = otherBook(match);
                if (!current || !other) return null;
                return (
                  <div key={`${match.bookId}-${match.otherBookId}`} className="grid gap-4 rounded-2xl border border-slate-200 p-4 md:grid-cols-2">
                    {[current, other].map((book) => (
                      <div key={book.id} className="flex gap-3">
                        <Cover book={book} className="h-32 w-20" />
                        <div className="min-w-0 text-sm">
                          <div className="font-semibold">{book.title}</div>
                          <div className="mt-1 text-slate-500">{book.author} · {book.format} · {book.size}</div>
                          <div className="mt-2 flex flex-wrap gap-1">{match.reasons.map((reason) => <Badge key={reason.code} tone="amber">{reason.label}</Badge>)}</div>
                          <Button className="mt-3 px-3 py-2" variant="danger" icon={EyeOff} onClick={() => void hideOne(book)}>隐藏此记录</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
