'use client';

import { CheckCircle2, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { Select } from '../../components/ui/select';
import type { WorkView } from '../../types/work';

type MetadataSource = 'bangumi' | 'douban' | 'ai';
type MetadataField = 'coverUrl' | 'title' | 'author' | 'publisher' | 'description' | 'tags' | 'seriesName' | 'seriesIndex' | 'publishedYear';

type MetadataCandidate = {
  id: string;
  source: MetadataSource;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
  description?: string | null;
  tags?: string[];
  seriesName?: string | null;
  seriesIndex?: number | null;
  publishedYear?: number | null;
  coverUrl?: string | null;
  confidence: number;
  raw: unknown;
};

type MetadataLookupModalProps = {
  book: WorkView;
  open: boolean;
  onClose: () => void;
  onApplied: (book?: WorkView | null) => void;
};

const fieldLabels: Record<MetadataField, string> = {
  coverUrl: '封面',
  title: '标题',
  author: '作者',
  publisher: '出版社',
  description: '简介',
  tags: '标签',
  seriesName: '系列',
  seriesIndex: '卷号',
  publishedYear: '出版年'
};

const fields: MetadataField[] = ['coverUrl', 'title', 'author', 'publisher', 'description', 'tags', 'seriesName', 'seriesIndex', 'publishedYear'];

function valueLabel(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined || value === '') return '未填写';
  return String(value);
}

function normalized(value: unknown) {
  return valueLabel(value).toLowerCase().replace(/[\s_\-.()[\]（）【】《》:：,，]+/g, '');
}

function candidateValue(candidate: MetadataCandidate | null, field: MetadataField) {
  if (!candidate) return null;
  return candidate[field];
}

function bookValue(book: WorkView, field: MetadataField) {
  if (field === 'coverUrl') return book.coverStatus === 'READY' ? book.coverUrl : null;
  if (field === 'author') return book.author === '未知作者' ? null : book.author;
  if (field === 'description') return book.desc === '暂无简介，可在详情页补充元数据。' ? null : book.desc;
  if (field === 'tags') return book.tags;
  return book[field];
}

function hasCandidateValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

function isCoverField(field: MetadataField) {
  return field === 'coverUrl';
}

function defaultFields(book: WorkView, candidate: MetadataCandidate | null) {
  if (!candidate) return [];
  return fields.filter((field) => {
    const next = candidateValue(candidate, field);
    if (!hasCandidateValue(next)) return false;
    if (isCoverField(field)) return book.coverStatus !== 'READY';
    return normalized(next) !== normalized(bookValue(book, field));
  });
}

function sourceOptions(book: WorkView) {
  return [
    { value: 'bangumi', label: 'Bangumi', disabled: book.type !== 'comic' },
    { value: 'douban', label: '豆瓣', disabled: book.type !== 'ebook' },
    { value: 'ai', label: 'AI' }
  ];
}

function initialSource(book: WorkView): MetadataSource {
  return book.type === 'comic' ? 'bangumi' : 'douban';
}

export function MetadataLookupModal({ book, open, onClose, onApplied }: MetadataLookupModalProps) {
  const [source, setSource] = useState<MetadataSource>(() => initialSource(book));
  const [query, setQuery] = useState(book.seriesName || book.title);
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedFields, setSelectedFields] = useState<MetadataField[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selected = useMemo(() => candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0] ?? null, [candidates, selectedId]);
  const options = useMemo(() => sourceOptions(book), [book]);

  useEffect(() => {
    if (!open) return;
    const nextSource = initialSource(book);
    setSource(nextSource);
    setQuery(book.seriesName || book.title);
    setCandidates([]);
    setSelectedId('');
    setSelectedFields([]);
    setMessage('');
    setError('');
  }, [book, open]);

  useEffect(() => {
    setSelectedFields(defaultFields(book, selected));
  }, [book, selected]);

  async function searchCandidates() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${book.id}/metadata/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, query })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { candidates: MetadataCandidate[] }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '元数据查询失败');
      const nextCandidates = payload.data?.candidates ?? [];
      setCandidates(nextCandidates);
      setSelectedId(nextCandidates[0]?.id ?? '');
      setMessage(nextCandidates.length ? `找到 ${nextCandidates.length} 条候选` : '没有找到候选');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '元数据查询失败');
    } finally {
      setBusy(false);
    }
  }

  async function applySelected() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/works/${book.id}/metadata/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, candidate: selected, fields: selectedFields })
      });
      const payload = (await response.json()) as { ok: boolean; data?: { book?: WorkView | null }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '元数据应用失败');
      setMessage('已应用所选字段');
      onApplied(payload.data?.book ?? null);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '元数据应用失败');
    } finally {
      setBusy(false);
    }
  }

  function toggleField(field: MetadataField, checked: boolean) {
    setSelectedFields((current) => checked ? [...new Set([...current, field])] : current.filter((item) => item !== field));
  }

  function renderFieldValue(field: MetadataField, value: unknown, kind: 'current' | 'candidate') {
    if (!isCoverField(field)) return valueLabel(value);
    if (typeof value !== 'string' || !value.trim()) return '未生成';
    return (
      <div className="flex items-center gap-3">
        <img src={value} alt="" className="h-20 w-14 rounded-lg border border-slate-200 object-cover" />
        <span className="text-xs text-slate-500">{kind === 'current' ? '当前封面' : '候选封面'}</span>
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="元数据识别">
      <div className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-t-[28px] border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 md:rounded-[28px]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">元数据识别</h2>
            <p className="mt-1 text-sm text-slate-500">搜索候选，选择字段后应用到《{book.title}》。</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-2xl text-slate-500 hover:bg-slate-100" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-3 border-b border-slate-100 px-5 py-4 md:grid-cols-[180px_1fr_auto]">
          <Select value={source} options={options} onChange={setSource} ariaLabel="元数据来源" className="w-full" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void searchCandidates(); }}
            className="h-11 w-full rounded-2xl border border-slate-200 px-4 text-sm text-slate-900 outline-none focus:border-blue-300"
            placeholder="输入书名、系列名或关键词"
          />
          <Button disabled={busy || !query.trim()} icon={source === 'ai' ? Sparkles : Search} onClick={() => void searchCandidates()}>
            {source === 'ai' ? '识别' : '搜索'}
          </Button>
        </div>

        {(message || error) ? (
          <div className={cn('mx-5 mt-4 rounded-2xl px-4 py-3 text-sm', error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700')}>
            {error || message}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-5 lg:grid-cols-[320px_1fr]">
          <div className="space-y-2">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setSelectedId(candidate.id)}
                className={cn('w-full rounded-2xl border p-3 text-left transition', selected?.id === candidate.id ? 'border-blue-200 bg-blue-50' : 'border-slate-200 hover:bg-slate-50')}
              >
                <div className="flex gap-3">
                  {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" className="h-20 w-14 shrink-0 rounded-lg border border-slate-200 object-cover" /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="line-clamp-2 font-medium text-slate-900">{candidate.title || '未命名候选'}</div>
                      <Badge tone={candidate.confidence >= 0.8 ? 'green' : 'blue'}>{Math.round(candidate.confidence * 100)}%</Badge>
                    </div>
                    <div className="mt-1 line-clamp-1 text-xs text-slate-500">{candidate.author || candidate.publisher || candidate.seriesName || valueLabel(candidate.publishedYear)}</div>
                    {candidate.description ? <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{candidate.description}</div> : null}
                  </div>
                </div>
              </button>
            ))}
            {candidates.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">输入查询文本后开始搜索。</div> : null}
          </div>

          <div className="min-w-0 rounded-2xl border border-slate-200">
            <div className="grid grid-cols-[44px_90px_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
              <div />
              <div>字段</div>
              <div>当前值</div>
              <div>候选值</div>
            </div>
            <div className="divide-y divide-slate-100">
              {fields.map((field) => {
                const currentValue = bookValue(book, field);
                const nextValue = candidateValue(selected, field);
                const available = hasCandidateValue(nextValue);
                return (
                  <label key={field} className={cn('grid grid-cols-[44px_90px_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-3 text-sm', !available && 'text-slate-400')}>
                    <input
                      type="checkbox"
                      disabled={!available}
                      checked={selectedFields.includes(field)}
                      onChange={(event) => toggleField(field, event.target.checked)}
                      className="mt-1 h-4 w-4 accent-blue-600"
                    />
                    <div className="font-medium">{fieldLabels[field]}</div>
                    <div className="min-w-0 break-words text-slate-500">{renderFieldValue(field, currentValue, 'current')}</div>
                    <div className="min-w-0 break-words text-slate-900">{renderFieldValue(field, nextValue, 'candidate')}</div>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button disabled={busy || !selected || selectedFields.length === 0} icon={CheckCircle2} onClick={() => void applySelected()}>应用所选字段</Button>
        </div>
      </div>
    </div>
  );
}
