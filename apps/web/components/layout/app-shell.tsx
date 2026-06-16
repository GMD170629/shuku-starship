'use client';

import {
  BookMarked,
  CheckCircle2,
  Download,
  FolderOpen,
  Home,
  Layers,
  Library,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Settings,
  User,
  UserCircle
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { SeriesSummary, WorkView } from '../../types/work';
import { Cover } from '../book/cover';
import { PwaClient, clearPrivatePwaStorage } from '../system/pwa-client';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { useToast } from '../ui/feedback';
import { Progress } from '../ui/progress';

const navItems = [
  { href: '/', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '我的书库' },
  { href: '/shelves', icon: BookMarked, label: '书架' },
  { href: '/organize/pending', icon: FolderOpen, label: '待整理' },
  { href: '/downloads', icon: Download, label: '下载队列' },
  { href: '/import-tasks', icon: RefreshCw, label: '导入任务' },
  { href: '/management', icon: ShieldCheck, label: '管理' },
  { href: '/settings', icon: Settings, label: '系统设置' }
];

const mobileNavItems = [
  { href: '/', icon: Home, label: '首页' },
  { href: '/library', icon: Library, label: '书库' },
  { href: '/shelves', icon: BookMarked, label: '书架' },
  { href: '/organize/pending', icon: FolderOpen, label: '整理' },
  { href: '/management', icon: ShieldCheck, label: '管理' }
];

const shellSurfaces = {
  app: { background: '#F6F7F9', colorScheme: 'light', statusBarStyle: 'black-translucent' },
  mobile: { background: '#F7F1E7', colorScheme: 'light', statusBarStyle: 'black-translucent' },
  login: { background: '#F8FAFC', colorScheme: 'light', statusBarStyle: 'black-translucent' },
  offline: { background: '#020617', colorScheme: 'dark', statusBarStyle: 'black-translucent' }
} satisfies Record<string, { background: string; colorScheme: 'light' | 'dark'; statusBarStyle: 'default' | 'black-translucent' }>;

type BooksPayload = {
  ok: boolean;
  data?: { books: WorkView[]; total: number };
  error?: { message: string };
};

type SeriesPayload = {
  ok: boolean;
  data?: { series: SeriesSummary[]; total: number };
  error?: { message: string };
};

type SystemSettingsPayload = {
  ok: boolean;
  data?: { settings?: Record<string, unknown> };
};

async function readApiJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isActive(pathname: string, href: string) {
  const cleanHref = href.split('?')[0];
  if (cleanHref === '/') {
    return pathname === '/';
  }
  return pathname.startsWith(cleanHref);
}

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function ensureMeta(name: string) {
  const existing = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (existing) return { meta: existing, created: false };
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  document.head.appendChild(meta);
  return { meta, created: true };
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [summary, setSummary] = useState<{ storageUsedBytes: number; latestSyncAt: string | null } | null>(null);
  const [status, setStatus] = useState<{ status: string; checks: Array<{ name: string; status: string; message: string }> } | null>(null);
  const [importTask, setImportTask] = useState<{ progress: number } | null>(null);
  const [user, setUser] = useState<{ email: string; name: string; role: string } | null>(null);
  const [systemName, setSystemName] = useState('书库星舰');
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [seriesTotal, setSeriesTotal] = useState(0);
  const [currentSeriesName, setCurrentSeriesName] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [topSearch, setTopSearch] = useState('');
  const [topSearchFocused, setTopSearchFocused] = useState(false);
  const [topSearchBooks, setTopSearchBooks] = useState<WorkView[]>([]);
  const [topSearchTotal, setTopSearchTotal] = useState(0);
  const [topSearchLoading, setTopSearchLoading] = useState(false);
  const [topSearchActiveIndex, setTopSearchActiveIndex] = useState(0);
  const accountRef = useRef<HTMLDivElement>(null);
  const topSearchRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const isReader = pathname.startsWith('/reader/');
  const isLogin = pathname === '/login';
  const isMobileReader = pathname === '/mobile';
  const isMobilePreview = pathname === '/mobile-preview';
  const isOffline = pathname === '/offline';
  const shellSurface = isReader || isMobileReader || isMobilePreview
      ? shellSurfaces.mobile
      : isLogin
        ? shellSurfaces.login
        : isOffline
          ? shellSurfaces.offline
          : shellSurfaces.app;

  useEffect(() => {
    if (isReader) return undefined;
    if (!shellSurface) return undefined;

    const previousHtmlBackground = document.documentElement.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousColorScheme = document.documentElement.style.colorScheme;
    const foundThemeColorMetas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const createdThemeColor = foundThemeColorMetas.length === 0 ? ensureMeta('theme-color') : null;
    const themeColorMetas = createdThemeColor ? [createdThemeColor.meta] : foundThemeColorMetas;
    const { meta: statusBarMeta, created: createdStatusBarMeta } = ensureMeta('apple-mobile-web-app-status-bar-style');
    const previousThemeColors = themeColorMetas.map((meta) => meta.content);
    const previousStatusBarStyle = statusBarMeta.content;

    function applySurface() {
      document.documentElement.style.backgroundColor = shellSurface.background;
      document.body.style.backgroundColor = shellSurface.background;
      document.documentElement.style.colorScheme = shellSurface.colorScheme;
      const currentThemeColorMetas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
      const targetThemeColorMetas = currentThemeColorMetas.length > 0 ? currentThemeColorMetas : [ensureMeta('theme-color').meta];
      targetThemeColorMetas.forEach((meta) => {
        if (meta.getAttribute('content') !== shellSurface.background) meta.setAttribute('content', shellSurface.background);
      });
      const currentStatusBarMeta = ensureMeta('apple-mobile-web-app-status-bar-style').meta;
      if (currentStatusBarMeta.getAttribute('content') !== shellSurface.statusBarStyle) {
        currentStatusBarMeta.setAttribute('content', shellSurface.statusBarStyle);
      }
    }

    applySurface();
    const frame = window.requestAnimationFrame(applySurface);
    const settleTimer = window.setTimeout(applySurface, 250);
    const syncTimer = window.setInterval(applySurface, 500);
    const headObserver = new MutationObserver(applySurface);
    headObserver.observe(document.head, { attributes: true, childList: true, subtree: true, attributeFilter: ['content'] });

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearInterval(syncTimer);
      headObserver.disconnect();
      document.documentElement.style.backgroundColor = previousHtmlBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      document.documentElement.style.colorScheme = previousColorScheme;
      themeColorMetas.forEach((meta, index) => {
        const previousThemeColor = previousThemeColors[index];
        if (createdThemeColor?.meta === meta) {
          meta.remove();
          return;
        }
        meta.setAttribute('content', previousThemeColor);
      });
      if (createdStatusBarMeta) statusBarMeta.remove();
      else statusBarMeta.setAttribute('content', previousStatusBarStyle);
    };
  }, [isReader, shellSurface]);

  useEffect(() => {
    if (pathname !== '/') return;
    const searchParams = new URLSearchParams(window.location.search);
    const pwaLaunch = searchParams.get('source') === 'pwa';
    const standalone = isStandaloneDisplay();
    const mobileViewport = window.matchMedia('(max-width: 767px)').matches;
    if (standalone || (pwaLaunch && mobileViewport)) router.replace('/mobile?source=pwa');
  }, [pathname, router]);

  useEffect(() => {
    function syncCurrentSeriesName() {
      if (pathname !== '/series') {
        setCurrentSeriesName('');
        return;
      }
      setCurrentSeriesName(new URLSearchParams(window.location.search).get('name')?.trim() ?? '');
    }
    syncCurrentSeriesName();
    window.addEventListener('popstate', syncCurrentSeriesName);
    window.addEventListener('shuku:series-route-change', syncCurrentSeriesName);
    return () => {
      window.removeEventListener('popstate', syncCurrentSeriesName);
      window.removeEventListener('shuku:series-route-change', syncCurrentSeriesName);
    };
  }, [pathname]);

  useEffect(() => {
    if (isReader || isLogin || isMobileReader || isMobilePreview || isOffline) return;
    let active = true;
    Promise.all([
      fetch('/api/auth/me').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/system/health').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/system-status').then((response) => response.json()).catch(() => null),
      fetch('/api/system-settings').then((response) => response.json() as Promise<SystemSettingsPayload>).catch(() => null)
    ]).then(([mePayload, summaryPayload, healthPayload, systemPayload, settingsPayload]) => {
      if (!active) return;
      setUser(mePayload?.ok ? mePayload.data.user : null);
      if (summaryPayload?.ok) setSummary(summaryPayload.data);
      if (healthPayload?.ok) setStatus(healthPayload.data);
      if (systemPayload?.ok) setImportTask(systemPayload.data.currentImportTask);
      const nextSystemName = settingsPayload?.ok && typeof settingsPayload.data?.settings?.systemName === 'string'
        ? settingsPayload.data.settings.systemName.trim()
        : '';
      if (nextSystemName) setSystemName(nextSystemName);
    });
    return () => {
      active = false;
    };
  }, [isLogin, isMobilePreview, isMobileReader, isOffline, isReader, pathname]);

  useEffect(() => {
    if (isReader || isLogin || isMobileReader || isMobilePreview || isOffline) return;
    let active = true;
    fetch('/api/series?visibility=active&limit=12')
      .then((response) => readApiJson<SeriesPayload>(response))
      .then((payload) => {
        if (!active) return;
        if (!payload?.ok) throw new Error(payload?.error?.message ?? '读取系列失败');
        setSeries(payload.data?.series ?? []);
        setSeriesTotal(payload.data?.total ?? 0);
      })
      .catch(() => {
        if (!active) return;
        setSeries([]);
        setSeriesTotal(0);
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

  useEffect(() => {
    if (!topSearchFocused) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!topSearchRef.current?.contains(event.target as Node)) {
        setTopSearchFocused(false);
      }
    }
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => window.removeEventListener('mousedown', closeOnOutsideClick);
  }, [topSearchFocused]);

  useEffect(() => {
    setTopSearchFocused(false);
  }, [pathname]);

  useEffect(() => {
    const keyword = topSearch.trim();
    if (!keyword) {
      setTopSearchBooks([]);
      setTopSearchTotal(0);
      setTopSearchLoading(false);
      setTopSearchActiveIndex(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTopSearchLoading(true);
      fetch(`/api/works?pageSize=5&visibility=active&sort=recent_read&search=${encodeURIComponent(keyword)}`, { signal: controller.signal })
        .then((response) => response.json() as Promise<BooksPayload>)
        .then((payload) => {
          if (!payload.ok) throw new Error(payload.error?.message ?? '搜索书库失败');
          setTopSearchBooks(payload.data?.books ?? []);
          setTopSearchTotal(payload.data?.total ?? 0);
          setTopSearchActiveIndex(0);
        })
        .catch((reason) => {
          if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
            setTopSearchBooks([]);
            setTopSearchTotal(0);
            toast.error('搜索书库失败', reason instanceof Error ? reason.message : '请稍后重试');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setTopSearchLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [toast, topSearch]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    await clearPrivatePwaStorage();
    setAccountOpen(false);
    setUser(null);
    router.replace('/login');
    router.refresh();
  }

  function searchExternalSources(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    goToExternalSourceSearch();
  }

  function goToExternalSourceSearch() {
    const keyword = topSearch.trim();
    if (!keyword) return;
    setTopSearchFocused(false);
    router.push(`/sources/search?keyword=${encodeURIComponent(keyword)}&auto=1`);
  }

  function openBook(book: WorkView) {
    setTopSearchFocused(false);
    router.push(`/works/${book.id}`);
  }

  function handleTopSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const keyword = topSearch.trim();
    if (!keyword) return;
    const optionCount = topSearchBooks.length + 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setTopSearchFocused(true);
      setTopSearchActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + optionCount) % optionCount);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setTopSearchFocused(false);
      return;
    }
    if (event.key === 'Enter' && topSearchFocused) {
      event.preventDefault();
      const selectedBook = topSearchBooks[topSearchActiveIndex];
      if (selectedBook) openBook(selectedBook);
      else goToExternalSourceSearch();
    }
  }

  const storage = summary?.storageUsedBytes ?? 0;
  const storageLabel = storage > 0 ? `${(storage / 1024 / 1024 / 1024).toFixed(1)} GB` : '0 B';
  const healthOk = status?.status === 'ok';

  useEffect(() => {
    if (!systemName.trim()) return;
    document.title = systemName;
  }, [systemName]);

  if (isReader || isLogin || isMobileReader || isMobilePreview || isOffline) {
    return (
      <>
        {children}
        <PwaClient />
      </>
    );
  }

  return (
    <div className="shuku-app-shell min-h-screen bg-[#F6F7F9] text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-slate-200 bg-white/88 px-4 py-5 shadow-sm backdrop-blur-xl lg:flex">
        <Link href="/" className="flex shrink-0 items-center gap-3 px-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-sm">
            <Library size={22} />
          </div>
          <div>
            <div className="text-base font-semibold">{systemName}</div>
            <div className="text-xs text-slate-500">Self-hosted Reading Library</div>
          </div>
        </Link>
        <div className="mt-8 min-h-0 flex-1 overflow-y-auto pr-1">
          <nav className="space-y-1.5">
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
          {series.length > 0 ? (
            <section className="mt-7 border-t border-slate-100 pt-5">
              <div className="mb-2 flex items-center justify-between px-3 text-xs font-semibold uppercase text-slate-400">
                <span>系列</span>
                <Layers size={14} />
              </div>
              <div className="space-y-1">
                {series.map((item) => {
                  const href = `/series?name=${encodeURIComponent(item.name)}`;
                  const active = pathname === '/series' && currentSeriesName === item.name;
                  return (
                    <Link
                      key={item.name}
                      href={href}
                      onClick={() => setCurrentSeriesName(item.name)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2 text-sm transition',
                        active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
                      )}
                    >
                      <span className="min-w-0 truncate">{item.name}</span>
                      <span className={cn('shrink-0 text-xs', active ? 'text-blue-500' : 'text-slate-400')}>{item.bookCount}</span>
                    </Link>
                  );
                })}
                {seriesTotal > series.length ? (
                  <Link
                    href="/series"
                    onClick={() => setCurrentSeriesName('')}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm transition',
                      pathname === '/series' && !currentSeriesName ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'
                    )}
                  >
                    全部系列
                  </Link>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
        <div className="mt-5 shrink-0 rounded-3xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <Server size={16} /> {healthOk ? '服务可用' : '待检测'}
          </div>
          <div className="mt-3 space-y-2 text-xs text-slate-500">
            <div className="flex justify-between">
              <span>文件占用</span>
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
          <form ref={topSearchRef} onSubmit={searchExternalSources} className="relative flex h-12 w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 shadow-sm md:w-[560px]">
            <Search size={18} className="shrink-0 text-slate-400" />
            <input
              value={topSearch}
              onFocus={() => setTopSearchFocused(true)}
              onChange={(event) => {
                setTopSearch(event.target.value);
                setTopSearchFocused(true);
              }}
              onKeyDown={handleTopSearchKeyDown}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
              placeholder="搜索书库，或去外部源搜索..."
              aria-label="搜索书库或外部源"
              autoComplete="off"
              data-testid="top-search-input"
            />
            {topSearchFocused && topSearch.trim() ? (
              <div data-testid="top-search-dropdown" className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-200/70">
                <div className="max-h-[360px] overflow-y-auto py-2">
                  {topSearchLoading ? (
                    <div className="shuku-loading-panel mx-2 my-2 px-3 py-3 text-sm" role="status" aria-live="polite">正在搜索书库...</div>
                  ) : null}
                  {!topSearchLoading && topSearchBooks.map((book, index) => (
                    <button
                      key={book.id}
                      type="button"
                      data-testid="top-search-book-result"
                      aria-current={topSearchActiveIndex === index ? 'true' : undefined}
                      onMouseEnter={() => setTopSearchActiveIndex(index)}
                      onClick={() => openBook(book)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2.5 text-left transition focus:outline-none',
                        topSearchActiveIndex === index ? 'bg-blue-50' : 'hover:bg-slate-50 focus:bg-slate-50'
                      )}
                    >
                      <Cover book={book} size="small" className="h-14 w-10 shrink-0 rounded-lg shadow-none" small />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{book.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{book.author} · {book.format} · {book.status}</span>
                      </span>
                    </button>
                  ))}
                  {!topSearchLoading && topSearchBooks.length === 0 ? (
                    <div className="px-4 py-4 text-sm text-slate-500">书库中没有匹配读物</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  data-testid="top-search-external-source"
                  aria-current={topSearchActiveIndex === topSearchBooks.length ? 'true' : undefined}
                  onMouseEnter={() => setTopSearchActiveIndex(topSearchBooks.length)}
                  onClick={goToExternalSourceSearch}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-left text-sm font-medium text-blue-700 transition focus:outline-none',
                    topSearchActiveIndex === topSearchBooks.length ? 'bg-blue-100' : 'bg-blue-50 hover:bg-blue-100 focus:bg-blue-100'
                  )}
                >
                  <span className="min-w-0 truncate">去外部源搜索“{topSearch.trim()}”</span>
                  <span className="shrink-0 text-xs text-blue-500">{topSearchTotal > 5 ? `书库共 ${topSearchTotal} 条` : '/sources/search'}</span>
                </button>
              </div>
            ) : null}
          </form>
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
