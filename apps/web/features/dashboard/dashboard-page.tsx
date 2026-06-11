'use client';

import { AlertTriangle, BookOpen, CheckCircle2, Eye, FileText, HardDrive, Library, RefreshCw, Server, Settings, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BookCard } from '../../components/book/book-card';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { StatCard } from '../../components/ui/stat-card';
import type { WorkView } from '../../types/work';

type Summary = {
  totalBooks: number;
  comicBooks: number;
  novelBooks: number;
  storageUsedBytes: number;
  monitorFolderCount: number;
  lastImportAt: string | null;
  latestSyncAt: string | null;
};
type ContinueItem = { book: WorkView; progress: number; lastReadAt: string; chapter: string | null; position: string } | null;
type SystemStatus = {
  database: { status: string; message: string };
  worker: { status: string; message: string };
  currentImportTask: { progress: number; monitorFolder?: { rootPath: string }; status: string } | null;
  latestImportTask: { status: string; progress: number; finishedAt?: string | null } | null;
  errorFileCount: number;
  monitorRootReadable: { status: string; message: string };
  storageWritable: { status: string; message: string };
};

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function tone(status?: string): 'green' | 'amber' | 'red' {
  if (status === 'ok') return 'green';
  if (status === 'error') return 'red';
  return 'amber';
}

function StatusRow({ icon: Icon, label, value, status }: { icon: typeof Server; label: string; value: string; status?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-slate-600">
        <Icon size={16} />
        {label}
      </div>
      <Badge tone={tone(status)}>{value}</Badge>
    </div>
  );
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const payload = (await response.json()) as { ok: boolean; data?: T; error?: { message: string } };
  if (!payload.ok || !payload.data) throw new Error(payload.error?.message ?? '读取数据失败');
  return payload.data;
}

export function DashboardPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [continueItem, setContinueItem] = useState<ContinueItem>(null);
  const [recentBooks, setRecentBooks] = useState<WorkView[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<Summary>('/api/dashboard/summary'),
      api<{ item: ContinueItem }>('/api/dashboard/continue-reading'),
      api<{ books: WorkView[] }>('/api/dashboard/recent-books?limit=4'),
      api<SystemStatus>('/api/dashboard/system-status')
    ])
      .then(([nextSummary, nextContinue, nextRecent, nextStatus]) => {
        if (!active) return;
        setSummary(nextSummary);
        setContinueItem(nextContinue.item);
        setRecentBooks(nextRecent.books);
        setStatus(nextStatus);
        setError('');
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : '读取 Dashboard 失败'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const importTask = status?.currentImportTask;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">首页</h1>
          <p className="mt-2 text-slate-500">快速了解书库状态，并继续上次阅读。</p>
        </div>
        <Button variant="secondary" icon={UploadCloud} onClick={() => router.push('/library')}>导入读物</Button>
      </div>
      {loading ? <div className="rounded-3xl border border-slate-200 bg-white p-8 text-sm text-slate-500">正在读取真实书库状态...</div> : null}
      {error ? <div className="rounded-3xl border border-red-100 bg-red-50 p-8 text-sm text-red-700">{error}</div> : null}
      {!loading && !error ? (
        <>
          <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-7">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">继续阅读</h2>
                <Badge tone={summary?.latestSyncAt ? 'green' : 'amber'}>{summary?.latestSyncAt ? '有阅读进度' : '暂无同步'}</Badge>
              </div>
              {continueItem ? (
                <div className="mt-5 flex flex-col gap-5 md:flex-row">
                  <Cover book={continueItem.book} className="h-52 w-36 shrink-0" />
                  <div className="flex-1 py-2">
                    <div className="text-2xl font-semibold tracking-tight">《{continueItem.book.title}》</div>
                    <div className="mt-2 text-sm text-slate-500">{continueItem.chapter ?? continueItem.book.chapter} · 进度 {Math.round(continueItem.progress)}% · 最近阅读 {new Date(continueItem.lastReadAt).toLocaleString()}</div>
                    <div className="mt-6">
                      <Progress value={continueItem.progress} />
                    </div>
                    <div className="mt-6 flex gap-3">
                      <Button icon={BookOpen} onClick={() => router.push(`/reader/${continueItem.book.editionId ?? continueItem.book.id}`)}>继续阅读</Button>
                      <Button variant="secondary" icon={Eye} onClick={() => router.push(`/works/${continueItem.book.id}`)}>查看详情</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-3xl bg-slate-50 p-8 text-sm text-slate-500">暂无继续阅读。打开任意读物后，这里会显示最近阅读进度。</div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 xl:col-span-5">
              <StatCard icon={Library} label="总读物" value={String(summary?.totalBooks ?? 0)} hint="全部" />
              <StatCard icon={BookOpen} label="漫画" value={String(summary?.comicBooks ?? 0)} hint="COMIC" tone="green" />
              <StatCard icon={FileText} label="电子书" value={String(summary?.novelBooks ?? 0)} hint="EPUB" tone="amber" />
              <StatCard icon={HardDrive} label="存储占用" value={formatBytes(summary?.storageUsedBytes ?? 0)} hint={`${summary?.monitorFolderCount ?? 0} 个监控文件夹`} tone="slate" />
            </div>
          </section>
          <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">最近新增</h2>
                <button onClick={() => router.push('/library')} className="text-sm text-blue-600">查看全部</button>
              </div>
              {recentBooks.length > 0 ? (
                <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
                  {recentBooks.map((book) => <BookCard key={book.id} book={book} compact onClick={() => router.push(`/works/${book.id}`)} />)}
                </div>
              ) : (
                <div className="mt-5 rounded-3xl bg-slate-50 p-8 text-sm text-slate-500">暂无读物，请上传 EPUB/CBZ/ZIP，或在系统设置中添加监控文件夹。</div>
              )}
            </div>
            <div className="space-y-6 xl:col-span-4">
              <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold">系统状态</h2>
                <div className="mt-5 space-y-4 text-sm">
                  <StatusRow icon={Server} label="数据库" value={status?.database.message ?? '待检测'} status={status?.database.status} />
                  <StatusRow icon={Server} label="导入 Worker" value={status?.worker.message ?? '待检测'} status={status?.worker.status} />
                  <StatusRow icon={RefreshCw} label="当前导入" value={importTask ? `${importTask.monitorFolder?.rootPath ?? '导入中'} · ${importTask.progress}%` : '暂无导入任务'} status={importTask ? 'unknown' : 'ok'} />
                  <StatusRow icon={AlertTriangle} label="错误文件" value={`${status?.errorFileCount ?? 0} 个`} status={(status?.errorFileCount ?? 0) > 0 ? 'error' : 'ok'} />
                  <StatusRow icon={CheckCircle2} label="存储写入" value={status?.storageWritable.message ?? '待检测'} status={status?.storageWritable.status} />
                </div>
              </div>
              <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold">真实数据时间</h2>
                <div className="mt-4 space-y-3 text-sm text-slate-600">
                  <div>最近导入：{summary?.lastImportAt ? new Date(summary.lastImportAt).toLocaleString() : '暂无'}</div>
                  <div>最近进度：{summary?.latestSyncAt ? new Date(summary.latestSyncAt).toLocaleString() : '暂无'}</div>
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
