'use client';

import { AlertTriangle, CheckCircle2, Clock, FileArchive, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import type { BadgeTone } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useConfirm, useToast } from '../../components/ui/feedback';
import { PageTitle } from '../../components/ui/page-title';
import { Progress } from '../../components/ui/progress';

type ImportTask = {
  id: string;
  origin: 'MANUAL' | 'WATCH';
  status: 'PENDING' | 'PARSING' | 'COMPLETED' | 'FAILED';
  originalName?: string | null;
  sourcePath: string;
  contentHash?: string | null;
  progress: number;
  duplicate: boolean;
  message?: string | null;
  errorSummary?: string | null;
  friendlyError?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  monitorFolder?: { name: string; rootPath: string } | null;
  book?: { id: string; title: string } | null;
  logs: Array<{ id: string; level: string; message: string; createdAt: string }>;
};

const emptySummary = { added: 0, updated: 0, skipped: 0, failed: 0 };

function normalizeImportTask(task: ImportTask): ImportTask {
  return {
    ...task,
    sourcePath: task.sourcePath ?? '',
    progress: Number.isFinite(task.progress) ? task.progress : 0,
    duplicate: Boolean(task.duplicate),
    logs: Array.isArray(task.logs) ? task.logs : []
  };
}

function statusTone(status: ImportTask['status']) {
  if (status === 'COMPLETED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PARSING') return 'amber';
  return 'slate';
}

function statusLabel(status: ImportTask['status']) {
  return { PENDING: '等待中', PARSING: '导入中', COMPLETED: '已完成', FAILED: '失败' }[status];
}

export function ImportTasksPage() {
  const [tasks, setTasks] = useState<ImportTask[]>([]);
  const [summary, setSummary] = useState(emptySummary);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'clear' | 'rescan' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const toast = useToast();
  const activeTask = useMemo(() => tasks.find((task) => task.status === 'PARSING' || task.status === 'PENDING') ?? null, [tasks]);

  async function loadTasks() {
    setLoading(true);
    try {
      const response = await fetch('/api/import-tasks');
      const text = await response.text();
      const payload = text ? JSON.parse(text) as { ok: boolean; data?: { tasks: ImportTask[]; summary: typeof summary }; error?: { message: string } } : null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `读取导入任务失败：HTTP ${response.status}`);
      if (!payload) throw new Error('读取导入任务失败：服务暂时没有返回内容');
      if (!payload.ok) throw new Error(payload.error?.message ?? '读取导入任务失败');
      setTasks((payload.data?.tasks ?? []).map(normalizeImportTask));
      setSummary({ ...emptySummary, ...(payload.data?.summary ?? {}) });
      setError('');
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '读取导入任务失败';
      setError(nextError);
      toast.error('读取导入任务失败', nextError);
    } finally {
      setLoading(false);
    }
  }

  async function requestRescan() {
    setBusy('rescan');
    try {
      const response = await fetch('/api/import-tasks/rescan', { method: 'POST' });
      const text = await response.text();
      const payload = text ? JSON.parse(text) as { ok: boolean; data?: { requestedAt: string }; error?: { message: string } } : null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `请求重新识别失败：HTTP ${response.status}`);
      if (!payload?.ok) throw new Error(payload?.error?.message ?? '请求重新识别失败');
      setMessage('已请求重新识别监控文件夹');
      toast.success('已请求重新识别监控文件夹');
      setError('');
      await loadTasks();
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '请求重新识别失败';
      setError(nextError);
      toast.error('请求重新识别失败', nextError);
    } finally {
      setBusy('');
    }
  }

  async function clearFinishedTasks() {
    const confirmed = await confirm({
      title: '清空导入记录',
      description: '确认清空已完成和失败的导入记录吗？书库读物和源文件不会被删除。',
      confirmLabel: '清空记录',
      tone: 'danger'
    });
    if (!confirmed) return;
    setBusy('clear');
    try {
      const response = await fetch('/api/import-tasks', { method: 'DELETE' });
      const text = await response.text();
      const payload = text ? JSON.parse(text) as { ok: boolean; data?: { deleted: number }; error?: { message: string } } : null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `清空记录失败：HTTP ${response.status}`);
      if (!payload?.ok) throw new Error(payload?.error?.message ?? '清空记录失败');
      const successMessage = `已清空 ${payload.data?.deleted ?? 0} 条已结束导入记录`;
      setMessage(successMessage);
      toast.success(successMessage);
      setError('');
      await loadTasks();
    } catch (reason) {
      const nextError = reason instanceof Error ? reason.message : '清空记录失败';
      setError(nextError);
      toast.error('清空记录失败', nextError);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="space-y-6">
      <PageTitle
        title="导入任务"
        desc="查看手动上传和监控文件夹自动导入状态。"
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={RefreshCw} loading={loading} loadingText="刷新中" onClick={() => void loadTasks()}>刷新</Button>
            <Button loading={busy === 'rescan'} loadingText="请求中" variant="secondary" icon={Search} onClick={() => void requestRescan()}>
              强制重新识别
            </Button>
            <Button loading={busy === 'clear'} loadingText="清空中" variant="danger" icon={Trash2} onClick={() => void clearFinishedTasks()}>
              清空记录
            </Button>
          </div>
        )}
      />
      {message ? <div className="rounded-3xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div> : null}
      {activeTask ? (
        <div className="rounded-[28px] border border-amber-100 bg-amber-50 p-5 text-amber-800">
          <div className="flex items-center gap-2 font-semibold"><Clock size={18} />{activeTask.message ?? '正在导入读物'}</div>
          <Progress value={activeTask.progress} className="mt-4" />
          <div className="mt-2 text-sm">{activeTask.originalName ?? activeTask.sourcePath}</div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['新增', summary.added],
          ['更新', summary.updated],
          ['跳过', summary.skipped],
          ['失败', summary.failed]
        ].map(([label, value]) => (
          <div key={label} className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{value}</div>
          </div>
        ))}
      </div>
      {loading ? <div className="shuku-loading-panel p-8 text-sm" role="status" aria-live="polite">正在读取导入任务...</div> : null}
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div> : null}
      {!loading && !error && tasks.length === 0 ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无导入任务。</div> : null}
      <div className="space-y-3">
        {tasks.map((task) => (
          <div key={task.id} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <FileArchive size={18} className="text-blue-600" />
                  <span className="font-semibold">{task.book?.title ?? task.originalName ?? task.sourcePath.split('/').at(-1)}</span>
                  <Badge tone={statusTone(task.status) as BadgeTone}>{statusLabel(task.status)}</Badge>
                  {task.duplicate ? <Badge tone="amber">重复</Badge> : null}
                  <Badge>{task.origin === 'WATCH' ? '监控导入' : '手动上传'}</Badge>
                </div>
                <div className="mt-2 break-words text-sm text-slate-500">{task.monitorFolder?.name ? `${task.monitorFolder.name} · ` : ''}{task.sourcePath}</div>
                {task.errorSummary ? (
                  <div className="mt-3 space-y-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                    <div className="flex gap-2"><AlertTriangle size={16} />{task.errorSummary}</div>
                    {task.friendlyError ? <div className="pl-6 text-red-600">建议：{task.friendlyError}</div> : null}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-slate-500">{new Date(task.createdAt).toLocaleString()}</div>
            </div>
            {task.status === 'PARSING' || task.status === 'PENDING' ? <Progress value={task.progress} className="mt-4" /> : null}
            {task.logs.length > 0 ? (
              <div className="mt-4 space-y-1 rounded-2xl bg-slate-50 p-3 font-mono text-xs text-slate-500">
                {task.logs.slice(0, 5).map((log) => (
                  <div key={log.id} className="break-words">
                    <span className={log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-600' : 'text-slate-500'}>{log.level}</span> · {log.message}
                  </div>
                ))}
              </div>
            ) : null}
            {task.status === 'COMPLETED' ? <div className="mt-4 flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 size={16} />导入完成</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
