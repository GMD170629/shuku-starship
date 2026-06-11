'use client';

import { CheckCircle2, Database, ExternalLink, RefreshCw, Save, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { PageTitle } from '../../components/ui/page-title';
import { MetadataLookupModal } from '../works/metadata-lookup-modal';
import { normalizeOrganizeJob, type OrganizeJobView } from './organize-page';

type JobResponse = {
  ok: boolean;
  data?: { job: OrganizeJobView };
  error?: { message: string };
};

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
  bangumi: 'Bangumi',
  douban: '豆瓣',
  ai: 'AI',
  rule: '规则'
};

const actionLabels: Record<string, string> = {
  MERGE_AS_VERSION: '合并为版本',
  MERGE_AS_VOLUME: '合并为卷册',
  HIDE_DUPLICATE: '隐藏重复项',
  KEEP_SEPARATE: '保持分开'
};

function valueLabel(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined || value === '') return '未填写';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function statusTone(complete: boolean, pendingSuggestion: boolean) {
  if (complete) return 'green';
  if (pendingSuggestion) return 'blue';
  return 'amber';
}

function metadataChecks(job: OrganizeJobView) {
  const book = job.book;
  const suggestionFields = new Set(job.suggestions.filter((suggestion) => suggestion.status === 'PENDING').map((suggestion) => suggestion.field));
  return [
    { key: 'title', label: '标题', complete: Boolean(book.title.trim()), pendingSuggestion: suggestionFields.has('title'), value: book.title },
    { key: 'author', label: '作者', complete: Boolean(book.author.trim() && book.author !== '未知作者'), pendingSuggestion: suggestionFields.has('author'), value: book.author },
    { key: 'cover', label: '封面', complete: Boolean(book.coverUrl && book.coverStatus === 'READY'), pendingSuggestion: false, value: book.coverStatus === 'READY' ? '已生成' : '缺少或待生成' },
    { key: 'seriesName', label: '系列', complete: Boolean(book.seriesName), pendingSuggestion: suggestionFields.has('seriesName'), value: book.seriesName },
    { key: 'seriesIndex', label: '卷号', complete: book.seriesIndex !== null, pendingSuggestion: suggestionFields.has('seriesIndex'), value: book.seriesIndex },
    { key: 'publishedYear', label: '出版年', complete: book.publishedYear !== null, pendingSuggestion: suggestionFields.has('publishedYear'), value: book.publishedYear },
    { key: 'tags', label: '标签', complete: book.tags.length > 0, pendingSuggestion: suggestionFields.has('tags'), value: book.tags },
    { key: 'description', label: '简介', complete: Boolean(book.desc && book.desc !== '暂无简介，可在详情页补充元数据。'), pendingSuggestion: suggestionFields.has('description'), value: book.desc },
    { key: 'duplicates', label: '重复/版本风险', complete: job.duplicates.length === 0, pendingSuggestion: job.duplicates.length > 0, value: job.duplicates.length ? `${job.duplicates.length} 条候选` : '未发现' }
  ];
}

export function OrganizeJobDetailPage({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [job, setJob] = useState<OrganizeJobView | null>(null);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [metadataLookupOpen, setMetadataLookupOpen] = useState(false);

  const loadJob = useCallback(() => {
    setLoading(true);
    fetch(`/api/organize/jobs/${jobId}`)
      .then((response) => response.json() as Promise<JobResponse>)
      .then((payload) => {
        if (!payload.ok || !payload.data?.job) throw new Error(payload.error?.message ?? '读取整理任务失败');
        const nextJob = normalizeOrganizeJob(payload.data.job);
        if (!nextJob) throw new Error('整理任务缺少读物信息');
        setJob(nextJob);
        setSelectedSuggestionIds((current) => current.filter((id) => nextJob.suggestions.some((suggestion) => suggestion.id === id && suggestion.status === 'PENDING')));
        setError('');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '读取整理任务失败'))
      .finally(() => setLoading(false));
  }, [jobId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  const pendingSuggestions = useMemo(() => job?.suggestions.filter((suggestion) => suggestion.status === 'PENDING') ?? [], [job]);
  const allSuggestionsSelected = pendingSuggestions.length > 0 && pendingSuggestions.every((suggestion) => selectedSuggestionIds.includes(suggestion.id));
  const checks = useMemo(() => (job ? metadataChecks(job) : []), [job]);

  function setSuggestionSelected(suggestionId: string, selected: boolean) {
    setSelectedSuggestionIds((current) => (selected ? [...new Set([...current, suggestionId])] : current.filter((id) => id !== suggestionId)));
  }

  async function apply(body: Record<string, unknown>, successMessage: string) {
    if (!job) return;
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
      if (!payload.ok) throw new Error(payload.error?.message ?? '整理操作失败');
      setMessage(successMessage);
      setSelectedSuggestionIds([]);
      loadJob();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '整理操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取整理任务...</div>;
  if (!job) return <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error || '整理任务不存在'}</div>;

  return (
    <div className="space-y-6">
      <PageTitle
        title="整理详情"
        desc="查看当前读物缺少哪些信息，并审核元数据候选和重复/版本风险。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} variant="secondary" icon={Database} onClick={() => setMetadataLookupOpen(true)}>元数据识别</Button>
            <Button variant="secondary" icon={RefreshCw} onClick={loadJob}>刷新</Button>
          </div>
        }
      />

      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex gap-4">
            <Cover book={job.book} className="h-40 w-28" />
            <div className="min-w-0">
              <h2 className="line-clamp-2 text-lg font-semibold text-slate-900">{job.book.title}</h2>
              <p className="mt-1 text-sm text-slate-500">{job.book.author} · {job.book.format}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge tone="amber">待整理</Badge>
                <Badge tone={job.book.metadataQuality >= 80 ? 'green' : 'blue'}>质量 {job.book.metadataQuality}</Badge>
              </div>
            </div>
          </div>
          <dl className="mt-5 space-y-3 text-sm">
            <div><dt className="text-slate-500">文件路径</dt><dd className="mt-1 break-all text-slate-800">{job.book.path || '未记录'}</dd></div>
            <div><dt className="text-slate-500">导入时间</dt><dd className="mt-1 text-slate-800">{new Date(job.book.importedAt).toLocaleString()}</dd></div>
            <div><dt className="text-slate-500">任务更新时间</dt><dd className="mt-1 text-slate-800">{new Date(job.updatedAt).toLocaleString()}</dd></div>
            <div><dt className="text-slate-500">整理摘要</dt><dd className="mt-1 text-slate-800">{job.summary ?? '等待整理确认'}</dd></div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="secondary" icon={ExternalLink} onClick={() => router.push(`/works/${job.book.id}`)}>打开读物详情</Button>
            <Button disabled={busy} variant="ghost" icon={XCircle} onClick={() => void apply({ dismiss: true }, '已忽略整理任务')}>忽略任务</Button>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">缺失信息</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {checks.map((check) => (
              <div key={check.key} className="rounded-2xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{check.label}</span>
                  <Badge tone={statusTone(check.complete, check.pendingSuggestion)}>{check.complete ? '已有' : check.pendingSuggestion ? '可补全' : '缺失'}</Badge>
                </div>
                <div className="mt-2 line-clamp-2 text-xs text-slate-500">{valueLabel(check.value)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">元数据建议</h2>
            <p className="mt-1 text-sm text-slate-500">勾选要应用的候选字段，或直接应用高置信度建议。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || selectedSuggestionIds.length === 0} variant="secondary" icon={Save} onClick={() => void apply({ suggestionIds: selectedSuggestionIds }, '已应用所选建议')}>应用所选</Button>
            <Button disabled={busy || pendingSuggestions.length === 0} variant="secondary" icon={CheckCircle2} onClick={() => void apply({ highConfidenceOnly: true }, '已应用高置信度建议')}>应用高置信度</Button>
            <Button disabled={busy} icon={CheckCircle2} onClick={() => void apply({ highConfidenceOnly: true, markOrganized: true }, '已应用建议并确认整理')}>应用并确认</Button>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="w-12 p-3">
                  <input type="checkbox" checked={allSuggestionsSelected} onChange={(event) => setSelectedSuggestionIds(event.target.checked ? pendingSuggestions.map((suggestion) => suggestion.id) : [])} className="h-4 w-4 accent-blue-600" />
                </th>
                <th>字段</th>
                <th>当前值</th>
                <th>建议值</th>
                <th>来源</th>
                <th>置信度</th>
                <th className="pr-3">原因</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pendingSuggestions.map((suggestion) => (
                <tr key={suggestion.id}>
                  <td className="p-3">
                    <input type="checkbox" checked={selectedSuggestionIds.includes(suggestion.id)} onChange={(event) => setSuggestionSelected(suggestion.id, event.target.checked)} className="h-4 w-4 accent-blue-600" />
                  </td>
                  <td className="font-medium text-slate-800">{fieldLabels[suggestion.field] ?? suggestion.field}</td>
                  <td className="max-w-[220px] truncate text-slate-500">{valueLabel(suggestion.currentValue)}</td>
                  <td className="max-w-[260px] truncate text-slate-900">{valueLabel(suggestion.suggestedValue)}</td>
                  <td><Badge tone="blue">{sourceLabels[suggestion.source] ?? suggestion.source}</Badge></td>
                  <td><Badge tone={suggestion.confidence >= 0.8 ? 'green' : 'slate'}>{Math.round(suggestion.confidence * 100)}%</Badge></td>
                  <td className="max-w-[260px] pr-3 text-slate-500">{suggestion.reason}</td>
                </tr>
              ))}
              {pendingSuggestions.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-sm text-slate-500">暂无待应用的元数据建议。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">重复/版本候选</h2>
        <div className="mt-4 space-y-3">
          {job.duplicates.map((duplicate) => (
            <div key={duplicate.id} className="rounded-2xl border border-slate-200 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="font-semibold">候选读物：{duplicate.targetWorkId}</div>
                <div className="flex gap-2">
                  <Badge tone={duplicate.confidence >= 0.8 ? 'green' : 'amber'}>{Math.round(duplicate.confidence * 100)}%</Badge>
                  <Badge tone="blue">{actionLabels[duplicate.suggestedAction] ?? duplicate.suggestedAction}</Badge>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {duplicate.reasons.map((reason) => <Badge key={reason} tone="amber">{reason}</Badge>)}
              </div>
            </div>
          ))}
          {job.duplicates.length === 0 ? <div className="rounded-2xl border border-slate-200 p-6 text-sm text-slate-500">暂无重复或不同版本候选。</div> : null}
        </div>
      </section>
      {job ? (
        <MetadataLookupModal
          book={job.book}
          open={metadataLookupOpen}
          onClose={() => setMetadataLookupOpen(false)}
          onApplied={() => {
            setMessage('元数据已应用');
            loadJob();
          }}
        />
      ) : null}
    </div>
  );
}
