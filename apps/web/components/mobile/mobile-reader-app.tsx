'use client';

import {
  Bell,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Filter,
  MoreHorizontal,
  Home,
  Library,
  LogOut,
  Search,
  UploadCloud,
  User,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import type { WorkView } from '../../types/work';
import { Cover } from '../book/cover';
import { cn } from '../ui/cn';

type MobileTab = 'home' | 'shelf' | 'me';
type ShelfFilter = 'all' | 'reading' | 'unread' | 'finished';
type BooksPayload = { ok: boolean; data?: { books: WorkView[]; total: number }; error?: { message: string } };
type ImportPayload = { ok: boolean; data?: { title: string; duplicate?: boolean }; error?: { message: string } };
type ContinueItem = { book: WorkView; progress: number; lastReadAt: string; chapter: string | null } | null;
type ReadingUnitView = { id: string; unitType: string; title: string; href: string; sortOrder: number; mediaType?: string | null; size?: string | number | null };
type VolumeSectionView = { id: string; title: string; index: number; fileId: string; pageCount: number; coverUrl: string };
type WorkDetailPayload = { ok: boolean; data?: { book: WorkView; readingUnits?: ReadingUnitView[]; volumeSections?: VolumeSectionView[] }; error?: { message: string } };
type Summary = { totalBooks: number; latestSyncAt: string | null };
type UserInfo = { email: string; name: string; role: string };
type SystemStatus = {
  currentImportTask: { progress: number; status: string } | null;
  latestImportTask: { status: string; progress: number; finishedAt?: string | null } | null;
};
type OpenBookHandler = (book: WorkView, sourceElement?: HTMLElement | null) => void;
type OpenReaderHandler = (book: WorkView, sourceElement?: HTMLElement | null, volumeId?: string | null) => void;
const displayFont = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
type MobileScaleStyle = CSSProperties & { '--mobile-scale'?: string };
const mobileDesignWidth = 426.5;
const sv = (value: number) => `calc(${value}px * var(--mobile-scale))`;

const tabs: Array<{ key: MobileTab; label: string; icon: typeof Library }> = [
  { key: 'home', label: '首页', icon: Home },
  { key: 'shelf', label: '书架', icon: Library },
  { key: 'me', label: '我的', icon: User }
];

const shelfFilters: Array<{ key: ShelfFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'unread', label: '未读' },
  { key: 'finished', label: '已读' }
];

function readSavedTab(): MobileTab {
  if (typeof window === 'undefined') return 'home';
  const tabParam = new URLSearchParams(window.location.search).get('tab');
  if (tabParam === 'shelf' || tabParam === 'me' || tabParam === 'home') return tabParam;
  const saved = window.localStorage.getItem('shuku.mobile.tab');
  if (saved === 'shelf' || saved === 'me' || saved === 'home') return saved;
  return saved === 'search' || saved === 'reading' ? 'shelf' : 'home';
}

async function readMobilePayload<TPayload extends { ok: boolean; error?: { message?: string } }>(response: Response, fallbackMessage: string): Promise<TPayload> {
  const text = await response.text();
  let payload: TPayload | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as TPayload;
    } catch {
      throw new Error(response.ok ? '服务器返回了无法解析的响应，请稍后重试。' : `服务暂不可用（HTTP ${response.status}）`);
    }
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? fallbackMessage);
  }
  return payload;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '暂无';
  return new Date(value).toLocaleString();
}

function bookMeta(book: WorkView) {
  return `${book.author} · ${book.format}`;
}

function isComic(book: WorkView) {
  return book.type === 'comic' || book.formatValue === 'COMIC';
}

function isFinished(book: WorkView) {
  return book.progress >= 100 || book.statusValue === 'FINISHED';
}

function shelfFilterMatches(book: WorkView, filter: ShelfFilter) {
  if (filter === 'reading') return book.progress > 0 && !isFinished(book);
  if (filter === 'unread') return book.progress <= 0 && !isFinished(book);
  if (filter === 'finished') return isFinished(book);
  return true;
}

function openingCoverUrl(book: WorkView) {
  if (book.coverUrl) return book.coverUrl.replace(/size=(small|medium|large)/, 'size=large');
  return `/api/works/${book.id}/cover?size=large`;
}

function readableEditionId(book: WorkView) {
  return book.recentEditionId ?? book.editionId ?? book.primaryEditionId ?? book.editions.find((edition) => !edition.hidden)?.id ?? null;
}

function readerUrlForBook(book: WorkView, tab: MobileTab, volumeId?: string | null) {
  const editionId = readableEditionId(book);
  if (!editionId) return null;
  const params = new URLSearchParams({ from: 'mobile', tab });
  const targetVolumeId = volumeId ?? book.recentVolumeId;
  if (targetVolumeId) params.set('volume', targetVolumeId);
  return `/reader/${editionId}?${params.toString()}`;
}

function storeReaderOpeningContext(book: WorkView, sourceElement?: HTMLElement | null) {
  const editionId = readableEditionId(book);
  if (!editionId) return;
  const coverElement = sourceElement?.querySelector('[data-book-cover="true"]') ?? sourceElement;
  const rect = coverElement?.getBoundingClientRect();
  const payload = {
    editionId,
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
  const [tab, setTab] = useState<MobileTab>('home');
  const [books, setBooks] = useState<WorkView[]>([]);
  const [searchBooks, setSearchBooks] = useState<WorkView[]>([]);
  const [continueItem, setContinueItem] = useState<ContinueItem>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [searchText, setSearchText] = useState('');
  const [shelfFilter, setShelfFilter] = useState<ShelfFilter>('all');
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [detailBookId, setDetailBookId] = useState('');
  const [detailBook, setDetailBook] = useState<WorkView | null>(null);
  const [detailReadingUnits, setDetailReadingUnits] = useState<ReadingUnitView[]>([]);
  const [detailVolumeSections, setDetailVolumeSections] = useState<VolumeSectionView[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    setTab(readSavedTab());
  }, []);

  function selectTab(nextTab: MobileTab) {
    setDetailBookId('');
    setTab(nextTab);
    window.localStorage.setItem('shuku.mobile.tab', nextTab);
  }

  function goShelfSearch() {
    selectTab('shelf');
    setSearchFocusSignal((value) => value + 1);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      fetch('/api/works?pageSize=40&visibility=active&sort=recent_read').then((response) => readMobilePayload<BooksPayload>(response, '读取书架失败')),
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
        if (active) setError(reason instanceof Error ? reason.message : '读取书架失败，请检查网络或服务器状态。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    const search = searchText.trim();
    if (!search) {
      setSearchBooks([]);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/works?pageSize=40&visibility=active&sort=recent_read&search=${encodeURIComponent(search)}`)
        .then((response) => readMobilePayload<BooksPayload>(response, '搜索失败'))
        .then((payload) => {
          setSearchBooks(payload.data?.books ?? []);
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : '搜索失败，请稍后重试。'))
        .finally(() => setSearchLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    if (!detailBookId) return;
    let active = true;
    setDetailLoading(true);
    setDetailError('');
    fetch(`/api/works/${detailBookId}`)
      .then((response) => readMobilePayload<WorkDetailPayload>(response, '读取图书详情失败'))
      .then((payload) => {
        if (!active) return;
        if (payload.data?.book) setDetailBook(payload.data.book);
        setDetailReadingUnits(payload.data?.readingUnits ?? []);
        setDetailVolumeSections(payload.data?.volumeSections ?? []);
      })
      .catch((reason) => {
        if (active) setDetailError(reason instanceof Error ? reason.message : '读取图书详情失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [detailBookId]);

  const baseShelfBooks = searchText.trim() ? searchBooks : books;
  const shelfBooks = useMemo(() => baseShelfBooks.filter((book) => shelfFilterMatches(book, shelfFilter)), [baseShelfBooks, shelfFilter]);
  const readingBooks = useMemo(
    () => books.filter((book) => book.progress > 0).sort((left, right) => Date.parse(right.lastReadAt ?? '') - Date.parse(left.lastReadAt ?? '')),
    [books]
  );
  const recentBooks = useMemo(() => {
    const seen = new Set<string>();
    return [...readingBooks, ...books].filter((book) => {
      if (seen.has(book.id)) return false;
      seen.add(book.id);
      return true;
    });
  }, [books, readingBooks]);

  function openBookDetail(book: WorkView) {
    setDetailBook(book);
    setDetailReadingUnits([]);
    setDetailVolumeSections(book.volumes.map((volume) => ({
      id: volume.id,
      title: volume.title,
      index: volume.volumeIndex ?? volume.sortOrder ?? 0,
      fileId: volume.id,
      pageCount: volume.pageCount ?? volume.chapterCount ?? 0,
      coverUrl: volume.coverUrl
    })));
    setDetailBookId(book.id);
  }

  function closeBookDetail() {
    setDetailBookId('');
    setDetailError('');
  }

  function openReader(book: WorkView, sourceElement?: HTMLElement | null, volumeId?: string | null) {
    const url = readerUrlForBook(book, tab, volumeId);
    if (!url) return;
    storeReaderOpeningContext(book, sourceElement);
    router.push(url);
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
      const response = await fetch('/api/works/import', { method: 'POST', body: form });
      const text = await response.text();
      const payload = text ? JSON.parse(text) as ImportPayload : { ok: false, error: { message: response.ok ? '上传失败' : `上传失败（HTTP ${response.status}）` } };
      if (!payload.ok) throw new Error(payload.error?.message ?? '上传失败');
      setMessage(payload.data?.duplicate ? `《${payload.data.title}》已存在` : `《${payload.data?.title ?? file.name}》已上传`);
      setReloadKey((value) => value + 1);
      selectTab('shelf');
    } catch (reason) {
      setError(reason instanceof SyntaxError ? '上传失败：服务器返回了无法解析的响应，请检查反向代理上传体积限制。' : reason instanceof Error ? reason.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    router.replace('/login?next=/mobile');
  }

  return (
    <main className="h-screen h-[100dvh] overflow-hidden bg-[#F7F1E7] text-[#211C17]">
      <div
        className="mx-auto flex h-screen h-[100dvh] min-h-0 max-w-[426.5px] flex-col overflow-hidden"
        style={{
          '--mobile-scale': `min(1, calc(100vw / ${mobileDesignWidth}px))`,
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)'
        } as MobileScaleStyle}
      >
        <section
          data-pwa-scroll="true"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={{
            padding: `${sv(25)} ${sv(27.5)} calc(${sv(88)} + env(safe-area-inset-bottom))`
          }}
        >
          {detailBookId && detailBook ? (
            <MobileBookDetailView
              book={detailBook}
              error={detailError}
              loading={detailLoading}
              readingUnits={detailReadingUnits}
              volumeSections={detailVolumeSections}
              onBack={closeBookDetail}
              onOpenReader={openReader}
            />
          ) : null}

          {!detailBookId && tab === 'home' ? (
            <HomeView
              books={books}
              continueItem={continueItem}
              error={error}
              loading={loading}
              recentBooks={recentBooks}
              summary={summary}
              systemStatus={systemStatus}
              user={user}
              onGoMe={() => selectTab('me')}
              onGoShelf={() => selectTab('shelf')}
              onGoShelfSearch={goShelfSearch}
              onOpenBook={openBookDetail}
              onOpenReader={openReader}
              onUpload={() => uploadInputRef.current?.click()}
            />
          ) : null}

          {!detailBookId && tab === 'shelf' ? (
            <ShelfView
              books={shelfBooks}
              allBooks={books}
              error={error}
              filter={shelfFilter}
              loading={loading}
              message={message}
              searchFocusSignal={searchFocusSignal}
              searchLoading={searchLoading}
              searchText={searchText}
              onFilterChange={setShelfFilter}
              onOpenBook={openBookDetail}
              onSearchTextChange={setSearchText}
              onUpload={() => uploadInputRef.current?.click()}
            />
          ) : null}

          {!detailBookId && tab === 'me' ? (
            <MeView
              user={user}
              summary={summary}
              systemStatus={systemStatus}
              uploading={uploading}
              onUpload={() => uploadInputRef.current?.click()}
              onLogout={logout}
            />
          ) : null}
        </section>

        <nav
          role="tablist"
          aria-label="移动端主导航"
          className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-[426.5px] grid-cols-3 border-t border-[#DED6CA] bg-[#FBF8F1]/95 backdrop-blur-xl"
          style={{
            minHeight: sv(68),
            paddingLeft: sv(32),
            paddingRight: sv(32),
            paddingTop: sv(6),
            paddingBottom: `max(${sv(5)}, env(safe-area-inset-bottom))`
          }}
        >
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => selectTab(key)}
              className={cn(
                'flex flex-col items-center justify-center rounded-xl transition active:scale-[0.98]',
                tab === key ? 'text-[#C06A09]' : 'text-[#5F5A55]'
              )}
              style={{
                minHeight: `max(44px, ${sv(54)})`,
                gap: sv(3),
                fontSize: sv(11.5)
              }}
              aria-current={tab === key ? 'page' : undefined}
            >
              <Icon size={sv(24)} strokeWidth={tab === key ? 2.8 : 2.1} />
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </nav>

        <input
          ref={uploadInputRef}
          type="file"
          accept=".epub,.cbz,.zip,.pdf,application/epub+zip,application/zip,application/pdf"
          className="hidden"
          disabled={uploading}
          onChange={uploadBook}
        />
      </div>
    </main>
  );
}

function AppHeader({
  eyebrow,
  title,
  action
}: {
  eyebrow?: string;
  title: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-start justify-between" style={{ gap: sv(16) }}>
      <div className="min-w-0">
        {eyebrow ? (
          <div className="font-medium text-[#2C2925]" style={{ fontSize: sv(13.5), lineHeight: sv(18) }}>
            {eyebrow}
          </div>
        ) : null}
        <h1
          className="mt-0 font-medium tracking-normal text-[#211C17]"
          style={{ fontFamily: displayFont, fontSize: sv(34), lineHeight: sv(37) }}
        >
          {title}
        </h1>
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="flex min-h-11 shrink-0 items-center justify-center rounded-full border border-[#DED5C7] bg-[#FBF8F1] px-4 text-sm font-medium text-[#6F4420] transition active:scale-[0.98]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function StatusChip({ summary, systemStatus }: { summary: Summary | null; systemStatus: SystemStatus | null }) {
  const currentImport = systemStatus?.currentImportTask;
  const label = currentImport
    ? `导入 ${Math.round(currentImport.progress)}%`
    : summary?.latestSyncAt
      ? '进度已同步'
      : 'NAS 已连接';
  const dotClass = currentImport ? 'bg-[#C76E08]' : 'bg-[#5D8D51]';
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[#DCD8C9] bg-[#F6F0E6] font-medium text-[#302C27] shadow-[0_1px_0_rgba(255,255,255,0.55)]"
      style={{ minHeight: `max(44px, ${sv(32)})`, gap: sv(6), paddingLeft: sv(12), paddingRight: sv(12), fontSize: sv(10.5) }}
    >
      <Cloud size={sv(13)} strokeWidth={2} />
      {label}
      <span className={cn('rounded-full', dotClass)} style={{ height: sv(5), width: sv(5) }} />
    </span>
  );
}

function HeaderIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-[#DCD8C9] bg-[#F6F0E6] text-[#211C17] shadow-[0_1px_0_rgba(255,255,255,0.55)] transition active:scale-[0.98]"
      style={{ height: `max(44px, ${sv(32)})`, width: `max(44px, ${sv(32)})` }}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function SearchShortcut({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center border border-[#D8CFBF] bg-[#F8F2E8] text-left text-[#4E4841] transition active:scale-[0.99]"
      style={{ minHeight: `max(44px, ${sv(32)})`, gap: sv(11), borderRadius: sv(10), paddingLeft: sv(12), paddingRight: sv(12), fontSize: sv(12.5) }}
    >
      <Search size={sv(16)} strokeWidth={2.1} className="shrink-0 text-[#211C17]" />
      <span className="min-w-0 flex-1">在书架中搜索与筛选</span>
      <ChevronRight size={sv(15)} strokeWidth={2.2} className="shrink-0 text-[#211C17]" />
    </button>
  );
}

function HomeView({
  books,
  continueItem,
  error,
  loading,
  recentBooks,
  summary,
  systemStatus,
  user,
  onGoMe,
  onGoShelf,
  onGoShelfSearch,
  onOpenBook,
  onOpenReader,
  onUpload
}: {
  books: WorkView[];
  continueItem: ContinueItem;
  error: string;
  loading: boolean;
  recentBooks: WorkView[];
  summary: Summary | null;
  systemStatus: SystemStatus | null;
  user: UserInfo | null;
  onGoMe: () => void;
  onGoShelf: () => void;
  onGoShelfSearch: () => void;
  onOpenBook: OpenBookHandler;
  onOpenReader: OpenReaderHandler;
  onUpload: () => void;
}) {
  return (
    <div>
      <div>
        <div className="flex items-start justify-between" style={{ gap: sv(16) }}>
          <AppHeader eyebrow="晚上好，读者" title="首页" />
          <div className="flex items-center" style={{ gap: sv(8), paddingTop: sv(2) }}>
            <StatusChip summary={summary} systemStatus={systemStatus} />
            <HeaderIconButton label="我的" onClick={onGoMe}>
              <Bell size={sv(23)} strokeWidth={2} />
            </HeaderIconButton>
          </div>
        </div>
        <div style={{ marginTop: sv(5) }}>
          <SearchShortcut onClick={onGoShelfSearch} />
        </div>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <LoadingBlock label="正在读取书架..." /> : null}

      {!loading && continueItem ? <div style={{ marginTop: sv(10) }}><ContinueCard item={continueItem} onOpenBook={onOpenBook} onOpenReader={onOpenReader} /></div> : null}
      {!loading && !continueItem && books.length === 0 ? <EmptyLibrary onUpload={onUpload} /> : null}

      {!loading && recentBooks.length > 0 ? (
        <section style={{ marginTop: sv(15) }}>
          <RecentSectionHeader onAction={onGoShelf} />
          <RecentCoverRail books={recentBooks} onOpenBook={onOpenBook} />
        </section>
      ) : null}

      {!loading && books.length > 0 ? (
        <section className="border-t border-[#E2D8C9]" style={{ marginTop: sv(15), paddingTop: sv(11) }}>
          <ShelfOverviewHeader onAction={onGoShelfSearch} />
          <CompactBookGrid books={books.slice(0, 9)} onOpenBook={onOpenBook} preview />
        </section>
      ) : null}
    </div>
  );
}

function RecentSectionHeader({ onAction }: { onAction: () => void }) {
  return (
    <div className="flex items-center justify-between" style={{ minHeight: `max(44px, ${sv(24)})`, marginBottom: sv(12), gap: sv(12) }}>
      <h2
        className="font-medium tracking-normal text-[#211C17]"
        style={{ fontFamily: displayFont, fontSize: sv(17), lineHeight: sv(22) }}
      >
        最近阅读
      </h2>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center font-medium leading-none text-[#7A4B22]"
        style={{ minHeight: 44, gap: sv(6), fontSize: sv(11.5) }}
      >
        查看全部 <ChevronRight size={sv(14)} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function ShelfOverviewHeader({ onAction }: { onAction: () => void }) {
  return (
    <div className="flex items-center justify-between" style={{ minHeight: `max(44px, ${sv(24)})`, marginBottom: sv(17), gap: sv(12) }}>
      <h2
        className="font-medium tracking-normal text-[#211C17]"
        style={{ fontFamily: displayFont, fontSize: sv(17), lineHeight: sv(22) }}
      >
        书架概览
      </h2>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center rounded-full border border-[#DCD4C6] bg-[#F8F2E8] font-medium leading-none text-[#7A4B22]"
        style={{ minHeight: `max(44px, ${sv(21)})`, gap: sv(5), paddingLeft: sv(10), paddingRight: sv(10), fontSize: sv(9.5) }}
      >
        <Filter size={sv(10)} strokeWidth={2} />
        搜索与筛选 <ChevronRight size={sv(11)} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function ContinueCard({ item, onOpenBook, onOpenReader }: { item: NonNullable<ContinueItem>; onOpenBook: OpenBookHandler; onOpenReader: OpenReaderHandler }) {
  const entryRef = useRef<HTMLElement>(null);
  const progressLabel = `${Math.round(item.progress)}%`;

  return (
    <section
      ref={entryRef}
      data-mobile-book-entry="true"
      className="flex overflow-hidden border border-[#DCD4C6] bg-[#FBF8F1]"
      style={{ minHeight: sv(177), borderRadius: sv(10), boxShadow: `0 ${sv(5)} ${sv(14)} rgba(80,55,32,0.035)` }}
    >
      <button
        type="button"
        onClick={() => onOpenBook(item.book, entryRef.current)}
        className="h-full shrink-0 transition active:scale-[0.99]"
        style={{ width: sv(120) }}
        aria-label={`打开 ${item.book.title} 详情`}
      >
        <Cover book={item.book} size="medium" className="h-full w-full rounded-none shadow-none" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col" style={{ padding: `${sv(12)} ${sv(15)} ${sv(10)} ${sv(15)}` }}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <span
            className="inline-flex items-center border border-[#D7CCB9] bg-[#F8F2E8] text-[#7B6A5B]"
            style={{ height: sv(18), borderRadius: sv(4), paddingLeft: sv(7), paddingRight: sv(7), fontSize: sv(10.5) }}
          >
            {isComic(item.book) ? '漫画' : item.book.format}
          </span>
          <button
            type="button"
            onClick={() => onOpenBook(item.book, entryRef.current)}
            className="block w-full text-left"
            aria-label={`打开 ${item.book.title} 详情`}
          >
            <h2
              className="line-clamp-2 overflow-hidden break-words font-medium tracking-normal text-[#211C17]"
              style={{ marginTop: sv(7), fontFamily: displayFont, fontSize: sv(16.5), lineHeight: sv(20) }}
            >
              {item.book.title}
            </h2>
          </button>
          <div className="truncate text-[#4D443C]" style={{ marginTop: sv(5), fontSize: sv(11), lineHeight: sv(13) }}>{bookMeta(item.book)}</div>
        </div>
        <div className="shrink-0" style={{ marginTop: sv(8) }}>
          <div
            className="flex items-center justify-between leading-none text-[#7B6A5B]"
            style={{ marginBottom: sv(5), gap: sv(12), fontSize: sv(10.5) }}
          >
            <span className="min-w-0 truncate">{item.chapter ?? item.book.chapter}</span>
            <span className="shrink-0">{progressLabel}</span>
          </div>
          <BookProgress value={item.progress} style={{ height: sv(3) }} />
          <div className="flex" style={{ marginTop: sv(9), gap: sv(12) }}>
            <button
              type="button"
              onClick={() => onOpenReader(item.book, entryRef.current)}
              className="inline-flex flex-1 items-center justify-center bg-[#C76E08] font-semibold text-white shadow-sm transition active:scale-[0.98]"
              style={{ minHeight: `max(44px, ${sv(30)})`, borderRadius: sv(4), paddingLeft: sv(20), paddingRight: sv(20), fontSize: sv(13) }}
            >
              继续阅读
            </button>
            <button
              type="button"
              onClick={() => onOpenBook(item.book, entryRef.current)}
              className="flex shrink-0 items-center justify-center border border-[#DCD1BF] bg-[#FBF8F1] text-[#4D443C] transition active:scale-[0.98]"
              style={{ height: `max(44px, ${sv(30)})`, width: `max(44px, ${sv(30)})`, borderRadius: sv(5) }}
              aria-label="打开详情"
            >
              <MoreHorizontal size={sv(18)} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RecentCoverRail({ books, onOpenBook }: { books: WorkView[]; onOpenBook: OpenBookHandler }) {
  const displayBooks = repeatBooks(books, 5);
  return (
    <div
      data-pwa-scroll-x="true"
      className="-mx-1 flex overflow-x-auto overflow-y-hidden px-1"
      style={{ gap: sv(10.5), paddingBottom: sv(8), scrollbarWidth: 'none' }}
    >
      {displayBooks.map((book, index) => (
        <button
          key={`${book.id}-${index}`}
          type="button"
          data-mobile-book-entry="true"
          onClick={(event) => onOpenBook(book, event.currentTarget)}
          className="shrink-0 transition active:scale-[0.98]"
          style={{ width: sv(72) }}
          aria-label={`打开 ${book.title}`}
        >
          <Cover
            book={book}
            size="small"
            className="aspect-[0.66] w-full"
            style={{ borderRadius: sv(4), boxShadow: `0 ${sv(4)} ${sv(10)} rgba(70,47,29,0.16)` }}
          />
        </button>
      ))}
    </div>
  );
}

function ShelfView({
  books,
  allBooks,
  error,
  filter,
  loading,
  message,
  searchFocusSignal,
  searchLoading,
  searchText,
  onFilterChange,
  onOpenBook,
  onSearchTextChange,
  onUpload
}: {
  books: WorkView[];
  allBooks: WorkView[];
  error: string;
  filter: ShelfFilter;
  loading: boolean;
  message: string;
  searchFocusSignal: number;
  searchLoading: boolean;
  searchText: string;
  onFilterChange: (filter: ShelfFilter) => void;
  onOpenBook: OpenBookHandler;
  onSearchTextChange: (value: string) => void;
  onUpload: () => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocusSignal > 0) searchInputRef.current?.focus();
  }, [searchFocusSignal]);

  return (
    <div className="space-y-6">
      <AppHeader title="书架" action={{ label: '上传', onClick: onUpload }} />
      <div className="space-y-3">
        <div className="flex h-12 items-center gap-3 rounded-[18px] border border-[#DED5C7] bg-[#FBF8F1] px-4">
          <Search size={19} className="text-[#7A4B22]" />
          <input
            ref={searchInputRef}
            value={searchText}
            onChange={(event) => onSearchTextChange(event.target.value)}
            placeholder="搜索书名、作者、标签"
            aria-label="搜索书名、作者、标签"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[#211C17] outline-none placeholder:text-[#9A8E82]"
          />
        </div>
        <div className="grid grid-cols-4 gap-2 rounded-[18px] bg-[#EAE1D3] p-1">
          {shelfFilters.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => onFilterChange(key)}
              className={cn(
                'min-h-9 rounded-[14px] text-sm font-medium transition active:scale-[0.98]',
                filter === key ? 'bg-[#FBF8F1] text-[#7A4B22] shadow-sm' : 'text-[#766A5F]'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <LoadingBlock label="正在读取书架..." /> : null}
      {searchLoading ? <LoadingBlock label="正在搜索..." /> : null}

      {!loading && allBooks.length === 0 ? <EmptyLibrary onUpload={onUpload} /> : null}
      {!loading && allBooks.length > 0 && books.length === 0 ? (
        <SoftEmpty title={searchText.trim() ? '没有找到读物' : '暂无匹配读物'} text={searchText.trim() ? '换一个关键词或筛选条件再试。' : '切换筛选条件可以查看其他读物。'} />
      ) : null}
      {!loading && books.length > 0 ? <CompactBookGrid books={books} onOpenBook={onOpenBook} /> : null}
    </div>
  );
}

function CompactBookGrid({ books, onOpenBook, preview = false }: { books: WorkView[]; onOpenBook: OpenBookHandler; preview?: boolean }) {
  const displayBooks = preview ? repeatBooks(books, 9) : books;
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        columnGap: sv(12),
        rowGap: sv(18)
      }}
    >
      {displayBooks.map((book, index) => (
        <CompactBookTile key={`${book.id}-${index}`} book={book} onOpen={onOpenBook} preview={preview} />
      ))}
    </div>
  );
}

function repeatBooks(books: WorkView[], count: number) {
  if (books.length === 0) return [];
  return Array.from({ length: count }, (_, index) => books[index % books.length]);
}

function CompactBookTile({ book, onOpen, preview }: { book: WorkView; onOpen: OpenBookHandler; preview: boolean }) {
  return (
    <button
      type="button"
      data-mobile-book-entry="true"
      onClick={(event) => onOpen(book, event.currentTarget)}
      className="flex min-w-0 w-full flex-col items-center text-left transition active:scale-[0.98]"
    >
      <Cover
        book={book}
        size="small"
        className="aspect-[0.74] w-full"
        style={{ borderRadius: sv(4), boxShadow: `0 ${sv(4)} ${sv(10)} rgba(70,47,29,0.13)` }}
      />
      <div
        className="w-full truncate text-center font-medium text-[#2E2720]"
        style={{ marginTop: sv(6), fontSize: sv(11), lineHeight: sv(14) }}
      >
        {book.title}
      </div>
    </button>
  );
}

function MobileBookDetailView({
  book,
  error,
  loading,
  readingUnits,
  volumeSections,
  onBack,
  onOpenReader
}: {
  book: WorkView;
  error: string;
  loading: boolean;
  readingUnits: ReadingUnitView[];
  volumeSections: VolumeSectionView[];
  onBack: () => void;
  onOpenReader: OpenReaderHandler;
}) {
  const coverRef = useRef<HTMLDivElement>(null);
  const currentPosition = readingPositionLabel(book);
  const contentStats = contentStatsLabel(book, readingUnits, volumeSections);
  const visibleVolumes = volumeSections.length > 0 ? volumeSections : book.volumes.map((volume) => ({
    id: volume.id,
    title: volume.title,
    index: volume.volumeIndex ?? volume.sortOrder ?? 0,
    fileId: volume.id,
    pageCount: volume.pageCount ?? volume.chapterCount ?? 0,
    coverUrl: volume.coverUrl
  }));
  const selectedVolumeId = book.recentVolumeId ?? visibleVolumes[0]?.id ?? null;
  const chapterRows = detailChapterRows(book, readingUnits, visibleVolumes);

  return (
    <div className="space-y-3">
      <header className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center" style={{ minHeight: `max(44px, ${sv(36)})`, gap: sv(8) }}>
        <HeaderIconButton label="返回" onClick={onBack}>
          <ChevronLeft size={sv(22)} strokeWidth={2.3} />
        </HeaderIconButton>
        <div className="truncate text-center font-semibold text-[#302922]" style={{ fontSize: sv(14), lineHeight: sv(18) }}>图书详情</div>
        <div aria-hidden="true" />
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <LoadingBlock label="正在更新目录..." /> : null}

      <section className="flex items-center" style={{ gap: sv(16), paddingTop: sv(2), paddingBottom: sv(4) }}>
        <div ref={coverRef} className="shrink-0" style={{ width: sv(116) }}>
          <Cover
            book={book}
            size="large"
            className="aspect-[0.68] w-full"
            style={{ borderRadius: sv(7), boxShadow: `0 ${sv(12)} ${sv(26)} rgba(55,35,18,0.18)` }}
          />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <h1
            className="line-clamp-3 font-medium tracking-normal text-[#211C17]"
            style={{ fontFamily: displayFont, fontSize: sv(20), lineHeight: sv(25) }}
          >
            {book.title}
          </h1>
          <div className="mt-1 line-clamp-2 text-[#6B6259]" style={{ fontSize: sv(11.5), lineHeight: sv(16) }}>
            {book.author} · {book.format} · {contentStats}
          </div>
          <div className="mt-3">
            <div className="flex items-end justify-between text-[#5E5349]" style={{ gap: sv(10), fontSize: sv(11.5), lineHeight: sv(15) }}>
              <span className="min-w-0 truncate">{currentPosition}</span>
              <span className="shrink-0 font-semibold text-[#211C17]">{Math.round(book.progress)}%</span>
            </div>
            <BookProgress value={book.progress} style={{ height: sv(4), marginTop: sv(7) }} />
          </div>
          <button
            type="button"
            onClick={() => onOpenReader(book, coverRef.current)}
            className="mt-3 inline-flex w-full items-center justify-center bg-[#B7660B] font-semibold text-white shadow-[0_6px_14px_rgba(183,102,11,0.16)] transition active:scale-[0.99]"
            style={{ minHeight: `max(44px, ${sv(38)})`, borderRadius: sv(7), gap: sv(7), fontSize: sv(13.5) }}
          >
            <BookOpen size={sv(17)} strokeWidth={2.4} />
            继续阅读
          </button>
        </div>
      </section>

      <section className="grid grid-cols-3 border-y border-[#E1D8CB]" style={{ paddingTop: sv(11), paddingBottom: sv(11), gap: sv(10) }}>
        <ReadingMetric label="上次阅读" value={formatCompactDate(book.lastReadAt)} />
        <ReadingMetric label="当前位置" value={shortPositionLabel(book)} />
        <ReadingMetric label="阅读剩余" value={remainingEstimate(book)} />
      </section>

      {visibleVolumes.length > 1 ? (
        <section>
          <SectionTitle title="卷册" meta={`${visibleVolumes.length} 卷`} />
          <div
            data-pwa-scroll-x="true"
            className="-mx-1 flex overflow-x-auto px-1"
            style={{ gap: sv(8), paddingBottom: sv(6), scrollbarWidth: 'none' }}
          >
            {visibleVolumes.map((volume, index) => {
              const selected = volume.id === selectedVolumeId;
              return (
                <button
                  key={volume.id}
                  type="button"
                  onClick={() => onOpenReader(book, coverRef.current, volume.id)}
                  className={cn(
                    'shrink-0 border font-medium transition active:scale-[0.98]',
                    selected ? 'border-[#B7660B] bg-[#FFF5E7] text-[#8D4E07]' : 'border-[#DED5C7] bg-[#FBF8F1] text-[#5E5349]'
                  )}
                  style={{ minHeight: `max(44px, ${sv(36)})`, borderRadius: sv(999), paddingLeft: sv(14), paddingRight: sv(14), fontSize: sv(12) }}
                >
                  {volume.title || `第 ${index + 1} 卷`}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <SectionTitle title="章节" meta={chapterRows.length > 0 ? `${chapterRows.length} 项` : '目录'} />
        <div className="overflow-hidden border-y border-[#E1D8CB]">
          {chapterRows.length > 0 ? chapterRows.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => onOpenReader(book, coverRef.current, row.volumeId)}
              className={cn('flex w-full items-center text-left transition active:bg-[#EFE4D6]', row.current ? 'bg-[#FFF7EA] text-[#211C17]' : row.read ? 'text-[#92877B]' : 'text-[#4D443C]')}
              style={{ minHeight: `max(44px, ${sv(40)})`, gap: sv(11), borderBottom: '1px solid #E8DED1', fontSize: sv(13) }}
            >
              <span
                className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold', row.current ? 'bg-[#B7660B] text-white' : row.read ? 'bg-[#EAE1D3] text-[#8B8177]' : 'bg-transparent text-[#8B8177]')}
                style={{ height: sv(22), width: sv(22), fontSize: sv(10) }}
              >
                {row.current ? '读' : row.read ? '✓' : row.indexLabel}
              </span>
              <span className={cn('min-w-0 flex-1 truncate', row.current ? 'font-semibold' : 'font-medium')}>{row.title}</span>
              {row.current ? <span className="shrink-0 text-[#A65B08]" style={{ fontSize: sv(11) }}>当前</span> : null}
            </button>
          )) : (
            <button
              type="button"
              onClick={() => onOpenReader(book, coverRef.current)}
              className="flex w-full items-center justify-between text-left text-[#4D443C]"
              style={{ minHeight: `max(50px, ${sv(46)})`, fontSize: sv(13) }}
            >
              <span>{book.formatValue === 'EPUB' ? '全文阅读' : '暂无章节信息'}</span>
              <ChevronRight size={sv(16)} />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ReadingMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[#8B8177]" style={{ fontSize: sv(10.5), lineHeight: sv(14) }}>{label}</div>
      <div className="mt-1 truncate font-semibold text-[#211C17]" style={{ fontSize: sv(12), lineHeight: sv(16) }}>{value}</div>
    </div>
  );
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: sv(9), minHeight: sv(24), gap: sv(12) }}>
      <h2 className="font-medium text-[#211C17]" style={{ fontFamily: displayFont, fontSize: sv(18), lineHeight: sv(23) }}>{title}</h2>
      <span className="text-[#8B8177]" style={{ fontSize: sv(11), lineHeight: sv(15) }}>{meta}</span>
    </div>
  );
}

function contentStatsLabel(book: WorkView, readingUnits: ReadingUnitView[], volumeSections: VolumeSectionView[]) {
  const volumeCount = volumeSections.length || book.volumeCount || book.volumes.length;
  const chapterCount = readingUnits.length || book.chapterCount || book.totalUnits;
  const parts = [
    volumeCount > 0 ? `${volumeCount} 卷` : '',
    chapterCount > 0 ? `${chapterCount} ${isComic(book) ? '页' : '章'}` : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : book.size;
}

function readingPositionLabel(book: WorkView) {
  if (book.chapter && book.chapter !== '未开始') return `阅读至 ${book.chapter}`;
  if (book.progress > 0) return '阅读至上次停下的位置';
  return '还未开始阅读';
}

function shortPositionLabel(book: WorkView) {
  if (book.chapter && book.chapter !== '未开始') return book.chapter.replace(/^阅读至\s*/, '');
  if (book.progress > 0) return `${Math.round(book.progress)}%`;
  return '未开始';
}

function formatCompactDate(value: string | null | undefined) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function remainingEstimate(book: WorkView) {
  if (book.progress >= 100) return '已读完';
  if (book.progress <= 0) return '待开始';
  const remaining = Math.max(1, Math.round((100 - book.progress) / 12));
  return `约 ${remaining} 小时`;
}

function detailChapterRows(book: WorkView, readingUnits: ReadingUnitView[], volumes: VolumeSectionView[]) {
  const hasReadingPosition = Boolean(book.lastReadAt || (book.chapter && book.chapter !== '未开始'));
  if (readingUnits.length > 0) {
    const currentIndex = Math.max(0, Math.min(readingUnits.length - 1, Math.round((book.progress / 100) * Math.max(0, readingUnits.length - 1))));
    return readingUnits.map((unit, absoluteIndex) => {
      const current = absoluteIndex === currentIndex && hasReadingPosition && book.progress < 100;
      return {
        key: unit.id,
        title: unit.title || `第 ${unit.sortOrder || absoluteIndex + 1} 章`,
        indexLabel: String((unit.sortOrder || absoluteIndex + 1) % 100).padStart(2, '0'),
        read: !current && (absoluteIndex < currentIndex || book.progress >= 100),
        current,
        volumeId: null
      };
    });
  }
  if (volumes.length > 0) {
    const currentIndex = Math.max(0, volumes.findIndex((volume) => volume.id === book.recentVolumeId));
    return volumes.map((volume, absoluteIndex) => {
      const current = (volume.id === book.recentVolumeId || (!book.recentVolumeId && absoluteIndex === 0)) && hasReadingPosition && book.progress < 100;
      return {
        key: volume.id,
        title: volume.title || `第 ${absoluteIndex + 1} 卷`,
        indexLabel: String(absoluteIndex + 1).padStart(2, '0'),
        read: !current && (absoluteIndex < currentIndex || book.progress >= 100),
        current,
        volumeId: volume.id
      };
    });
  }
  return [];
}

function MeView({
  user,
  summary,
  systemStatus,
  uploading,
  onUpload,
  onLogout
}: {
  user: UserInfo | null;
  summary: Summary | null;
  systemStatus: SystemStatus | null;
  uploading: boolean;
  onUpload: () => void;
  onLogout: () => void;
}) {
  const importTask = systemStatus?.currentImportTask;
  const latestImport = systemStatus?.latestImportTask;
  return (
    <div className="space-y-6">
      <AppHeader title="我的" />
      <section className="rounded-[22px] border border-[#DED5C7] bg-[#FBF8F1] p-5 shadow-[0_10px_28px_rgba(80,55,32,0.05)]">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#211C17] text-white">
            <User size={28} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold">{user?.name ?? '当前用户'}</div>
            <div className="mt-1 truncate text-sm text-[#70665C]">{user?.email ?? '未登录'}</div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <MiniStat label="总读物" value={String(summary?.totalBooks ?? 0)} />
          <MiniStat label="最近同步" value={summary?.latestSyncAt ? '有进度' : '暂无'} />
        </div>
      </section>
      <section className="space-y-3">
        <MenuButton icon={UploadCloud} label={uploading ? '上传中...' : '上传读物'} value="EPUB / PDF / CBZ / ZIP" onClick={onUpload} />
        <StatusPanel
          title="导入状态"
          value={importTask ? `正在导入 ${importTask.progress}%` : latestImport ? `最近任务 ${latestImport.status}` : '暂无导入任务'}
        />
        <StatusPanel title="移动端模式" value="专注书架、搜索与阅读" />
        <MenuButton icon={LogOut} label="退出登录" value="" onClick={onLogout} danger />
      </section>
    </div>
  );
}

function StatusPanel({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-[20px] border border-[#DED5C7] bg-[#FBF8F1] px-4 py-3">
      <div className="text-sm font-semibold text-[#211C17]">{title}</div>
      <div className="mt-1 text-sm text-[#70665C]">{value}</div>
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
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-16 w-full items-center justify-between gap-4 rounded-[20px] border border-[#DED5C7] bg-[#FBF8F1] px-4 text-left transition active:scale-[0.99]"
      aria-label={value ? `${label}，${value}` : label}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', danger ? 'bg-red-50 text-red-600' : 'bg-[#EFE4D6] text-[#7A4B22]')}>
          <Icon size={19} />
        </span>
        <span className={cn('font-semibold', danger ? 'text-red-700' : 'text-[#211C17]')}>{label}</span>
      </span>
      {value ? <span className="truncate text-sm text-[#70665C]">{value}</span> : null}
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#DED5C7] bg-[#F5F0E6] p-3">
      <div className="text-lg font-semibold text-[#211C17]">{value}</div>
      <div className="mt-1 text-xs text-[#70665C]">{label}</div>
    </div>
  );
}

function BookProgress({ value, className = '', style }: { value: number; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-[#E7DED0]', className)} style={style}>
      <div className="h-full rounded-full bg-[#9B6A3A]" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function EmptyLibrary({ onUpload }: { onUpload: () => void }) {
  return (
    <section className="rounded-[22px] border border-[#DED5C7] bg-[#FBF8F1] p-5">
      <h2 className="text-xl font-semibold">暂无读物</h2>
      <p className="mt-2 text-sm leading-6 text-[#70665C]">上传 EPUB/PDF/CBZ/ZIP 后，就可以在手机上开始阅读。</p>
      <div className="mt-5 flex flex-col gap-3">
        <button type="button" onClick={onUpload} className="min-h-11 rounded-2xl bg-[#7A4B22] px-4 text-sm font-semibold text-white active:scale-[0.99]">上传读物</button>
      </div>
    </section>
  );
}

function SoftEmpty({ title, text }: { title: string; text: string }) {
  return (
    <section className="rounded-[22px] border border-[#DED5C7] bg-[#FBF8F1] p-5 text-sm text-[#70665C]">
      <h2 className="text-lg font-semibold text-[#211C17]">{title}</h2>
      <p className="mt-2 leading-6">{text}</p>
    </section>
  );
}

function Notice({ children, tone }: { children: string; tone: 'success' | 'error' }) {
  return (
    <div
      className={cn('rounded-2xl border px-4 py-3 text-sm', tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-[#D9C4A6] bg-[#FFF8E8] text-[#7A4B22]')}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return <div className="rounded-[22px] border border-[#DED5C7] bg-[#FBF8F1] p-5 text-sm text-[#70665C]" role="status" aria-live="polite">{label}</div>;
}
