'use client';

import {
  BarChart3,
  BookMarked,
  CheckCircle2,
  FolderOpen,
  Home,
  Library,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Server,
  Settings,
  User,
  UserCircle
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PwaClient, clearPrivatePwaStorage } from '../system/pwa-client';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';

const navItems = [
  { href: '/', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '我的书库' },
  { href: '/shelves', icon: BookMarked, label: '书架' },
  { href: '/organize/pending', icon: FolderOpen, label: '待整理' },
  { href: '/', icon: BarChart3, label: '阅读统计' },
  { href: '/import-tasks', icon: RefreshCw, label: '导入任务' },
  { href: '/settings', icon: Settings, label: '系统设置' }
];

const mobileNavItems = [
  { href: '/', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '书库' },
  { href: '/shelves', icon: BookMarked, label: '书架' },
  { href: '/organize/pending', icon: FolderOpen, label: '整理' },
  { href: '/settings', icon: Settings, label: '设置' }
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
  const router = useRouter();
  const [summary, setSummary] = useState<{ storageUsedBytes: number; latestSyncAt: string | null } | null>(null);
  const [status, setStatus] = useState<{ status: string; checks: Array<{ name: string; status: string; message: string }> } | null>(null);
  const [importTask, setImportTask] = useState<{ progress: number } | null>(null);
  const [user, setUser] = useState<{ email: string; name: string; role: string } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const isReader = pathname.startsWith('/reader/');
  const isLogin = pathname === '/login';
  const isMobileReader = pathname === '/mobile';
  const isMobilePreview = pathname === '/mobile-preview';
  const isOffline = pathname === '/offline';

  useEffect(() => {
    if (pathname !== '/' || new URLSearchParams(window.location.search).get('source') !== 'pwa') return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const mobileViewport = window.matchMedia('(max-width: 767px)').matches;
    if (standalone || mobileViewport) router.replace('/mobile?source=pwa');
  }, [pathname, router]);

  useEffect(() => {
    if (isReader || isLogin || isMobileReader || isMobilePreview || isOffline) return;
    let active = true;
    Promise.all([
      fetch('/api/auth/me').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/system/health').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/system-status').then((response) => response.json()).catch(() => null)
    ]).then(([mePayload, summaryPayload, healthPayload, systemPayload]) => {
      if (!active) return;
      setUser(mePayload?.ok ? mePayload.data.user : null);
      if (summaryPayload?.ok) setSummary(summaryPayload.data);
      if (healthPayload?.ok) setStatus(healthPayload.data);
      if (systemPayload?.ok) setImportTask(systemPayload.data.currentImportTask);
    });
    return () => {
      active = false;
    };
  }, [isLogin, isMobilePreview, isMobileReader, isOffline, isReader, pathname]);

  useEffect(() => {
    if (!accountOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    }
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => window.removeEventListener('mousedown', closeOnOutsideClick);
  }, [accountOpen]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    await clearPrivatePwaStorage();
    setAccountOpen(false);
    setUser(null);
    router.replace('/login');
    router.refresh();
  }

  const storage = summary?.storageUsedBytes ?? 0;
  const storageLabel = storage > 0 ? `${(storage / 1024 / 1024 / 1024).toFixed(1)} GB` : '0 B';
  const healthOk = status?.status === 'ok';

  if (isReader || isLogin || isMobileReader || isMobilePreview || isOffline) {
    return (
      <>
        {children}
        <PwaClient />
      </>
    );
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
            <Badge tone={importTask ? 'amber' : 'green'}>
              <RefreshCw size={13} className={cn('mr-1', importTask ? 'animate-spin' : '')} />
              {importTask ? `导入 ${importTask.progress}%` : '暂无导入'}
            </Badge>
            <div ref={accountRef} className="relative">
              <button
                type="button"
                aria-expanded={accountOpen}
                aria-label="账户菜单"
                onClick={() => setAccountOpen((open) => !open)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus:ring-4 focus:ring-blue-100"
              >
                <User size={18} />
              </button>
              {accountOpen ? (
                <div className="absolute right-0 top-12 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/70">
                  <div className="border-b border-slate-100 px-4 py-3">
                    <div className="text-sm font-semibold text-slate-900">{user?.name ?? '未登录'}</div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">{user?.email ?? '请先登录后使用系统'}</div>
                  </div>
                  <Link
                    href="/settings"
                    onClick={() => setAccountOpen(false)}
                    className="flex items-center gap-2 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <UserCircle size={16} />
                    账户与系统设置
                  </Link>
                  {user ? (
                    <button
                      type="button"
                      onClick={logout}
                      className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-red-700 hover:bg-red-50"
                    >
                      <LogOut size={16} />
                      退出登录
                    </button>
                  ) : (
                    <Link
                      href={`/login?next=${encodeURIComponent(pathname)}`}
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2 px-4 py-3 text-sm text-blue-700 hover:bg-blue-50"
                    >
                      <LogIn size={16} />
                      前往登录
                    </Link>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="p-4 lg:p-8">{children}</div>
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white/95 px-2 py-2 shadow-lg backdrop-blur lg:hidden">
        {mobileNavItems.map(({ href, icon: Icon, label }) => (
          <Link key={`${href}-mobile`} href={href} className={cn('flex min-h-11 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-1.5 text-[11px] active:scale-[0.98]', isActive(pathname, href) ? 'bg-blue-50 text-blue-700' : 'text-slate-500')}>
            <Icon size={17} />
            <span className="line-clamp-1">{label}</span>
          </Link>
        ))}
      </nav>
      <PwaClient />
    </div>
  );
}
