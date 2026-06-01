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
type MetadataSuggestion = {
  id: string;
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  source: string;
  confidence: number;
  reason: string;
  status: string;
};
type JobDuplicate = {
  id: string;
  targetWorkId: string;
  reasons: string[];
  confidence: number;
  suggestedAction: string;
  status: string;
};
type OrganizeJob = {
  id: string;
  status: string;
  issueCodes: string[];
  summary: string | null;
  book: WorkView;
  suggestions: MetadataSuggestion[];
  duplicates: JobDuplicate[];
};
type PendingResponse = {
  ok: boolean;
  data?: { jobs?: OrganizeJob[]; books: WorkView[]; issues?: Record<string, Issue[]>; duplicates?: Duplicate[]; total: number };
  error?: { message: string };
};

const statusOptions = [
  { value: 'WANT', label: '未读' },
  { value: 'READING', label: '在读' },
  { value: 'FINISHED', label: '已读' }
];

const fieldLabels: Record<string, string> = {
  title: '标题',
  author: '作者',
  description: '简介',
  tags: '标签',
  seriesName: '系列',
  seriesIndex: '卷号',
  publishedYear: '出版年'
};

const sourceLabels: Record<string, string> = {
  embedded: '内嵌元数据',
  filename: '文件名',
  aggregation: '自动聚合',
  external: '外部数据源',
  ai: 'AI',
  rule: '规则'
};

function parseTags(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

export function OrganizePage() {
  const router = useRouter();
  const [books, setBooks] = useState<WorkView[]>([]);
  const [jobs, setJobs] = useState<OrganizeJob[]>([]);
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
    fetch('/api/organize/jobs?pageSize=100')
      .then((response) => response.json() as Promise<PendingResponse>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取待整理读物失败');
        const nextJobs = payload.data?.jobs ?? [];
        const nextBooks = nextJobs.length ? nextJobs.map((job) => job.book) : (payload.data?.books ?? []);
        setJobs(nextJobs);
        setBooks(nextBooks);
        setIssues(payload.data?.issues ?? Object.fromEntries(nextJobs.map((job) => [job.book.id, job.issueCodes.map((code) => ({ code, label: code.replace(/^SUGGEST_/, '建议补全 ') }))])));
        setDuplicates(payload.data?.duplicates ?? []);
        setSelectedIds((current) => current.filter((id) => nextBooks.some((book) => book.id === id)));
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
  const jobByBookId = useMemo(() => new Map(jobs.map((job) => [job.book.id, job])), [jobs]);

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

  async function applyJob(job: OrganizeJob, body: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/organize/jobs/${job.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '应用整理建议失败');
      setMessage(successMessage);
      loadPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '应用整理建议失败');
    } finally {
      setBusy(false);
    }
  }

  async function bulkApplyJobs(markOrganized: boolean) {
    const jobIds = selectedIds.map((id) => jobByBookId.get(id)?.id).filter((id): id is string => Boolean(id));
    if (jobIds.length === 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/organize/jobs/bulk-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds, highConfidenceOnly: true, markOrganized, addTags: parseTags(tagInput) })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '批量应用失败');
      setMessage(markOrganized ? '已应用高置信度建议并确认整理' : '已应用高置信度建议');
      setTagInput('');
      setSelectedIds([]);
      loadPending();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量应用失败');
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
          <Button disabled={busy || selectedIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void bulkApplyJobs(false)}>应用高置信度建议</Button>
          <Button disabled={busy || selectedIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void bulkApplyJobs(true)}>应用并确认</Button>
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
            {jobByBookId.get(book.id)?.suggestions.length ? (
              <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-2 text-xs text-slate-700">
                <div className="mb-1 font-medium text-blue-800">元数据建议</div>
                <div className="space-y-1">
                  {jobByBookId.get(book.id)!.suggestions.slice(0, 3).map((suggestion) => (
                    <div key={suggestion.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{fieldLabels[suggestion.field] ?? suggestion.field}：{formatSuggestionValue(suggestion.suggestedValue)}</span>
                      <Badge tone={suggestion.confidence >= 0.8 ? 'green' : 'slate'}>{Math.round(suggestion.confidence * 100)}%</Badge>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button className="px-2 py-1 text-xs" disabled={busy} variant="secondary" icon={CheckCircle2} onClick={() => void applyJob(jobByBookId.get(book.id)!, { highConfidenceOnly: true }, '已应用高置信度建议')}>应用</Button>
                  <Button className="px-2 py-1 text-xs" disabled={busy} variant="secondary" icon={CheckCircle2} onClick={() => void applyJob(jobByBookId.get(book.id)!, { highConfidenceOnly: true, markOrganized: true }, '已应用建议并确认整理')}>确认</Button>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  来源：{[...new Set(jobByBookId.get(book.id)!.suggestions.map((suggestion) => sourceLabels[suggestion.source] ?? suggestion.source))].join('、')}
                </div>
              </div>
            ) : null}
            {jobByBookId.get(book.id)?.duplicates.length ? (
              <button type="button" onClick={() => setDuplicateOpenFor(book.id)} className="w-full rounded-2xl border border-amber-100 bg-amber-50 p-2 text-left text-xs text-amber-800">
                {jobByBookId.get(book.id)!.duplicates.length} 条重复/版本候选
              </button>
            ) : null}
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
              {jobByBookId.get(duplicateOpenFor)?.duplicates.map((duplicate) => (
                <div key={duplicate.id} className="rounded-2xl border border-slate-200 p-4 text-sm">
                  <div className="font-semibold">候选读物：{duplicate.targetWorkId}</div>
                  <div className="mt-2 flex flex-wrap gap-1">{duplicate.reasons.map((reason) => <Badge key={reason} tone="amber">{reason}</Badge>)}</div>
                  <div className="mt-2 text-slate-500">建议动作：{duplicate.suggestedAction} · 置信度 {Math.round(duplicate.confidence * 100)}%</div>
                  <Button className="mt-3 px-3 py-2" variant="secondary" icon={CheckCircle2} onClick={() => void applyJob(jobByBookId.get(duplicateOpenFor)!, { duplicateIds: [duplicate.id] }, '已记录重复候选处理')}>标记已处理</Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatSuggestionValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
