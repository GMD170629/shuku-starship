'use client';

import { AlertTriangle, Ban, Clock, FileText, ListFilter, PlusCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { Progress } from '../../components/ui/progress';
import { StatCard } from '../../components/ui/stat-card';

type LibraryPath = { id: string; name: string; rootPath: string; enabled: boolean };
type ScanTask = {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_RESUME' | 'COMPLETED' | 'FAILED' | 'CANCELED';
  mode: 'NORMAL' | 'DRY_RUN';
  progress: number;
  scannedCount: number;
  processedCount: number;
  totalCount: number;
  totalFiles: number;
  processedFiles: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  duplicateCount: number;
  heartbeatAt?: string | null;
  lastScannedPath?: string | null;
  duration: number;
  errorSummary?: string | null;
  message?: string | null;
  createdAt: string;
  libraryPath: LibraryPath;
  logs: ScanLog[];
};
type ScanLog = { id: string; level: string; message: string; createdAt: string };
type LogsPayload = { logs: ScanLog[]; page: number; pageSize: number; total: number; totalPages: number };

function statusLabel(status: ScanTask['status']) {
  return status === 'COMPLETED' ? 'FINISHED' : status;
}

export function ScanTasksPage() {
  const [paths, setPaths] = useState<LibraryPath[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [tasks, setTasks] = useState<ScanTask[]>([]);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<ScanLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ScanLog[]>([]);
  const [logPage, setLogPage] = useState(1);
  const [logLevel, setLogLevel] = useState('');
  const [logMeta, setLogMeta] = useState({ total: 0, totalPages: 1 });

  const activeTask = useMemo(() => tasks.find((task) => task.status === 'RUNNING' || task.status === 'QUEUED' || task.status === 'WAITING_RESUME') ?? tasks[0], [tasks]);

  async function load() {
    const [pathResponse, taskResponse] = await Promise.all([fetch('/api/library-paths'), fetch('/api/scan-tasks')]);
    const pathPayload = (await pathResponse.json()) as { ok: boolean; data?: { paths: LibraryPath[] } };
    const taskPayload = (await taskResponse.json()) as { ok: boolean; data?: { tasks: ScanTask[] }; error?: { message: string } };
    if (pathPayload.ok) {
      const enabled = pathPayload.data?.paths.filter((path) => path.enabled) ?? [];
      setPaths(enabled);
      setSelectedPath((current) => current || enabled[0]?.id || '');
    }
    if (taskPayload.ok) setTasks(taskPayload.data?.tasks ?? []);
    else setError(taskPayload.error?.message ?? '读取扫描任务失败');
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLogPage(1);
  }, [activeTask?.id, logLevel]);

  useEffect(() => {
    if (!activeTask) return;
    async function loadLogs() {
      const levelQuery = logLevel ? `&level=${encodeURIComponent(logLevel)}` : '';
      const [logResponse, errorResponse] = await Promise.all([
        fetch(`/api/scan-tasks/${activeTask.id}/logs?page=${logPage}&pageSize=100${levelQuery}`),
        fetch(`/api/scan-tasks/${activeTask.id}/logs?page=1&pageSize=100&level=ERROR`)
      ]);
      const logPayload = (await logResponse.json()) as { ok: boolean; data?: LogsPayload };
      const errorPayload = (await errorResponse.json()) as { ok: boolean; data?: LogsPayload };
      if (logPayload.ok && logPayload.data) {
        setLogs(logPayload.data.logs);
        setLogMeta({ total: logPayload.data.total, totalPages: logPayload.data.totalPages });
      }
      if (errorPayload.ok && errorPayload.data) setErrorLogs(errorPayload.data.logs);
    }
    loadLogs();
  }, [activeTask, logPage, logLevel]);

  async function createTask(dryRun = false) {
    setError('');
    if (!selectedPath) {
      setError('暂无启用的书库路径，请先添加路径。');
      return;
    }
    const response = await fetch('/api/scan-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryPathId: selectedPath, dryRun })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) {
      setError(payload.error?.message ?? '创建扫描任务失败');
      return;
    }
    await load();
  }

  async function cancelTask(task: ScanTask) {
    setError('');
    const response = await fetch(`/api/scan-tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) setError(payload.error?.message ?? '取消扫描任务失败');
    await load();
  }

  async function retryFailedFiles(task: ScanTask) {
    setError('');
    const response = await fetch('/api/scan-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retryFailedTaskId: task.id })
    });
    const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
    if (!payload.ok) setError(payload.error?.message ?? '创建失败文件重扫任务失败');
    await load();
  }

  const latestLogs = logs.length > 0 ? logs : activeTask?.logs ?? [];
  const durationSeconds = Math.round((activeTask?.duration ?? 0) / 1000);

  return (
    <div className="space-y-6">
      <PageTitle
        title="扫描任务"
        desc="查看 NAS 书库扫描任务、实时进度、日志和错误。"
        action={<div className="flex flex-wrap gap-3"><select value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)} className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm"><option value="">选择书库路径</option>{paths.map((path) => <option key={path.id} value={path.id}>{path.name}</option>)}</select><Button disabled={paths.length === 0} icon={PlusCircle} onClick={() => createTask(false)}>开始扫描</Button><Button disabled={paths.length === 0} variant="secondary" icon={FileText} onClick={() => createTask(true)}>Dry run</Button></div>}
      />
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-5 text-sm text-red-700">{error}</div> : null}
      <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        {activeTask ? (
          <>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <RefreshCw className={cn(activeTask.status === 'RUNNING' && 'animate-spin', 'text-blue-600')} size={20} />
                  {activeTask.message ?? `扫描 ${activeTask.libraryPath.rootPath}`}
                </div>
                <div className="mt-2 text-sm text-slate-500">{activeTask.libraryPath.rootPath} · {new Date(activeTask.createdAt).toLocaleString()}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeTask.mode === 'DRY_RUN' ? <Badge tone="amber">DRY RUN</Badge> : null}
                <Badge tone={activeTask.status === 'COMPLETED' ? 'green' : activeTask.status === 'FAILED' ? 'red' : 'amber'}>{statusLabel(activeTask.status)}</Badge>
                {['RUNNING', 'QUEUED', 'WAITING_RESUME'].includes(activeTask.status) ? <Button variant="secondary" icon={Ban} onClick={() => cancelTask(activeTask)}>取消</Button> : null}
              </div>
            </div>
            <Progress value={activeTask.progress} className="mt-6 h-3" />
            <div className="mt-3 text-sm text-slate-500">
              文件 {activeTask.processedFiles ?? activeTask.processedCount}/{activeTask.totalFiles || activeTask.totalCount || activeTask.scannedCount} · 用时 {durationSeconds}s · 心跳 {activeTask.heartbeatAt ? new Date(activeTask.heartbeatAt).toLocaleTimeString() : '等待'} · {activeTask.lastScannedPath ?? '等待扫描文件'}
            </div>
          </>
        ) : (
          <div className="text-sm text-slate-500">暂无扫描任务，请先添加书库路径后开始扫描。</div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <StatCard icon={FileText} label="已扫描文件" value={String(activeTask?.processedFiles ?? activeTask?.processedCount ?? 0)} hint={`${activeTask?.totalFiles ?? activeTask?.totalCount ?? 0} total`} />
        <StatCard icon={PlusCircle} label="新增读物" value={String(activeTask?.createdCount ?? 0)} hint="new" tone="green" />
        <StatCard icon={RefreshCw} label="更新读物" value={String(activeTask?.updatedCount ?? 0)} hint="updated" tone="blue" />
        <StatCard icon={AlertTriangle} label="错误文件" value={String(activeTask?.errorCount ?? 0)} hint="error" tone="amber" />
        <StatCard icon={Clock} label="跳过文件" value={String(activeTask?.skippedCount ?? 0)} hint="skipped" tone="slate" />
      </div>
      <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-semibold">扫描报告</h2>
            <div className="mt-1 text-sm text-slate-500">{activeTask?.message ?? '暂无报告'}</div>
          </div>
          {activeTask && activeTask.errorCount > 0 ? <Button variant="secondary" icon={RotateCcw} onClick={() => retryFailedFiles(activeTask)}>重新扫描失败文件</Button> : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
          <ReportItem label="扫描文件数" value={activeTask?.totalFiles ?? 0} />
          <ReportItem label="新增读物数" value={activeTask?.createdCount ?? 0} />
          <ReportItem label="更新读物数" value={activeTask?.updatedCount ?? 0} />
          <ReportItem label="跳过文件数" value={activeTask?.skippedCount ?? 0} />
          <ReportItem label="错误文件数" value={activeTask?.errorCount ?? 0} />
          <ReportItem label="重复文件数" value={activeTask?.duplicateCount ?? 0} />
        </div>
        {activeTask?.errorSummary ? <pre className="mt-4 whitespace-pre-wrap rounded-2xl bg-red-50 p-4 text-xs text-red-700">{activeTask.errorSummary}</pre> : null}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="rounded-[28px] border border-slate-200 bg-slate-950 p-5 font-mono text-sm text-slate-200 shadow-sm xl:col-span-8">
          <div className="mb-4 flex items-center justify-between font-sans">
            <span className="text-white">任务日志</span>
            <div className="flex items-center gap-2">
              <select value={logLevel} onChange={(event) => setLogLevel(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100">
                <option value="">全部</option>
                <option value="INFO">INFO</option>
                <option value="WARN">WARN</option>
                <option value="ERROR">ERROR</option>
              </select>
              <Badge tone="green">Live</Badge>
            </div>
          </div>
          {latestLogs.map((line) => (
            <div key={line.id} className={cn('py-1', line.level === 'error' && 'text-amber-300')}>[{new Date(line.createdAt).toLocaleTimeString()}] {line.message}</div>
          ))}
          {latestLogs.length === 0 ? <div className="py-1 text-slate-400">暂无日志</div> : null}
          <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-4 font-sans text-xs text-slate-400">
            <span>第 {logPage}/{logMeta.totalPages} 页 · {logMeta.total} 条</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setLogPage((page) => Math.max(1, page - 1))}>上一页</Button>
              <Button variant="secondary" onClick={() => setLogPage((page) => Math.min(logMeta.totalPages, page + 1))}>下一页</Button>
            </div>
          </div>
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm xl:col-span-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">错误文件列表</h2>
            <ListFilter size={18} className="text-amber-600" />
          </div>
          {errorLogs.map((line) => (
            <div key={line.id} className="mt-3 rounded-2xl bg-red-50 p-3 text-xs text-red-700">
              <div className="font-medium">{new Date(line.createdAt).toLocaleString()}</div>
              <div className="mt-1 break-all">{line.message}</div>
            </div>
          ))}
          {errorLogs.length === 0 ? <div className="mt-4 text-sm text-slate-500">暂无错误文件。</div> : null}
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm xl:col-span-12">
          <h2 className="font-semibold">历史扫描记录</h2>
          {tasks.map((task) => (
            <div key={task.id} className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm">
              <div className="font-medium">{new Date(task.createdAt).toLocaleString()} · {task.libraryPath.name}</div>
              <div className="mt-1 text-xs text-slate-500">{task.mode === 'DRY_RUN' ? 'DRY RUN · ' : ''}{statusLabel(task.status)} · 新增 {task.createdCount} · 错误 {task.errorCount}</div>
            </div>
          ))}
          <Button variant="secondary" icon={RotateCcw} className="mt-5 w-full" onClick={load}>刷新任务</Button>
        </div>
      </div>
    </div>
  );
}

function ReportItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
    </div>
  );
}
