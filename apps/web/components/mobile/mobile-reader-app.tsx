'use client';

import {
  BookOpen,
  ChevronRight,
  Clock3,
  FolderOpen,
  Home,
  Library,
  LogOut,
  Search,
  Settings,
  UploadCloud,
  User
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import type { BookView } from '../../lib/books';
import { Cover } from '../book/cover';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';

type MobileTab = 'shelf' | 'search' | 'reading' | 'me';
type BooksPayload = { ok: boolean; data?: { books: BookView[]; total: number }; error?: { message: string } };
type ContinueItem = { book: BookView; progress: number; lastReadAt: string; chapter: string | null } | null;
type Summary = { totalBooks: number; latestSyncAt: string | null };
type UserInfo = { email: string; name: string; role: string };
type SystemStatus = {
  currentImportTask: { progress: number; status: string } | null;
  latestImportTask: { status: string; progress: number; finishedAt?: string | null } | null;
};
type OpenBookHandler = (book: BookView, sourceElement?: HTMLElement | null) => void;

const tabs: Array<{ key: MobileTab; label: string; icon: typeof Library }> = [
  { key: 'shelf', label: '书架', icon: Library },
  { key: 'search', label: '搜索', icon: Search },
  { key: 'reading', label: '在读', icon: BookOpen },
  { key: 'me', label: '我的', icon: User }
];

function readSavedTab() {
  if (typeof window === 'undefined') return 'shelf';
  const saved = window.localStorage.getItem('shuku.mobile.tab');
  return saved === 'search' || saved === 'reading' || saved === 'me' ? saved : 'shelf';
}

function formatDate(value: string | null | undefined) {
  if (!value) return '暂无';
  return new Date(value).toLocaleString();
}

function bookMeta(book: BookView) {
  return `${book.author} · ${book.format}`;
}

function readingState(book: BookView) {
  if (book.progress > 0) return `阅读中 ${book.progress}%`;
  if (book.statusValue === 'FINISHED') return '已读';
  return '未读';
}

function openingCoverUrl(book: BookView) {
  if (book.coverUrl) return book.coverUrl.replace(/size=(small|medium|large)/, 'size=large');
  return `/api/books/${book.id}/cover?size=large`;
}

function readerOpeningSource(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest('[data-mobile-book-entry="true"]') as HTMLElement | null;
}

function storeReaderOpeningContext(book: BookView, sourceElement?: HTMLElement | null) {
  const coverElement = sourceElement?.querySelector('[data-book-cover="true"]') ?? sourceElement;
  const rect = coverElement?.getBoundingClientRect();
  const payload = {
    bookId: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    coverUrl: openingCoverUrl(book),
    gradient: book.gradient,
    rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
  };
  try {
    window.sessionStorage.setItem('shuku:reader:opening', JSON.stringify(payload));
  } catch {
    // Opening animation is optional; navigation should never depend on storage.
  }
}

export function MobileReaderApp() {
  const router = useRouter();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<MobileTab>('shelf');
  const [books, setBooks] = useState<BookView[]>([]);
  const [searchBooks, setSearchBooks] = useState<BookView[]>([]);
  const [continueItem, setContinueItem] = useState<ContinueItem>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setTab(readSavedTab());
  }, []);

  function selectTab(nextTab: MobileTab) {
    setTab(nextTab);
    window.localStorage.setItem('shuku.mobile.tab', nextTab);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      fetch('/api/books?pageSize=40&visibility=active&sort=recent_read').then((response) => response.json() as Promise<BooksPayload>),
      fetch('/api/dashboard/continue-reading').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/auth/me').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/system-status').then((response) => response.json()).catch(() => null)
    ])
      .then(([booksPayload, continuePayload, summaryPayload, userPayload, statusPayload]) => {
        if (!active) return;
        if (!booksPayload.ok) throw new Error(booksPayload.error?.message ?? '读取书架失败');
        setBooks(booksPayload.data?.books ?? []);
        setContinueItem(continuePayload?.ok ? continuePayload.data.item : null);
        setSummary(summaryPayload?.ok ? summaryPayload.data : null);
        setUser(userPayload?.ok ? userPayload.data.user : null);
        setSystemStatus(statusPayload?.ok ? statusPayload.data : null);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取书架失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (tab !== 'search') return;
    const search = searchText.trim();
    if (!search) {
      setSearchBooks([]);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/books?pageSize=40&visibility=active&sort=recent_read&search=${encodeURIComponent(search)}`)
        .then((response) => response.json() as Promise<BooksPayload>)
        .then((payload) => {
          if (!payload.ok) throw new Error(payload.error?.message ?? '搜索失败');
          setSearchBooks(payload.data?.books ?? []);
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : '搜索失败'))
        .finally(() => setSearchLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText, tab]);

  const readingBooks = useMemo(
    () => books.filter((book) => book.progress > 0).sort((left, right) => Date.parse(right.lastReadAt ?? '') - Date.parse(left.lastReadAt ?? '')),
    [books]
  );

  const recentBooks = books.slice(0, 40);
  const displayedSearchBooks = searchText.trim() ? searchBooks : [];

  function openReader(book: BookView, sourceElement?: HTMLElement | null) {
    storeReaderOpeningContext(book, sourceElement);
    router.push(`/reader/${book.id}?from=mobile`);
  }

  async function uploadBook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setMessage('');
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/books/import', { method: 'POST', body: form });
      const payload = (await response.json()) as { ok: boolean; data?: { title: string; duplicate?: boolean }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '上传失败');
      setMessage(payload.data?.duplicate ? `《${payload.data.title}》已存在` : `《${payload.data?.title ?? file.name}》已上传`);
      setReloadKey((value) => value + 1);
      selectTab('shelf');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    router.replace('/login?next=/mobile');
  }

  return (
    <main className="min-h-[100dvh] bg-[#F7F7F8] text-slate-950">
      <div
        className="mx-auto flex min-h-[100dvh] max-w-md flex-col"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)'
        }}
      >
        <section className="flex-1 overflow-y-auto px-5 pb-28 pt-5">
          {tab === 'shelf' ? (
            <ShelfView
              books={recentBooks}
              continueItem={continueItem}
              error={error}
              loading={loading}
              message={message}
              onOpenBook={openReader}
              onGoSearch={() => selectTab('search')}
              onGoMe={() => selectTab('me')}
              onUpload={() => uploadInputRef.current?.click()}
              onSettings={() => router.push('/settings')}
            />
          ) : null}

          {tab === 'search' ? (
            <SearchView
              books={displayedSearchBooks}
              loading={searchLoading}
              searchText={searchText}
              onSearchTextChange={setSearchText}
              onOpenBook={openReader}
            />
          ) : null}

          {tab === 'reading' ? (
            <ReadingView books={readingBooks} loading={loading} onOpenBook={openReader} onGoShelf={() => selectTab('shelf')} />
          ) : null}

          {tab === 'me' ? (
            <MeView
              user={user}
              summary={summary}
              systemStatus={systemStatus}
              uploading={uploading}
              onUpload={() => uploadInputRef.current?.click()}
              onSettings={() => router.push('/settings')}
              onImports={() => router.push('/import-tasks')}
              onLibrary={() => router.push('/library')}
              onLogout={logout}
            />
          ) : null}
        </section>

        <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-slate-200 bg-white/95 px-4 pb-[max(0.65rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => selectTab(key)}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl text-xs transition active:scale-[0.98]',
                tab === key ? 'text-[#002FA7]' : 'text-slate-500'
              )}
              aria-current={tab === key ? 'page' : undefined}
            >
              <Icon size={22} strokeWidth={tab === key ? 2.4 : 2} />
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </nav>

        <input
          ref={uploadInputRef}
          type="file"
          accept=".epub,.cbz,.zip,application/epub+zip,application/zip"
          className="hidden"
          disabled={uploading}
          onChange={uploadBook}
        />
      </div>
    </main>
  );
}

function AppHeader({ title, onProfile }: { title: string; onProfile?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-[34px] font-semibold leading-tight tracking-tight">{title}</h1>
      {onProfile ? (
        <button
          type="button"
          onClick={onProfile}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 transition active:scale-[0.98]"
          aria-label="我的"
        >
          <User size={24} />
        </button>
      ) : null}
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  placeholder = '搜索书名、作者'
}: {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex h-14 items-center gap-3 rounded-[22px] border border-slate-200 bg-white px-4 shadow-sm shadow-slate-200/40">
      <Search size={21} className="text-slate-500" />
      <input
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-slate-400"
      />
    </div>
  );
}

function ShelfView({
  books,
  continueItem,
  loading,
  error,
  message,
  onOpenBook,
  onGoSearch,
  onGoMe,
  onUpload,
  onSettings
}: {
  books: BookView[];
  continueItem: ContinueItem;
  loading: boolean;
  error: string;
  message: string;
  onOpenBook: OpenBookHandler;
  onGoSearch: () => void;
  onGoMe: () => void;
  onUpload: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="space-y-7">
      <AppHeader title="我的书架" onProfile={onGoMe} />
      <button
        type="button"
        onClick={onGoSearch}
        className="flex h-14 w-full items-center gap-3 rounded-[22px] border border-slate-200 bg-white px-4 text-left text-[17px] text-slate-400 shadow-sm shadow-slate-200/40"
        aria-label="搜索书名、作者"
      >
        <Search size={21} className="text-slate-500" />
        搜索书名、作者
      </button>

      {message ? <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-[#002FA7]">{message}</div> : null}
      {error ? <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {loading ? <LoadingBlock label="正在读取书架..." /> : null}

      {!loading && continueItem ? <ContinueCard item={continueItem} onOpenBook={onOpenBook} /> : null}

      {!loading && books.length === 0 ? <EmptyLibrary onUpload={onUpload} onSettings={onSettings} /> : null}

      {!loading && books.length > 0 ? (
        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">全部书籍</h2>
            <div className="text-sm text-slate-500">最近阅读</div>
          </div>
          <BookGrid books={books} onOpenBook={onOpenBook} />
        </section>
      ) : null}
    </div>
  );
}

function ContinueCard({ item, onOpenBook }: { item: NonNullable<ContinueItem>; onOpenBook: OpenBookHandler }) {
  const entryRef = useRef<HTMLElement>(null);

  return (
    <section ref={entryRef} data-mobile-book-entry="true" className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">继续阅读</h2>
        <button type="button" onClick={() => onOpenBook(item.book, entryRef.current)} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          查看全部 <ChevronRight size={16} />
        </button>
      </div>
      <div className="flex gap-4">
        <Cover book={item.book} size="medium" className="h-36 w-24 shrink-0 rounded-[18px]" />
        <div className="min-w-0 flex-1 py-1">
          <h3 className="line-clamp-2 text-xl font-semibold leading-snug tracking-tight">{item.book.title}</h3>
          <div className="mt-2 truncate text-sm text-slate-500">{bookMeta(item.book)}</div>
          <div className="mt-5 text-sm text-slate-500">阅读进度 {Math.round(item.progress)}%</div>
          <Progress value={item.progress} className="mt-2" />
          <button
            type="button"
            onClick={() => onOpenBook(item.book, entryRef.current)}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-2xl bg-[#002FA7] px-5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.98]"
          >
            继续阅读
          </button>
        </div>
      </div>
    </section>
  );
}

function BookGrid({ books, onOpenBook }: { books: BookView[]; onOpenBook: OpenBookHandler }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {books.map((book) => (
        <BookTile key={book.id} book={book} onOpen={onOpenBook} />
      ))}
    </div>
  );
}

function BookTile({ book, onOpen }: { book: BookView; onOpen: OpenBookHandler }) {
  return (
    <button
      type="button"
      data-mobile-book-entry="true"
      onClick={(event) => onOpen(book, event.currentTarget)}
      className="min-w-0 rounded-[22px] border border-slate-200 bg-white p-3 text-left shadow-sm shadow-slate-200/40 transition active:scale-[0.99]"
    >
      <Cover book={book} size="medium" className="mx-auto aspect-[3/4] w-full rounded-[18px]" />
      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 min-h-10 text-base font-semibold leading-tight">{book.title}</div>
          <div className="mt-1 truncate text-sm text-slate-500">{bookMeta(book)}</div>
        </div>
        <span className="mt-0.5 shrink-0 text-lg leading-none text-slate-500">...</span>
      </div>
      <div className={cn('mt-3 text-sm', book.progress > 0 ? 'text-[#002FA7]' : 'text-slate-500')}>{readingState(book)}</div>
      <div className="mt-2 flex items-center gap-2">
        <Progress value={book.progress} className="flex-1" />
        <span className="w-8 text-right text-xs tabular-nums text-slate-500">{book.progress}%</span>
      </div>
    </button>
  );
}

function SearchView({
  books,
  loading,
  searchText,
  onSearchTextChange,
  onOpenBook
}: {
  books: BookView[];
  loading: boolean;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  onOpenBook: OpenBookHandler;
}) {
  return (
    <div className="space-y-6">
      <AppHeader title="搜索" />
      <SearchBar value={searchText} onChange={onSearchTextChange} placeholder="搜索书名、作者、标签" />
      {loading ? <LoadingBlock label="正在搜索..." /> : null}
      {!loading && !searchText.trim() ? <SoftEmpty title="输入关键词" text="可以搜索书名、作者或标签。" /> : null}
      {!loading && searchText.trim() && books.length === 0 ? <SoftEmpty title="没有找到读物" text="换一个关键词再试。" /> : null}
      {!loading && books.length > 0 ? <BookGrid books={books} onOpenBook={onOpenBook} /> : null}
    </div>
  );
}

function ReadingView({
  books,
  loading,
  onOpenBook,
  onGoShelf
}: {
  books: BookView[];
  loading: boolean;
  onOpenBook: OpenBookHandler;
  onGoShelf: () => void;
}) {
  return (
    <div className="space-y-6">
      <AppHeader title="在读" />
      {loading ? <LoadingBlock label="正在读取进度..." /> : null}
      {!loading && books.length === 0 ? <SoftEmpty title="暂无在读" text="打开任意读物后，这里会显示阅读进度。" action="去书架" onAction={onGoShelf} /> : null}
      {!loading && books.length > 0 ? (
        <div className="space-y-3">
          {books.map((book) => (
            <button
              key={book.id}
              type="button"
              data-mobile-book-entry="true"
              onClick={(event: MouseEvent<HTMLButtonElement>) => onOpenBook(book, readerOpeningSource(event.currentTarget) ?? event.currentTarget)}
              className="flex w-full gap-4 rounded-[22px] border border-slate-200 bg-white p-3 text-left shadow-sm shadow-slate-200/40"
            >
              <Cover book={book} size="small" className="h-28 w-20 shrink-0 rounded-[18px]" />
              <div className="min-w-0 flex-1 py-1">
                <div className="line-clamp-2 text-lg font-semibold leading-tight">{book.title}</div>
                <div className="mt-2 truncate text-sm text-slate-500">{bookMeta(book)}</div>
                <div className="mt-4 flex items-center gap-2">
                  <Progress value={book.progress} className="flex-1" />
                  <span className="w-9 text-right text-sm tabular-nums text-[#002FA7]">{book.progress}%</span>
                </div>
                <div className="mt-2 flex items-center gap-1 text-xs text-slate-500">
                  <Clock3 size={13} />
                  {formatDate(book.lastReadAt)}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MeView({
  user,
  summary,
  systemStatus,
  uploading,
  onUpload,
  onSettings,
  onImports,
  onLibrary,
  onLogout
}: {
  user: UserInfo | null;
  summary: Summary | null;
  systemStatus: SystemStatus | null;
  uploading: boolean;
  onUpload: () => void;
  onSettings: () => void;
  onImports: () => void;
  onLibrary: () => void;
  onLogout: () => void;
}) {
  const importTask = systemStatus?.currentImportTask;
  return (
    <div className="space-y-6">
      <AppHeader title="我的" />
      <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-950 text-white">
            <User size={28} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold">{user?.name ?? '当前用户'}</div>
            <div className="mt-1 truncate text-sm text-slate-500">{user?.email ?? '未登录'}</div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <MiniStat label="总读物" value={String(summary?.totalBooks ?? 0)} />
          <MiniStat label="最近同步" value={summary?.latestSyncAt ? '有进度' : '暂无'} />
        </div>
      </section>
      <section className="space-y-3">
        <MenuButton icon={UploadCloud} label={uploading ? '上传中...' : '上传读物'} value="EPUB / CBZ / ZIP" onClick={onUpload} />
        <MenuButton icon={FolderOpen} label="导入任务" value={importTask ? `${importTask.progress}%` : '暂无任务'} onClick={onImports} />
        <MenuButton icon={Home} label="管理书库" value="筛选和批量管理" onClick={onLibrary} />
        <MenuButton icon={Settings} label="系统设置" value="监控文件夹和账户" onClick={onSettings} />
        <MenuButton icon={LogOut} label="退出登录" value="" onClick={onLogout} danger />
      </section>
    </div>
  );
}

function MenuButton({
  icon: Icon,
  label,
  value,
  onClick,
  danger = false
}: {
  icon: typeof UploadCloud;
  label: string;
  value: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-16 w-full items-center justify-between gap-4 rounded-[22px] border border-slate-200 bg-white px-4 text-left shadow-sm shadow-slate-200/40 transition active:scale-[0.99]">
      <span className="flex min-w-0 items-center gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', danger ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-[#002FA7]')}>
          <Icon size={19} />
        </span>
        <span className={cn('font-semibold', danger ? 'text-red-700' : 'text-slate-900')}>{label}</span>
      </span>
      {value ? <span className="truncate text-sm text-slate-500">{value}</span> : null}
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-[#F7F7F8] p-3">
      <div className="text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function EmptyLibrary({ onUpload, onSettings }: { onUpload: () => void; onSettings: () => void }) {
  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
      <h2 className="text-xl font-semibold">暂无读物</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">上传 EPUB/CBZ/ZIP，或添加监控文件夹后，就可以在手机上阅读。</p>
      <div className="mt-5 flex flex-col gap-3">
        <button type="button" onClick={onUpload} className="min-h-11 rounded-2xl bg-[#002FA7] px-4 text-sm font-semibold text-white">上传读物</button>
        <button type="button" onClick={onSettings} className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700">添加监控文件夹</button>
      </div>
    </section>
  );
}

function SoftEmpty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm shadow-slate-200/40">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-2 leading-6">{text}</p>
      {action && onAction ? <button type="button" onClick={onAction} className="mt-5 min-h-11 rounded-2xl bg-[#002FA7] px-5 font-semibold text-white">{action}</button> : null}
    </section>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return <div className="rounded-[22px] border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm shadow-slate-200/40">{label}</div>;
}
