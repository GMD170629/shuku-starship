'use client';

import { AlertTriangle, Ban, CheckCircle2, Download, FileCheck2, RefreshCw, RotateCcw, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { PageTitle } from '../../components/ui/page-title';
import { Progress } from '../../components/ui/progress';

type DownloadTask = {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  searchRecordId: string | null;
  bookId: string | null;
  type: string;
  status: string;
  displayName: string;
  savePath: string | null;
  filePath: string | null;
  errorMessage: string | null;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
};

type DownloadTasksPayload = { ok: boolean; data?: { tasks: DownloadTask[]; task?: DownloadTask }; error?: { message: string } };

const groups = [
  { status: 'queued', title: '等待中' },
  { status: 'downloading', title: '下载中' },
  { status: 'downloaded', title: '已下载' },
  { status: 'importing', title: '导入中' },
  { status: 'completed', title: '已导入' },
  { status: 'failed', title: '失败' },
  { status: 'cancelled', title: '已取消' }
];

const statusLabels: Record<string, string> = {
  queued: '等待中',
  downloading: '下载中',
  downloaded: '已下载',
  importing: '导入中',
  completed: '已导入',
  failed: '失败',
  cancelled: '已取消'
};

const typeLabels: Record<string, string> = {
  manual: '手动',
  telegram: 'Telegram',
  torrent: 'Torrent',
  http: 'HTTP',
  blackhole: 'Blackhole'
};

function statusTone(status: string): BadgeTone {
  if (status === 'completed' || status === 'downloaded') return 'green';
  if (status === 'downloading' || status === 'importing') return 'amber';
  if (status === 'failed') return 'red';
  if (status === 'cancelled') return 'slate';
  return 'blue';
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function DownloadsPage() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const taskGroups = useMemo(() => groups.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => task.status === group.status)
  })), [tasks]);

  async function loadTasks() {
    setLoading(true);
    try {
      const response = await fetch('/api/download-tasks');
      const payload = (await response.json()) as DownloadTasksPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '读取下载任务失败');
      setTasks(payload.data?.tasks ?? []);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取下载任务失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(), 8000);
    return () => window.clearInterval(timer);
  }, []);

  async function updateTask(task: DownloadTask, next: { status?: string; errorMessage?: string | null }) {
    setBusy(`${next.status ?? 'update'}:${task.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/download-tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      const payload = (await response.json()) as DownloadTasksPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '更新下载任务失败');
      setMessage('下载任务已更新');
      await loadTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新下载任务失败');
    } finally {
      setBusy('');
    }
  }

  async function postTaskAction(task: DownloadTask, action: 'cancel' | 'retry') {
    setBusy(`${action}:${task.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/download-tasks/${task.id}/${action}`, { method: 'POST' });
      const payload = (await response.json()) as DownloadTasksPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '操作失败');
      setMessage(action === 'cancel' ? '下载任务已取消' : '下载任务已重新排队');
      await loadTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  async function startDownload(task: DownloadTask) {
    setBusy(`start:${task.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/download-tasks/${task.id}/start`, { method: 'POST' });
      const payload = (await response.json()) as DownloadTasksPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '开始下载失败');
      setMessage(payload.data?.task?.status === 'downloaded' ? '下载完成' : '下载任务已开始');
      await loadTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '开始下载失败');
      await loadTasks();
    } finally {
      setBusy('');
    }
  }

  async function importDownloadedFile(task: DownloadTask) {
    setBusy(`import:${task.id}`);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/download-tasks/${task.id}/import`, { method: 'POST' });
      const payload = (await response.json()) as DownloadTasksPayload;
      if (!payload.ok) throw new Error(payload.error?.message ?? '导入书库失败');
      setMessage('已导入书库');
      await loadTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入书库失败');
      await loadTasks();
    } finally {
      setBusy('');
    }
  }

  function markFailed(task: DownloadTask) {
    const reason = window.prompt('失败原因', task.errorMessage ?? '');
    if (reason === null) return;
    void updateTask(task, { status: 'failed', errorMessage: reason.trim() || '手动标记失败' });
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="下载队列"
        desc="外部下载只进入 downloads/inbox；这里负责排队、状态标记和后续导入衔接。"
        action={<Button variant="secondary" icon={RefreshCw} onClick={() => void loadTasks()}>刷新</Button>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {taskGroups.map((group) => (
          <div key={group.status} className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs text-slate-500">{group.title}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{group.tasks.length}</div>
          </div>
        ))}
      </div>
      {message ? <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取下载任务...</div> : null}
      {!loading && tasks.length === 0 ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">暂无下载任务。可从源搜索结果加入队列。</div> : null}
      <div className="space-y-6">
        {taskGroups.filter((group) => group.tasks.length > 0).map((group) => (
          <section key={group.status} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">{group.title}</h2>
              <Badge tone={statusTone(group.status)}>{group.tasks.length}</Badge>
            </div>
            {group.tasks.map((task) => (
              <article key={task.id} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Download size={18} className="text-blue-600" />
                      <h3 className="break-words font-semibold text-slate-950">{task.displayName}</h3>
                      <Badge tone={statusTone(task.status)}>{statusLabels[task.status] ?? task.status}</Badge>
                      <Badge>{typeLabels[task.type] ?? task.type}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
                      <span className="rounded-full bg-slate-100 px-2 py-1">来源 {task.sourceName ?? task.sourceId ?? '未绑定'}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">创建 {dateLabel(task.createdAt)}</span>
                      {task.progress !== null ? <span className="rounded-full bg-slate-100 px-2 py-1">进度 {task.progress}%</span> : null}
                    </div>
                    {task.errorMessage ? (
                      <div className="mt-3 flex gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                        <span className="break-words">{task.errorMessage}</span>
                      </div>
                    ) : null}
                    {['downloaded', 'completed'].includes(task.status) && task.filePath ? (
                      <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        文件：{task.filePath}
                      </div>
                    ) : null}
                    {task.status === 'importing' ? (
                      <div className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
                        正在复用现有导入流程处理 inbox 文件。
                      </div>
                    ) : null}
                    {task.status === 'completed' ? (
                      <div className="mt-3 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                        已导入书库，可在书库或待整理中继续处理。
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {['queued', 'failed'].includes(task.status) ? <Button disabled={busy === `start:${task.id}`} variant="secondary" icon={Download} onClick={() => void startDownload(task)}>开始下载</Button> : null}
                    {task.status === 'downloaded' ? <Button disabled={busy === `import:${task.id}`} variant="secondary" icon={UploadCloud} onClick={() => void importDownloadedFile(task)}>导入书库</Button> : null}
                    <Button disabled={busy === `cancel:${task.id}` || task.status === 'completed' || task.status === 'cancelled'} variant="secondary" icon={Ban} onClick={() => void postTaskAction(task, 'cancel')}>取消</Button>
                    <Button disabled={busy === `retry:${task.id}` || !['failed', 'cancelled'].includes(task.status)} variant="secondary" icon={RotateCcw} onClick={() => void postTaskAction(task, 'retry')}>重试</Button>
                    <Button disabled={busy === `downloaded:${task.id}` || ['downloaded', 'importing', 'completed'].includes(task.status)} variant="secondary" icon={FileCheck2} onClick={() => void updateTask(task, { status: 'downloaded' })}>标记已下载</Button>
                    <Button disabled={busy === `completed:${task.id}` || task.status !== 'importing'} variant="secondary" icon={CheckCircle2} onClick={() => void updateTask(task, { status: 'completed' })}>标记导入完成</Button>
                    <Button disabled={busy === `failed:${task.id}`} variant="danger" icon={AlertTriangle} onClick={() => markFailed(task)}>标记失败</Button>
                  </div>
                </div>
                {task.status === 'downloading' || task.status === 'downloaded' || task.status === 'importing' ? <Progress value={task.progress ?? 0} className="mt-4" /> : null}
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
