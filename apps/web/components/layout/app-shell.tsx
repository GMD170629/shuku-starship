'use client';

import {
  BarChart3,
  BookMarked,
  CheckCircle2,
  FolderOpen,
  Home,
  Library,
  RefreshCw,
  Search,
  Server,
  Settings,
  Tags,
  User
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';

const navItems = [
  { href: '/', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '我的书库' },
  { href: '/shelves', icon: BookMarked, label: '书架' },
  { href: '/organize', icon: FolderOpen, label: '待整理' },
  { href: '/library?filter=tags', icon: Tags, label: '标签' },
  { href: '/library?focus=search', icon: Search, label: '搜索' },
  { href: '/', icon: BarChart3, label: '阅读统计' },
  { href: '/scan-tasks', icon: RefreshCw, label: '扫描任务' },
  { href: '/settings', icon: Settings, label: '系统设置' }
];

function isActive(pathname: string, href: string) {
  const cleanHref = href.split('?')[0];
  if (cleanHref === '/') {
    return pathname === '/';
  }
  return pathname.startsWith(cleanHref);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [summary, setSummary] = useState<{ storageUsedBytes: number; latestSyncAt: string | null } | null>(null);
  const [status, setStatus] = useState<{ status: string; checks: Array<{ name: string; status: string; message: string }> } | null>(null);
  const [scan, setScan] = useState<{ progress: number } | null>(null);
  const isReader = pathname.startsWith('/reader/');
  const isLogin = pathname === '/login';
  const isMobilePreview = pathname === '/mobile-preview';

  useEffect(() => {
    if (isReader || isLogin || isMobilePreview) return;
    let active = true;
    Promise.all([
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/system/health').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/system-status').then((response) => response.json()).catch(() => null)
    ]).then(([summaryPayload, healthPayload, systemPayload]) => {
      if (!active) return;
      if (summaryPayload?.ok) setSummary(summaryPayload.data);
      if (healthPayload?.ok) setStatus(healthPayload.data);
      if (systemPayload?.ok) setScan(systemPayload.data.currentRunningScanTask);
    });
    return () => {
      active = false;
    };
  }, [isLogin, isMobilePreview, isReader, pathname]);

  const storage = summary?.storageUsedBytes ?? 0;
  const storageLabel = storage > 0 ? `${(storage / 1024 / 1024 / 1024).toFixed(1)} GB` : '0 B';
  const healthOk = status?.status === 'ok';

  if (isReader || isLogin || isMobilePreview) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-[#F6F7F9] text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-slate-200 bg-white/88 px-4 py-5 shadow-sm backdrop-blur-xl lg:block">
        <Link href="/" className="flex items-center gap-3 px-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-sm">
            <Library size={22} />
          </div>
          <div>
            <div className="text-base font-semibold">书库星舰</div>
            <div className="text-xs text-slate-500">Self-hosted Reading Library</div>
          </div>
        </Link>
        <nav className="mt-8 space-y-1.5">
          {navItems.map(({ href, icon: Icon, label }) => (
            <Link
              key={`${href}-${label}`}
              href={href}
              className={cn(
                'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition',
                isActive(pathname, href) ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
              )}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="absolute inset-x-4 bottom-5 rounded-3xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <Server size={16} /> {healthOk ? '服务可用' : '待检测'}
          </div>
          <div className="mt-3 space-y-2 text-xs text-slate-500">
            <div className="flex justify-between">
              <span>存储占用</span>
              <span>{storageLabel}</span>
            </div>
            <Progress value={0} />
            <div className={cn('flex items-center gap-1', summary?.latestSyncAt ? 'text-emerald-600' : 'text-slate-500')}>
              <CheckCircle2 size={13} /> {summary?.latestSyncAt ? `进度更新 · ${new Date(summary.latestSyncAt).toLocaleString()}` : '暂无同步'}
            </div>
          </div>
        </div>
      </aside>
      <main className="pb-20 lg:pl-72 lg:pb-0">
        <header className="sticky top-0 z-10 flex h-auto min-h-20 flex-col gap-3 border-b border-slate-200 bg-[#F6F7F9]/80 px-4 py-4 backdrop-blur-xl md:flex-row md:items-center md:justify-between lg:px-8">
          <div className="flex h-12 w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 shadow-sm md:w-[520px]">
            <Search size={18} className="text-slate-400" />
            <input className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" placeholder="搜索书名、作者、标签、文件路径..." />
          </div>
          <div className="flex items-center gap-3">
            <Badge tone="green">
              <CheckCircle2 size={13} className="mr-1" />
              {summary?.latestSyncAt ? '有进度' : '暂无同步'}
            </Badge>
            <Badge tone={scan ? 'amber' : 'green'}>
              <RefreshCw size={13} className="mr-1 animate-spin" />
              {scan ? `扫描 ${scan.progress}%` : '暂无扫描'}
            </Badge>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white">
              <User size={18} />
            </div>
          </div>
        </header>
        <div className="p-4 lg:p-8">{children}</div>
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white/95 px-2 py-2 shadow-lg backdrop-blur lg:hidden">
        {navItems.slice(0, 5).map(({ href, icon: Icon, label }) => (
          <Link key={`${href}-mobile`} href={href} className={cn('flex flex-col items-center gap-1 rounded-2xl px-2 py-1.5 text-[11px]', isActive(pathname, href) ? 'bg-blue-50 text-blue-700' : 'text-slate-500')}>
            <Icon size={17} />
            <span className="line-clamp-1">{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
