'use client';

import { RefreshCw, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { ManagementNav } from './management-nav';

type SystemEvent = {
  id: string;
  level: string;
  source: string;
  actorType: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type EventsPayload = {
  ok: boolean;
  data?: {
    events: SystemEvent[];
    total: number;
    storage: { sizeBytes: number; maxBytes: number };
    facets: { sources: Array<{ source: string; count: number }>; levels: Array<{ level: string; count: number }> };
  };
  error?: { message: string };
};

function formatBytes(value: number) {
  if (!value) return '0 B';
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
}

function tone(level: string): BadgeTone {
  if (level === 'error') return 'red';
  if (level === 'warning' || level === 'warn') return 'amber';
  return 'slate';
}

function targetHref(event: SystemEvent) {
  if (event.targetType === 'work' && event.targetId) return `/works/${event.targetId}`;
  if (event.targetType === 'downloadTask') return '/downloads';
  if (event.targetType === 'importTask') return '/import-tasks';
  if (event.targetType === 'monitorFolder') return '/management/folders';
  return '';
}

export function ManagementLogsPage() {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [storage, setStorage] = useState({ sizeBytes: 0, maxBytes: 5 * 1024 * 1024 });
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '80' });
      if (source) params.set('source', source);
      if (level) params.set('level', level);
      if (search.trim()) params.set('search', search.trim());
      const response = await fetch(`/api/management/events?${params.toString()}`);
      const payload = (await response.json()) as EventsPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '读取日志失败');
      setEvents(payload.data?.events ?? []);
      setStorage(payload.data?.storage ?? { sizeBytes: 0, maxBytes: 5 * 1024 * 1024 });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取日志失败');
    } finally {
      setLoading(false);
    }
  }

  async function clearLogs() {
    if (!window.confirm('清理 info 和 warning 结构化日志？error 和关键审计事件会保留。')) return;
    const response = await fetch('/api/management/events', { method: 'DELETE' });
    const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { deleted: number }; error?: { message: string } } | null;
    if (!payload?.ok) {
      toast.error('清理日志失败', payload?.error?.message ?? '请稍后重试');
      return;
    }
    toast.success(`已清理 ${payload.data?.deleted ?? 0} 条日志`);
    await load();
  }

  useEffect(() => {
    void load();
  }, [source, level]);

  const percent = Math.min(100, Math.round((storage.sizeBytes / storage.maxBytes) * 100));

  return (
    <div className="space-y-6">
      <PageTitle title="结构化日志" desc="按来源、级别和目标查看系统事件，日志总量自动控制在 5MB 左右。" action={<Button variant="secondary" icon={RefreshCw} loading={loading} loadingText="刷新中" onClick={() => void load()}>刷新</Button>} />
      <ManagementNav />
      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            {['', 'info', 'warning', 'error'].map((item) => (
              <button key={item || 'all-level'} type="button" onClick={() => setLevel(item)} className={`min-h-10 rounded-2xl border px-3 text-sm ${level === item ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{item || '全部级别'}</button>
            ))}
            {['', 'import', 'download', 'folder', 'library', 'system'].map((item) => (
              <button key={item || 'all-source'} type="button" onClick={() => setSource(item)} className={`min-h-10 rounded-2xl border px-3 text-sm ${source === item ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{item || '全部来源'}</button>
            ))}
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="flex h-10 items-center gap-2 rounded-2xl border border-slate-200 px-3">
              <Search size={16} className="text-slate-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(); }} className="w-full bg-transparent text-sm outline-none md:w-48" placeholder="搜索事件" />
            </div>
            <Button variant="ghost" icon={Trash2} onClick={() => void clearLogs()}>清理</Button>
          </div>
        </div>
        <div className="mt-4">
          <div className="flex justify-between text-xs text-slate-500">
            <span>日志占用</span>
            <span>{formatBytes(storage.sizeBytes)} / {formatBytes(storage.maxBytes)}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-blue-600" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <div className="space-y-3">
        {!loading && events.length === 0 ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无结构化日志。</div> : null}
        {events.map((event) => {
          const href = targetHref(event);
          return (
            <article key={event.id} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={tone(event.level)}>{event.level}</Badge>
                    <Badge>{event.source}</Badge>
                    <Badge>{event.actorType}</Badge>
                    <span className="break-words font-medium text-slate-950">{event.message}</span>
                  </div>
                  <div className="mt-2 break-words text-sm text-slate-500">{event.action}{event.targetType ? ` · ${event.targetType}` : ''}{event.targetId ? ` · ${event.targetId}` : ''}</div>
                  {Object.keys(event.metadata ?? {}).length > 0 ? <pre className="mt-3 max-h-36 overflow-auto rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">{JSON.stringify(event.metadata, null, 2)}</pre> : null}
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 text-sm text-slate-500 lg:items-end">
                  <span>{new Date(event.createdAt).toLocaleString()}</span>
                  {href ? <Link href={href} className="font-medium text-blue-700 hover:text-blue-800">打开关联对象</Link> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
