'use client';

import { CheckCircle2, Eye, EyeOff, RefreshCw, Tags } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { PageTitle } from '../../components/ui/page-title';
import type { WorkView } from '../../types/work';

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

export type OrganizeJobView = {
  id: string;
  status: string;
  issueCodes: string[];
  summary: string | null;
  errorSummary?: string | null;
  updatedAt: string;
  book: WorkView;
  suggestions: MetadataSuggestion[];
  duplicates: JobDuplicate[];
};

type JobsResponse = {
  ok: boolean;
  data?: { jobs: OrganizeJobView[]; books: WorkView[]; total: number };
  error?: { message: string };
};

export function normalizeOrganizeJob(job: OrganizeJobView): OrganizeJobView | null {
  if (!job?.book) return null;
  return {
    ...job,
    issueCodes: Array.isArray(job.issueCodes) ? job.issueCodes : [],
    suggestions: Array.isArray(job.suggestions) ? job.suggestions : [],
    duplicates: Array.isArray(job.duplicates) ? job.duplicates : [],
    book: {
      ...job.book,
      title: job.book.title ?? '未命名作品',
      author: job.book.author ?? '未知作者',
      tags: Array.isArray(job.book.tags) ? job.book.tags : []
    }
  };
}

function parseTags(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

function issueLabel(code: string) {
  if (code === 'NEW_IMPORT') return '新导入';
  if (code === 'DUPLICATE') return '疑似重复';
  if (code === 'MISSING_COVER') return '缺少封面';
  if (code === 'MISSING_AUTHOR') return '缺少作者';
  if (code === 'ODD_TITLE') return '标题异常';
  if (code === 'IMPORT_FAILED') return '解析失败';
  return code.replace(/^SUGGEST_/, '建议补全 ');
}

function primaryIssue(job: OrganizeJobView) {
  if (job.duplicates.length > 0) return '存在重复/版本候选';
  if (job.issueCodes.includes('IMPORT_FAILED')) return '解析失败';
  if (job.issueCodes.includes('MISSING_COVER')) return '缺少封面';
  if (job.issueCodes.includes('MISSING_AUTHOR')) return '缺少作者';
  const suggested = job.issueCodes.find((code) => code.startsWith('SUGGEST_'));
  if (suggested) return issueLabel(suggested);
  if (job.issueCodes.includes('NEW_IMPORT')) return '新导入待确认';
  return job.summary ?? '等待整理确认';
}

function missingLabels(job: OrganizeJobView) {
  const labels: string[] = [];
  const book = job.book;
  const suggestionFields = new Set(job.suggestions.map((suggestion) => suggestion.field));
  if (!book.title.trim()) labels.push('标题');
  if (!book.author.trim() || book.author === '未知作者') labels.push('作者');
  if (!book.coverUrl || book.coverStatus !== 'READY') labels.push('封面');
  if (!book.seriesName && suggestionFields.has('seriesName')) labels.push('系列');
  if (book.seriesIndex === null && suggestionFields.has('seriesIndex')) labels.push('卷号');
  if (book.publishedYear === null && suggestionFields.has('publishedYear')) labels.push('出版年');
  if (book.tags.length === 0 || suggestionFields.has('tags')) labels.push('标签');
  if (!book.desc || book.desc === '暂无简介，可在详情页补充元数据。' || suggestionFields.has('description')) labels.push('简介');
  if (job.duplicates.length > 0) labels.push('重复/版本');
  return [...new Set(labels)];
}

export function OrganizePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OrganizeJobView[]>([]);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadJobs = useCallback(() => {
    setLoading(true);
    fetch('/api/organize/jobs?pageSize=100')
      .then((response) => response.json() as Promise<JobsResponse>)
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error?.message ?? '读取待整理任务失败');
        const nextJobs = (payload.data?.jobs ?? [])
          .map((job) => normalizeOrganizeJob(job))
          .filter((job): job is OrganizeJobView => job !== null);
        setJobs(nextJobs);
        setSelectedJobIds((current) => current.filter((id) => nextJobs.some((job) => job.id === id)));
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取待整理任务失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const selectedJobs = useMemo(() => jobs.filter((job) => selectedJobIds.includes(job.id)), [jobs, selectedJobIds]);
  const selectedBookIds = useMemo(() => selectedJobs.map((job) => job.book.id), [selectedJobs]);
  const allSelected = jobs.length > 0 && jobs.every((job) => selectedJobIds.includes(job.id));
  const issueSummary = useMemo(() => ({
    missingMetadata: jobs.filter((job) => missingLabels(job).some((label) => !['封面', '重复/版本'].includes(label))).length,
    duplicates: jobs.filter((job) => job.duplicates.length > 0).length,
    missingCover: jobs.filter((job) => !job.book.coverUrl || job.book.coverStatus !== 'READY').length,
    newImports: jobs.filter((job) => job.issueCodes.includes('NEW_IMPORT')).length
  }), [jobs]);

  function setSelected(jobId: string, selected: boolean) {
    setSelectedJobIds((current) => (selected ? [...new Set([...current, jobId])] : current.filter((id) => id !== jobId)));
  }

  async function performBulkWork(body: Record<string, unknown>, successMessage: string, confirmText?: string) {
    if (selectedBookIds.length === 0) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/works/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedBookIds, ...body })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '批量操作失败');
      setMessage(successMessage);
      setSelectedJobIds([]);
      setTagInput('');
      loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyJob(job: OrganizeJobView, body: Record<string, unknown>, successMessage: string) {
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
      loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '应用整理建议失败');
    } finally {
      setBusy(false);
    }
  }

  async function bulkApplyJobs(markOrganized: boolean) {
    if (selectedJobIds.length === 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/organize/jobs/bulk-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: selectedJobIds, highConfidenceOnly: true, markOrganized, addTags: parseTags(tagInput) })
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '批量应用失败');
      setMessage(markOrganized ? '已应用高置信度建议并确认整理' : '已应用高置信度建议');
      setSelectedJobIds([]);
      setTagInput('');
      loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批量应用失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="待整理"
        desc="按整理任务逐行处理新导入、元数据缺失、候选建议和重复/版本风险。"
        action={<Button variant="secondary" icon={RefreshCw} onClick={loadJobs}>刷新</Button>}
      />

      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['缺元数据', issueSummary.missingMetadata],
          ['疑似重复', issueSummary.duplicates],
          ['缺封面', issueSummary.missingCover],
          ['待确认卷册', issueSummary.newImports]
        ].map(([label, value]) => (
          <div key={label} className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2 text-slate-600">
            <input type="checkbox" checked={allSelected} onChange={(event) => setSelectedJobIds(event.target.checked ? jobs.map((job) => job.id) : [])} className="h-4 w-4 accent-blue-600" />
            全选当前列表
          </label>
          <span className="text-slate-500">已选择 {selectedJobIds.length} 条任务</span>
          <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="标签，用逗号分隔" className="h-10 min-w-[220px] flex-1 rounded-2xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-300" />
          <Button disabled={busy || selectedBookIds.length === 0 || parseTags(tagInput).length === 0} variant="secondary" icon={Tags} onClick={() => void performBulkWork({ addTags: parseTags(tagInput) }, '标签已添加')}>添加标签</Button>
          <Button disabled={busy || selectedJobIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void bulkApplyJobs(false)}>应用建议</Button>
          <Button disabled={busy || selectedJobIds.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void bulkApplyJobs(true)}>应用建议并完成</Button>
          <Button disabled={busy || selectedBookIds.length === 0} variant="danger" icon={EyeOff} onClick={() => void performBulkWork({ ignored: true }, '已隐藏，源文件未删除', `确认隐藏 ${selectedBookIds.length} 本读物吗？`)}>隐藏</Button>
        </div>
      </div>

      {loading ? <div className="shuku-loading-panel p-8 text-sm" role="status" aria-live="polite">正在读取待整理任务...</div> : null}
      {!loading && jobs.length === 0 ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无待整理任务。</div> : null}

      {!loading && jobs.length > 0 ? (
        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="w-12 p-4">选择</th>
                <th className="p-4">读物</th>
                <th>主要问题</th>
                <th>待补字段</th>
                <th>候选</th>
                <th>更新时间</th>
                <th className="pr-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((job) => {
                const missing = missingLabels(job);
                return (
                  <tr key={job.id} className="hover:bg-slate-50">
                    <td className="p-4">
                      <input
                        type="checkbox"
                        checked={selectedJobIds.includes(job.id)}
                        onChange={(event) => setSelected(job.id, event.target.checked)}
                        className="h-4 w-4 accent-blue-600"
                        aria-label={`选择 ${job.book.title}`}
                      />
                    </td>
                    <td className="p-4">
                      <button type="button" onClick={() => router.push(`/organize/jobs/${job.id}`)} className="flex min-w-[260px] items-center gap-3 text-left">
                        <Cover book={job.book} className="h-14 w-10 rounded-xl" small />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-slate-900">{job.book.title}</span>
                          <span className="mt-1 block truncate text-xs text-slate-500">{job.book.author} · {job.book.format}</span>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Badge tone={job.status === 'FAILED' || job.issueCodes.includes('IMPORT_FAILED') ? 'red' : job.duplicates.length ? 'amber' : 'blue'}>{primaryIssue(job)}</Badge>
                    </td>
                    <td>
                      <div className="flex max-w-[220px] items-center gap-2 text-slate-600">
                        <span>{missing.length ? `${missing.length} 项` : '无'}</span>
                        {missing.slice(0, 2).map((item) => <Badge key={item} tone="slate">{item}</Badge>)}
                      </div>
                    </td>
                    <td>
                      <div className="flex gap-2 text-slate-600">
                        <Badge tone={job.suggestions.length ? 'blue' : 'slate'}>{job.suggestions.length} 建议</Badge>
                        {job.duplicates.length ? <Badge tone="amber">{job.duplicates.length} 重复</Badge> : null}
                      </div>
                    </td>
                    <td className="text-slate-500">{new Date(job.updatedAt).toLocaleString()}</td>
                    <td className="pr-4">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" icon={Eye} className="min-h-9 px-3 py-2" onClick={() => router.push(`/organize/jobs/${job.id}`)}>详情</Button>
                        <Button disabled={busy} variant="secondary" icon={CheckCircle2} className="min-h-9 px-3 py-2" onClick={() => void applyJob(job, { highConfidenceOnly: true, markOrganized: true }, '已应用建议并确认整理')}>确认整理</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
