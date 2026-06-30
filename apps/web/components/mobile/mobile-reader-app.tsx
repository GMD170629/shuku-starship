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
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import type { WorkView } from '../../types/work';
import { Cover } from '../book/cover';
import { cn } from '../ui/cn';

type MobileTab = 'home' | 'shelf' | 'me';
type ShelfFilter = 'all' | 'reading' | 'unread' | 'finished';
type BooksPayload = { ok: boolean; data?: { books: WorkView[]; total: number; page: number; pageSize: number; totalPages: number }; error?: { message: string } };
type ImportPayload = { ok: boolean; data?: { title: string; duplicate?: boolean }; error?: { message: string } };
type ContinueItem = { book: WorkView; progress: number; lastReadAt: string; chapter: string | null } | null;
type ReadingUnitView = { id: string; unitType: string; title: string; href?: string | null; sortOrder: number; volumeId?: string | null; mediaType?: string | null; size?: string | number | null };
type VolumeSectionView = { id: string; title: string; index: number; fileId: string; pageCount: number; coverUrl: string; progress?: number; lastReadAt?: string | null; position?: string | null; currentPage?: number | null; currentHref?: string | null; currentSectionIndex?: number | null; currentChapterTitle?: string | null; currentChapterSortOrder?: number | null };
type WorkDetailPayload = { ok: boolean; data?: { book: WorkView; readingUnits?: ReadingUnitView[]; readingUnitsPage?: PageMeta; volumeSections?: VolumeSectionView[] }; error?: { message: string } };
type Summary = { totalBooks: number; latestSyncAt: string | null };
type UserInfo = { email: string; name: string; role: string };
type SystemStatus = {
  currentImportTask: { progress: number; status: string } | null;
  latestImportTask: { status: string; progress: number; finishedAt?: string | null } | null;
};
type OpenBookHandler = (book: WorkView, sourceElement?: HTMLElement | null) => void;
type OpenReaderHandler = (book: WorkView, sourceElement?: HTMLElement | null, volumeId?: string | null, href?: string | null) => void;
type PageMeta = { page: number; pageSize: number; total: number; totalPages: number };
const displayFont = '"Songti SC", "STSong", "Noto Serif CJK SC", serif';
type MobileScaleStyle = CSSProperties & { '--mobile-scale'?: string };
const mobileDesignWidth = 426.5;
const sv = (value: number) => `calc(${value}px * var(--mobile-scale))`;
const MOBILE_SHELF_PAGE_SIZE = 24;
const MOBILE_CHAPTER_PAGE_SIZE = 50;
const emptyPageMeta: PageMeta = { page: 0, pageSize: MOBILE_SHELF_PAGE_SIZE, total: 0, totalPages: 1 };
const emptyChapterPageMeta: PageMeta = { page: 1, pageSize: MOBILE_CHAPTER_PAGE_SIZE, total: 0, totalPages: 1 };

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

function mergeBooks(current: WorkView[], next: WorkView[]) {
  const byId = new Map(current.map((book) => [book.id, book]));
  next.forEach((book) => byId.set(book.id, book));
  return Array.from(byId.values());
}

function pageMetaFromPayload(payload: BooksPayload): PageMeta {
  const data = payload.data;
  return {
    page: data?.page ?? 1,
    pageSize: data?.pageSize ?? MOBILE_SHELF_PAGE_SIZE,
    total: data?.total ?? 0,
    totalPages: data?.totalPages ?? 1
  };
}

function readerUrlForBook(book: WorkView, tab: MobileTab, volumeId?: string | null, href?: string | null) {
  const editionId = readableEditionId(book);
  if (!editionId) return null;
  const params = new URLSearchParams({ from: 'mobile', tab });
  const targetVolumeId = volumeId ?? book.recentVolumeId;
  if (targetVolumeId) params.set('volume', targetVolumeId);
  if (href) params.set('href', href);
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
  const scrollSectionRef = useRef<HTMLElement>(null);
  const detailRequestSeqRef = useRef(0);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<MobileTab>('home');
  const [books, setBooks] = useState<WorkView[]>([]);
  const [searchBooks, setSearchBooks] = useState<WorkView[]>([]);
  const [booksMeta, setBooksMeta] = useState<PageMeta>(emptyPageMeta);
  const [searchMeta, setSearchMeta] = useState<PageMeta>(emptyPageMeta);
  const [continueItem, setContinueItem] = useState<ContinueItem>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [searchText, setSearchText] = useState('');
  const [shelfFilter, setShelfFilter] = useState<ShelfFilter>('all');
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [detailBookId, setDetailBookId] = useState('');
  const [detailBook, setDetailBook] = useState<WorkView | null>(null);
  const [detailReadingUnits, setDetailReadingUnits] = useState<ReadingUnitView[]>([]);
  const [detailReadingUnitsPage, setDetailReadingUnitsPage] = useState<PageMeta>(emptyChapterPageMeta);
  const [detailVolumeSections, setDetailVolumeSections] = useState<VolumeSectionView[]>([]);
  const [detailSelectedVolumeId, setDetailSelectedVolumeId] = useState<string | null>(null);
  const [detailLoadingVolumeId, setDetailLoadingVolumeId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailLoadMoreError, setDetailLoadMoreError] = useState('');

  useEffect(() => {
    setMounted(true);
  }, []);

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

  const loadBooksPage = useCallback(async (pageNumber: number, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setLoadMoreError('');
    if (!append) setError('');
    try {
      const params = new URLSearchParams({
        page: String(pageNumber),
        pageSize: String(MOBILE_SHELF_PAGE_SIZE),
        visibility: 'active',
        sort: 'recent_read'
      });
      const payload = await fetch(`/api/works?${params.toString()}`).then((response) => readMobilePayload<BooksPayload>(response, '读取书架失败'));
      setBooks((current) => (append ? mergeBooks(current, payload.data?.books ?? []) : payload.data?.books ?? []));
      setBooksMeta(pageMetaFromPayload(payload));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '读取书架失败，请检查网络或服务器状态。';
      if (append) setLoadMoreError(message);
      else setError(message);
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  const loadSearchPage = useCallback(async (search: string, pageNumber: number, append = false) => {
    if (append) setSearchLoadingMore(true);
    else setSearchLoading(true);
    setLoadMoreError('');
    if (!append) setError('');
    try {
      const params = new URLSearchParams({
        page: String(pageNumber),
        pageSize: String(MOBILE_SHELF_PAGE_SIZE),
        visibility: 'active',
        sort: 'recent_read',
        search
      });
      const payload = await fetch(`/api/works?${params.toString()}`).then((response) => readMobilePayload<BooksPayload>(response, '搜索失败'));
      setSearchBooks((current) => (append ? mergeBooks(current, payload.data?.books ?? []) : payload.data?.books ?? []));
      setSearchMeta(pageMetaFromPayload(payload));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '搜索失败，请稍后重试。';
      if (append) setLoadMoreError(message);
      else setError(message);
    } finally {
      if (append) setSearchLoadingMore(false);
      else setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/dashboard/continue-reading').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/auth/me').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/system-status').then((response) => response.json()).catch(() => null)
    ])
      .then(([continuePayload, summaryPayload, userPayload, statusPayload]) => {
        if (!active) return;
        setContinueItem(continuePayload?.ok ? continuePayload.data.item : null);
        setSummary(summaryPayload?.ok ? summaryPayload.data : null);
        setUser(userPayload?.ok ? userPayload.data.user : null);
        setSystemStatus(statusPayload?.ok ? statusPayload.data : null);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取书架失败，请检查网络或服务器状态。');
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    setBooks([]);
    setBooksMeta(emptyPageMeta);
    void loadBooksPage(1);
  }, [loadBooksPage, reloadKey]);

  useEffect(() => {
    const search = searchText.trim();
    if (!search) {
      setSearchBooks([]);
      setSearchMeta(emptyPageMeta);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearchBooks([]);
      setSearchMeta(emptyPageMeta);
      void loadSearchPage(search, 1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadSearchPage, searchText]);

  const loadDetailChapterPage = useCallback(async (pageNumber: number, append = false) => {
    if (!detailBookId) return;
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    const requestedVolumeId = detailSelectedVolumeId;
    if (append) setDetailLoadingMore(true);
    else setDetailLoading(true);
    setDetailLoadMoreError('');
    if (!append) setDetailError('');
    try {
      const params = new URLSearchParams({
        chapterPage: String(pageNumber),
        chapterPageSize: String(MOBILE_CHAPTER_PAGE_SIZE)
      });
      if (requestedVolumeId) params.set('volumeId', requestedVolumeId);
      const payload = await fetch(`/api/works/${detailBookId}?${params.toString()}`).then((response) => readMobilePayload<WorkDetailPayload>(response, '读取图书详情失败'));
      if (detailRequestSeqRef.current !== requestSeq) return;
      if (payload.data?.book) {
        setDetailBook(payload.data.book);
        if (!detailSelectedVolumeId) {
          const firstVolumeId = payload.data.volumeSections?.[0]?.id ?? payload.data.book.volumes[0]?.id ?? null;
          setDetailSelectedVolumeId(payload.data.book.recentVolumeId ?? firstVolumeId);
        }
      }
      const nextUnits = payload.data?.readingUnits ?? [];
      setDetailReadingUnits((current) => {
        if (!append) return nextUnits;
        const byId = new Map(current.map((unit) => [unit.id, unit]));
        nextUnits.forEach((unit) => byId.set(unit.id, unit));
        return Array.from(byId.values());
      });
      setDetailReadingUnitsPage(payload.data?.readingUnitsPage ?? emptyChapterPageMeta);
      setDetailVolumeSections(payload.data?.volumeSections ?? []);
    } catch (reason) {
      if (detailRequestSeqRef.current !== requestSeq) return;
      const message = reason instanceof Error ? reason.message : '读取图书详情失败';
      if (append) setDetailLoadMoreError(message);
      else setDetailError(message);
    } finally {
      if (detailRequestSeqRef.current !== requestSeq) return;
      if (append) setDetailLoadingMore(false);
      else setDetailLoading(false);
      setDetailLoadingVolumeId((current) => (current === requestedVolumeId ? null : current));
    }
  }, [detailBookId, detailSelectedVolumeId]);

  useEffect(() => {
    if (!detailBookId) return;
    setDetailReadingUnits([]);
    setDetailReadingUnitsPage(emptyChapterPageMeta);
    void loadDetailChapterPage(1);
  }, [detailBookId, detailSelectedVolumeId, loadDetailChapterPage]);

  const baseShelfBooks = searchText.trim() ? searchBooks : books;
  const shelfBooks = useMemo(() => baseShelfBooks.filter((book) => shelfFilterMatches(book, shelfFilter)), [baseShelfBooks, shelfFilter]);
  const activeMeta = searchText.trim() ? searchMeta : booksMeta;
  const hasMoreShelfBooks = activeMeta.page > 0 && activeMeta.page < activeMeta.totalPages;
  const isLoadingMoreShelfBooks = searchText.trim() ? searchLoadingMore : loadingMore;
  const hasMoreDetailChapters = detailReadingUnitsPage.page > 0 && detailReadingUnitsPage.page < detailReadingUnitsPage.totalPages;
  const readingBooks = useMemo(
    () => books.filter((book) => book.lastReadAt).sort((left, right) => Date.parse(right.lastReadAt ?? '') - Date.parse(left.lastReadAt ?? '')),
    [books]
  );
  const recentBooks = readingBooks;

  const loadNextShelfPage = useCallback(() => {
    if (!hasMoreShelfBooks || loading || searchLoading || loadingMore || searchLoadingMore) return;
    const search = searchText.trim();
    if (search) void loadSearchPage(search, searchMeta.page + 1, true);
    else void loadBooksPage(booksMeta.page + 1, true);
  }, [booksMeta.page, hasMoreShelfBooks, loadBooksPage, loadSearchPage, loading, loadingMore, searchLoading, searchLoadingMore, searchMeta.page, searchText]);

  const loadNextDetailChapterPage = useCallback(() => {
    if (!hasMoreDetailChapters || detailLoading || detailLoadingMore) return;
    void loadDetailChapterPage(detailReadingUnitsPage.page + 1, true);
  }, [detailLoading, detailLoadingMore, detailReadingUnitsPage.page, hasMoreDetailChapters, loadDetailChapterPage]);

  useEffect(() => {
    const element = scrollSectionRef.current;
    if (!element || detailBookId || tab !== 'shelf') return undefined;
    const scrollElement = element;
    function onScroll() {
      if (scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 360) {
        loadNextShelfPage();
      }
    }
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scrollElement.removeEventListener('scroll', onScroll);
  }, [tab, detailBookId, loadNextShelfPage]);

  useEffect(() => {
    const element = scrollSectionRef.current;
    if (!element || !detailBookId) return undefined;
    const scrollElement = element;
    function onScroll() {
      if (scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 360) {
        loadNextDetailChapterPage();
      }
    }
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scrollElement.removeEventListener('scroll', onScroll);
  }, [detailBookId, loadNextDetailChapterPage]);

  function openBookDetail(book: WorkView) {
    setDetailBook(book);
    setDetailReadingUnits([]);
    setDetailReadingUnitsPage(emptyChapterPageMeta);
    const seededVolumes = book.volumes.map((volume) => ({
      id: volume.id,
      title: volume.title,
      index: volume.volumeIndex ?? volume.sortOrder ?? 0,
      fileId: volume.id,
      pageCount: volume.pageCount ?? volume.chapterCount ?? 0,
      coverUrl: volume.coverUrl,
      progress: volume.progress,
      lastReadAt: volume.lastReadAt,
      position: volume.position,
      currentPage: volume.currentPage,
      currentHref: volume.currentHref,
      currentSectionIndex: volume.currentSectionIndex,
      currentChapterTitle: volume.currentChapterTitle,
      currentChapterSortOrder: volume.currentChapterSortOrder
    }));
    setDetailVolumeSections(seededVolumes);
    setDetailSelectedVolumeId(book.recentVolumeId ?? seededVolumes[0]?.id ?? null);
    setDetailLoadingVolumeId(null);
    setDetailLoadMoreError('');
    setDetailBookId(book.id);
  }

  function closeBookDetail() {
    setDetailBookId('');
    setDetailSelectedVolumeId(null);
    setDetailLoadingVolumeId(null);
    setDetailReadingUnitsPage(emptyChapterPageMeta);
    setDetailLoadMoreError('');
    setDetailError('');
  }

  function selectDetailVolume(volumeId: string) {
    if (detailSelectedVolumeId === volumeId) return;
    setDetailLoadingVolumeId(volumeId);
    setDetailReadingUnits([]);
    setDetailReadingUnitsPage(emptyChapterPageMeta);
    setDetailLoadMoreError('');
    setDetailSelectedVolumeId(volumeId);
  }

  function openReader(book: WorkView, sourceElement?: HTMLElement | null, volumeId?: string | null, href?: string | null) {
    const url = readerUrlForBook(book, tab, volumeId, href);
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

  if (!mounted) {
    return <MobileLoadingShell />;
  }

  return (
    <main className="h-screen h-[100dvh] overflow-hidden bg-[#F7F1E7] text-[#211C17]">
      <div
        className="mx-auto flex h-screen h-[100dvh] min-h-0 max-w-[426.5px] flex-col overflow-hidden md:w-full md:max-w-none lg:flex-row"
        style={{
          '--mobile-scale': `min(1, calc(100vw / ${mobileDesignWidth}px))`,
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)'
        } as MobileScaleStyle}
      >
        <section
          ref={scrollSectionRef}
          data-pwa-scroll="true"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={{
            padding: `${sv(25)} clamp(${sv(27.5)}, 4vw, 44px) calc(${sv(88)} + env(safe-area-inset-bottom))`
          }}
        >
          {detailBookId && detailBook ? (
            <MobileBookDetailView
              book={detailBook}
              error={detailError}
              loading={detailLoading}
              readingUnits={detailReadingUnits}
              readingUnitsPage={detailReadingUnitsPage}
              volumeSections={detailVolumeSections}
              selectedVolumeId={detailSelectedVolumeId}
              loadingVolumeId={detailLoadingVolumeId}
              loadingMore={detailLoadingMore}
              loadMoreError={detailLoadMoreError}
              onBack={closeBookDetail}
              onSelectVolume={selectDetailVolume}
              onLoadMore={loadNextDetailChapterPage}
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
              allBooks={baseShelfBooks}
              error={error}
              filter={shelfFilter}
              libraryEmpty={books.length === 0}
              loading={loading}
              message={message}
              searchFocusSignal={searchFocusSignal}
              searchLoading={searchLoading}
              loadingMore={isLoadingMoreShelfBooks}
              hasMore={hasMoreShelfBooks}
              loadMoreError={loadMoreError}
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

        <TabletNavRail activeTab={tab} onSelectTab={selectTab} />

        <nav
          role="tablist"
          aria-label="移动端主导航"
          className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-[426.5px] grid-cols-3 border-t border-[#DED6CA] bg-[#FBF8F1]/95 backdrop-blur-xl md:max-w-none lg:hidden"
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

function MobileLoadingShell() {
  return (
    <main className="flex h-screen h-[100dvh] items-center justify-center bg-[#F7F1E7] px-6 text-sm text-[#70665C]">
      正在打开移动书架...
    </main>
  );
}

function TabletNavRail({ activeTab, onSelectTab }: { activeTab: MobileTab; onSelectTab: (tab: MobileTab) => void }) {
  return (
    <nav
      role="tablist"
      aria-label="iPad 主导航"
      className="hidden w-[96px] shrink-0 flex-col items-center border-r border-[#E2D8C9] bg-[#FBF8F1]/92 px-3 py-6 backdrop-blur-xl lg:order-first lg:flex"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-[#211C17] text-lg font-semibold text-[#FBF8F1]">
        书
      </div>
      <div className="mt-8 flex w-full flex-1 flex-col gap-3">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            aria-current={activeTab === key ? 'page' : undefined}
            onClick={() => onSelectTab(key)}
            className={cn(
              'flex min-h-[64px] w-full flex-col items-center justify-center gap-1 rounded-[18px] text-xs font-medium transition active:scale-[0.98]',
              activeTab === key ? 'bg-[#F0E4D3] text-[#C06A09]' : 'text-[#625A52] hover:bg-[#F3EBDD]'
            )}
          >
            <Icon size={23} strokeWidth={activeTab === key ? 2.8 : 2.1} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
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

      {!loading && continueItem ? (
        <div style={{ marginTop: sv(10) }}>
          <div className="lg:grid lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.75fr)] lg:gap-4">
            <ContinueCard item={continueItem} onOpenBook={onOpenBook} onOpenReader={onOpenReader} />
            <ReadingStatusPanel books={books} continueItem={continueItem} recentBooks={recentBooks} summary={summary} systemStatus={systemStatus} />
          </div>
        </div>
      ) : null}
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
      style={{ minHeight: `clamp(${sv(177)}, 24vw, 220px)`, borderRadius: sv(10), boxShadow: `0 ${sv(5)} ${sv(14)} rgba(80,55,32,0.035)` }}
    >
      <button
        type="button"
        onClick={() => onOpenBook(item.book, entryRef.current)}
        className="h-full shrink-0 transition active:scale-[0.99]"
        style={{ width: `clamp(${sv(120)}, 17vw, 160px)` }}
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

function ReadingStatusPanel({
  books,
  continueItem,
  recentBooks,
  summary,
  systemStatus
}: {
  books: WorkView[];
  continueItem: NonNullable<ContinueItem>;
  recentBooks: WorkView[];
  summary: Summary | null;
  systemStatus: SystemStatus | null;
}) {
  const importTask = systemStatus?.currentImportTask;
  const readingCount = books.filter((book) => book.progress > 0 && !isFinished(book)).length;
  return (
    <aside className="hidden rounded-[10px] border border-[#DCD4C6] bg-[#FBF8F1] p-4 shadow-[0_5px_14px_rgba(80,55,32,0.035)] lg:flex lg:flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-[#7B6A5B]">阅读状态</div>
          <div className="mt-1 text-lg font-semibold text-[#211C17]">{Math.round(continueItem.progress)}%</div>
        </div>
        <Cloud size={22} className="text-[#7A4B22]" strokeWidth={2.1} />
      </div>
      <BookProgress value={continueItem.progress} className="mt-3" style={{ height: 4 }} />
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MiniTabletStat label="总读物" value={String(summary?.totalBooks ?? books.length)} />
        <MiniTabletStat label="在读" value={String(readingCount)} />
      </div>
      <div className="mt-4 border-t border-[#E4D9C8] pt-4 text-sm leading-6 text-[#6B6259]">
        {importTask ? `正在导入 ${Math.round(importTask.progress)}%` : summary?.latestSyncAt ? `最近同步 ${formatCompactDate(summary.latestSyncAt)}` : 'NAS 已连接，等待同步进度'}
      </div>
      <div className="mt-auto pt-4 text-xs text-[#8B8177]">
        最近阅读 {recentBooks.length} 本
      </div>
    </aside>
  );
}

function MiniTabletStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-[#E1D8CB] bg-[#F6F0E6] p-3">
      <div className="text-base font-semibold text-[#211C17]">{value}</div>
      <div className="mt-1 text-xs text-[#766A5F]">{label}</div>
    </div>
  );
}

function RecentCoverRail({ books, onOpenBook }: { books: WorkView[]; onOpenBook: OpenBookHandler }) {
  return (
    <div
      data-pwa-scroll-x="true"
      className="-mx-1 flex overflow-x-auto overflow-y-hidden px-1"
      style={{ gap: sv(10.5), paddingBottom: sv(8), scrollbarWidth: 'none' }}
    >
      {books.map((book) => (
        <button
          key={book.id}
          type="button"
          data-mobile-book-entry="true"
          onClick={(event) => onOpenBook(book, event.currentTarget)}
          className="shrink-0 transition active:scale-[0.98]"
          style={{ width: `clamp(${sv(72)}, 11vw, 96px)` }}
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
  libraryEmpty,
  loading,
  loadingMore,
  hasMore,
  loadMoreError,
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
  libraryEmpty: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMoreError: string;
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
      <div className="space-y-3 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:items-center md:gap-3 md:space-y-0 lg:grid-cols-[minmax(0,1fr)_360px]">
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
      {loadMoreError ? <Notice tone="error">{loadMoreError}</Notice> : null}
      {loading ? <LoadingBlock label="正在读取书架..." /> : null}
      {searchLoading ? <LoadingBlock label="正在搜索..." /> : null}

      {!loading && libraryEmpty && !searchText.trim() ? <EmptyLibrary onUpload={onUpload} /> : null}
      {!loading && !libraryEmpty && books.length === 0 ? (
        hasMore ? (
          <SoftEmpty title="当前已加载内容暂无匹配" text="继续下滑会加载更多书架内容，也可以切换筛选条件查看其他读物。" />
        ) : (
          <SoftEmpty title={searchText.trim() ? '没有找到读物' : '暂无匹配读物'} text={searchText.trim() ? '换一个关键词或筛选条件再试。' : '切换筛选条件可以查看其他读物。'} />
        )
      ) : null}
      {!loading && books.length > 0 ? <CompactBookGrid books={books} onOpenBook={onOpenBook} /> : null}
      {!loading && loadingMore && allBooks.length > 0 ? <LoadingBlock label="正在加载更多..." /> : null}
    </div>
  );
}

function CompactBookGrid({ books, onOpenBook, preview = false }: { books: WorkView[]; onOpenBook: OpenBookHandler; preview?: boolean }) {
  const displayBooks = preview ? repeatBooks(books, 9) : books;
  return (
    <div
      className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      style={{
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
  readingUnitsPage,
  volumeSections,
  selectedVolumeId,
  loadingVolumeId,
  loadingMore,
  loadMoreError,
  onBack,
  onSelectVolume,
  onLoadMore,
  onOpenReader
}: {
  book: WorkView;
  error: string;
  loading: boolean;
  readingUnits: ReadingUnitView[];
  readingUnitsPage: PageMeta;
  volumeSections: VolumeSectionView[];
  selectedVolumeId: string | null;
  loadingVolumeId: string | null;
  loadingMore: boolean;
  loadMoreError: string;
  onBack: () => void;
  onSelectVolume: (volumeId: string) => void;
  onLoadMore: () => void;
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
    coverUrl: volume.coverUrl,
    progress: volume.progress,
    lastReadAt: volume.lastReadAt,
    position: volume.position,
    currentPage: volume.currentPage,
    currentHref: volume.currentHref,
    currentSectionIndex: volume.currentSectionIndex,
    currentChapterTitle: volume.currentChapterTitle,
    currentChapterSortOrder: volume.currentChapterSortOrder
  }));
  const activeVolumeId = selectedVolumeId ?? book.recentVolumeId ?? visibleVolumes[0]?.id ?? null;
  const activeVolume = visibleVolumes.find((volume) => volume.id === activeVolumeId) ?? null;
  const chapterRows = detailChapterRows(book, readingUnits, activeVolume);
  const showChapterSkeleton = loading && !loadingVolumeId && chapterRows.length === 0;
  const chapterMeta = readingUnitsPage.total > 0 ? `已加载 ${chapterRows.length} / 共 ${readingUnitsPage.total}` : chapterRows.length > 0 ? `${chapterRows.length} 项` : '目录';
  const hasMoreChapters = readingUnitsPage.page > 0 && readingUnitsPage.page < readingUnitsPage.totalPages;

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

      <section className="flex items-center lg:items-start" style={{ gap: `clamp(${sv(16)}, 3vw, 32px)`, paddingTop: sv(2), paddingBottom: sv(4) }}>
        <div ref={coverRef} className="shrink-0" style={{ width: `clamp(${sv(116)}, 18vw, 168px)` }}>
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

      <section className="grid grid-cols-3 border-y border-[#E1D8CB]" style={{ paddingTop: sv(11), paddingBottom: sv(11), gap: `clamp(${sv(10)}, 2vw, 22px)` }}>
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
              const selected = volume.id === activeVolumeId;
              const volumeLoading = loadingVolumeId === volume.id;
              return (
                <button
                  key={volume.id}
                  type="button"
                  onClick={() => onSelectVolume(volume.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center border font-medium transition active:scale-[0.98]',
                    selected ? 'border-[#B7660B] bg-[#FFF5E7] text-[#8D4E07]' : 'border-[#DED5C7] bg-[#FBF8F1] text-[#5E5349]'
                  )}
                  style={{ minHeight: `max(44px, ${sv(36)})`, borderRadius: sv(999), paddingLeft: sv(14), paddingRight: sv(14), fontSize: sv(12) }}
                  aria-busy={volumeLoading || undefined}
                >
                  {volumeLoading ? <span className="shrink-0 animate-spin rounded-full border-current border-t-transparent" style={{ width: sv(10), height: sv(10), borderWidth: sv(1.5), marginRight: sv(6) }} aria-hidden="true" /> : null}
                  {volume.title || `第 ${index + 1} 卷`}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <SectionTitle title="章节" meta={showChapterSkeleton ? '目录' : chapterMeta} />
        <div className="overflow-hidden border-y border-[#E1D8CB]">
          {showChapterSkeleton ? (
            <ChapterListSkeleton />
          ) : chapterRows.length > 0 ? chapterRows.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => onOpenReader(book, coverRef.current, row.volumeId ?? activeVolumeId, row.href)}
              className={cn('flex w-full items-center text-left transition active:bg-[#EFE4D6]', row.read && !row.current ? 'text-[#92877B]' : 'text-[#4D443C]')}
              style={{ minHeight: `max(44px, ${sv(40)})`, gap: sv(11), borderBottom: '1px solid #E8DED1', fontSize: sv(13) }}
            >
              <span
                className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold', row.current ? 'bg-[#B7660B] text-white' : row.read ? 'bg-[#EAE1D3] text-[#8B8177]' : 'bg-transparent text-[#8B8177]')}
                style={{ height: sv(22), width: sv(22), fontSize: sv(10) }}
              >
                {row.current ? '读' : row.read ? '✓' : row.indexLabel}
              </span>
              <span className={cn('min-w-0 flex-1 truncate', row.current ? 'font-semibold' : 'font-medium')}>{row.title}</span>
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
        {loadingMore ? (
          <div className="flex items-center justify-center text-[#8B8177]" style={{ minHeight: `max(44px, ${sv(38)})`, fontSize: sv(12) }}>正在加载更多章节...</div>
        ) : loadMoreError ? (
          <button
            type="button"
            onClick={onLoadMore}
            className="flex w-full items-center justify-center font-medium text-[#8D4E07]"
            style={{ minHeight: `max(44px, ${sv(38)})`, fontSize: sv(12) }}
          >
            加载失败，点按重试
          </button>
        ) : hasMoreChapters ? (
          <div className="flex items-center justify-center text-[#8B8177]" style={{ minHeight: `max(38px, ${sv(34)})`, fontSize: sv(11.5) }}>继续下滑加载更多</div>
        ) : null}
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

function ChapterListSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="正在加载章节目录">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="flex w-full items-center animate-pulse"
          style={{ minHeight: `max(44px, ${sv(40)})`, gap: sv(11), borderBottom: '1px solid #E8DED1' }}
        >
          <span className="shrink-0 rounded-full bg-[#E8DED1]" style={{ height: sv(22), width: sv(22) }} />
          <span className="min-w-0 flex-1">
            <span className="block rounded-full bg-[#E8DED1]" style={{ height: sv(10), width: index % 2 === 0 ? '54%' : '68%' }} />
            <span className="mt-2 block rounded-full bg-[#EFE6D9]" style={{ height: sv(7), width: index % 2 === 0 ? '30%' : '42%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function contentStatsLabel(book: WorkView, readingUnits: ReadingUnitView[], volumeSections: VolumeSectionView[]) {
  const volumeCount = volumeSections.length || book.volumeCount || book.volumes.length;
  const chapterCount = volumeCount > 1 ? (book.chapterCount || book.totalUnits || readingUnits.length) : (readingUnits.length || book.chapterCount || book.totalUnits);
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

function normalizeReaderHref(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value).split('#')[0].replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.split('#')[0].replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  }
}

function detailChapterRows(book: WorkView, readingUnits: ReadingUnitView[], activeVolume: VolumeSectionView | null) {
  const progress = activeVolume?.progress ?? book.progress;
  const hasReadingPosition = Boolean(activeVolume?.lastReadAt || book.lastReadAt || (book.chapter && book.chapter !== '未开始'));
  if (readingUnits.length > 0) {
    const savedHref = normalizeReaderHref(activeVolume?.currentHref ?? book.currentHref);
    const savedSortOrder = activeVolume?.currentChapterSortOrder ?? book.currentChapterSortOrder;
    const savedSectionIndex = activeVolume?.currentSectionIndex ?? book.currentSectionIndex;
    const exactIndex = readingUnits.findIndex((unit, index) => {
      if (savedHref && unit.href && normalizeReaderHref(unit.href) === savedHref) return true;
      if (typeof savedSortOrder === 'number' && unit.sortOrder === savedSortOrder) return true;
      if (typeof savedSectionIndex === 'number' && index === savedSectionIndex) return true;
      return false;
    });
    const currentIndex = exactIndex >= 0 ? exactIndex : Math.max(0, Math.min(readingUnits.length - 1, Math.round((progress / 100) * Math.max(0, readingUnits.length - 1))));
    return readingUnits.map((unit, absoluteIndex) => {
      const current = absoluteIndex === currentIndex && hasReadingPosition && progress < 100;
      return {
        key: unit.id,
        title: unit.title || `第 ${unit.sortOrder || absoluteIndex + 1} 章`,
        indexLabel: String((unit.sortOrder || absoluteIndex + 1) % 100).padStart(2, '0'),
        read: !current && (absoluteIndex < currentIndex || progress >= 100),
        current,
        volumeId: unit.volumeId ?? activeVolume?.id ?? null,
        href: unit.href ?? null
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
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <MiniStat label="总读物" value={String(summary?.totalBooks ?? 0)} />
          <MiniStat label="最近同步" value={summary?.latestSyncAt ? '有进度' : '暂无'} />
          <MiniStat label="导入状态" value={importTask ? `${importTask.progress}%` : latestImport ? latestImport.status : '空闲'} />
          <MiniStat label="模式" value="PWA" />
        </div>
      </section>
      <section className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
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
