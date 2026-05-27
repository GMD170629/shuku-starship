'use client';

import { AlertTriangle, BookOpen, CheckCircle2, Eye, FileText, HardDrive, Library, RefreshCw, Server, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { BookCard } from '../../components/book/book-card';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { StatCard } from '../../components/ui/stat-card';
import { books, type Book } from '../../data/mock-books';

function MiniMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function StatusRow({ icon: Icon, label, value, tone }: { icon: typeof Server; label: string; value: string; tone: 'green' | 'amber' | 'red' }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 text-slate-600">
        <Icon size={16} />
        {label}
      </div>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}

function ReadingRow({ book }: { book: Book }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-3">
        <Cover book={book} className="h-20 w-14" small />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{book.title}</div>
          <div className="mt-1 text-xs text-slate-500">{book.chapter}</div>
          <div className="mt-3">
            <Progress value={book.progress} />
          </div>
        </div>
        <span className="text-xs font-medium text-slate-500">{book.progress}%</span>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const router = useRouter();
  const current = books[0];

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">首页</h1>
          <p className="mt-2 text-slate-500">快速了解书库状态，并继续上次阅读。</p>
        </div>
        <Button variant="secondary" icon={UploadCloud}>导入读物</Button>
      </div>
      <section className="grid grid-cols-12 gap-6">
        <div className="col-span-7 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">继续阅读</h2>
            <Badge tone="green">已同步到手机</Badge>
          </div>
          <div className="mt-5 flex gap-5">
            <Cover book={current} className="h-52 w-36 shrink-0" />
            <div className="flex-1 py-2">
              <div className="text-2xl font-semibold tracking-tight">《{current.title}》</div>
              <div className="mt-2 text-sm text-slate-500">第 12 话 · 进度 68% · 最近阅读 今天 09:42</div>
              <p className="mt-5 max-w-xl text-sm leading-7 text-slate-600">
                上次在 Web 阅读器停留于第 18 页，移动端已同步同一进度。可继续阅读或打开详情查看章节列表。
              </p>
              <div className="mt-6">
                <Progress value={68} />
              </div>
              <div className="mt-6 flex gap-3">
                <Button icon={BookOpen} onClick={() => router.push(`/reader/${current.id}`)}>继续阅读</Button>
                <Button variant="secondary" icon={Eye} onClick={() => router.push(`/books/${current.id}`)}>查看详情</Button>
              </div>
            </div>
          </div>
        </div>
        <div className="col-span-5 grid grid-cols-2 gap-4">
          <StatCard icon={Library} label="总读物" value="1286" hint="全部" />
          <StatCard icon={BookOpen} label="漫画" value="842" hint="CBZ/CBR" tone="green" />
          <StatCard icon={FileText} label="小说" value="276" hint="EPUB/TXT" tone="amber" />
          <StatCard icon={HardDrive} label="存储占用" value="2.8TB" hint="/ 8TB" tone="slate" />
        </div>
      </section>
      <section className="grid grid-cols-12 gap-6">
        <div className="col-span-8 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">最近新增</h2>
            <button onClick={() => router.push('/library')} className="text-sm text-blue-600">查看全部</button>
          </div>
          <div className="mt-5 grid grid-cols-4 gap-4">
            {books.slice(0, 4).map((book) => (
              <BookCard key={book.id} book={book} compact onClick={() => router.push(`/books/${book.id}`)} />
            ))}
          </div>
        </div>
        <div className="col-span-4 space-y-6">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">系统状态</h2>
            <div className="mt-5 space-y-4 text-sm">
              <StatusRow icon={Server} label="NAS 连接" value="正常" tone="green" />
              <StatusRow icon={RefreshCw} label="当前扫描" value="/books/manga · 76%" tone="amber" />
              <StatusRow icon={CheckCircle2} label="同步状态" value="已同步" tone="green" />
              <StatusRow icon={AlertTriangle} label="错误文件" value="7 个" tone="red" />
            </div>
          </div>
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">阅读统计摘要</h2>
            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              <MiniMetric value="8.5h" label="本周" />
              <MiniMetric value="12" label="本月完成" />
              <MiniMetric value="14" label="连续天数" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge>NAS</Badge>
              <Badge>技术资料</Badge>
              <Badge>漫画</Badge>
            </div>
          </div>
        </div>
      </section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">正在阅读</h2>
        <div className="mt-4 grid grid-cols-3 gap-4">
          {books.filter((book) => book.status === '在读').slice(0, 3).map((book) => (
            <ReadingRow key={book.id} book={book} />
          ))}
        </div>
      </section>
    </div>
  );
}
