'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookView } from '../../lib/books';
import { ComicReader, type ComicImageFit, type ComicMode } from './comic-reader';
import { EbookReader } from './epub-reader';
import { ReaderShell, type EbookFlow, type ReaderControls, type ReaderFontFamily, type ReaderKind, type ReaderNavigationItem, type ReaderProgress, type ReaderSettings, type ReaderTheme } from './reader-shell';

type ProgressPayload = {
  id?: string;
  readerType: string;
  position: string;
  page?: number | null;
  percent: number;
  extra: string | Record<string, unknown>;
};

type BootstrapPayload = {
  ok: boolean;
  data?: {
    book: BookView;
    readerType: 'ebook' | 'comic' | 'unknown';
    progress: ProgressPayload | null;
    preferences: {
      global?: Record<string, unknown>;
      ebook?: Record<string, unknown>;
      comic?: Record<string, unknown>;
      pdf?: Record<string, unknown>;
    };
    readingUnits?: Array<{ title: string; sortOrder: number }>;
    pages?: Array<{ pageIndex: number; title?: string }>;
    pageCount?: number;
  };
  error?: { message: string };
};

const defaultProgress: ReaderProgress = {
  page: 1,
  total: null,
  percent: 0,
  position: '',
  label: '正在定位'
};

const defaultSettings: ReaderSettings = {
  theme: 'night',
  fontSize: 18,
  lineHeight: 1.9,
  pageWidth: 960,
  fontFamily: 'system',
  ebookFlow: 'paginated',
  zoom: 1,
  comicDirection: 'ltr',
  comicMode: 'single',
  imageFit: 'width',
  reversePages: false
};

function readerTypeForBook(book: BookView | null): ReaderKind | 'unknown' {
  if (!book) return 'unknown';
  if (book.formatValue === 'EPUB') return 'epub';
  if (book.formatValue === 'COMIC') return 'comic';
  return 'unknown';
}

function preferenceTypeForReader(readerType: ReaderKind | 'unknown') {
  if (readerType === 'epub') return 'ebook';
  if (readerType === 'comic') return 'comic';
  return null;
}

function safeRecord(value: unknown) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCache<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable in private browsing.
  }
}

function progressCacheKey(bookId: string) {
  return `shuku:reader:progress:${bookId}`;
}

function settingsCacheKey(type: string) {
  return `shuku:reader:preferences:${type}`;
}

function coerceSettings(current: ReaderSettings, savedSettings: Record<string, unknown>) {
  const savedTheme = typeof savedSettings.theme === 'string' && ['day', 'warm', 'night', 'black'].includes(savedSettings.theme)
    ? savedSettings.theme as ReaderTheme
    : savedSettings.theme === 'light'
      ? 'day'
      : savedSettings.theme === 'dark'
        ? 'night'
        : undefined;
  const savedFont = typeof savedSettings.fontFamily === 'string' && ['system', 'serif', 'sans'].includes(savedSettings.fontFamily)
    ? savedSettings.fontFamily as ReaderFontFamily
    : undefined;
  const savedFlow = savedSettings.ebookFlow === 'scrolled' || savedSettings.ebookFlow === 'paginated'
    ? savedSettings.ebookFlow as EbookFlow
    : undefined;
  const savedComicMode = savedSettings.mode === 'continuous' || savedSettings.mode === 'single'
    ? savedSettings.mode as ComicMode
    : savedSettings.mode === 'scroll'
      ? 'continuous'
      : undefined;
  const savedFit = savedSettings.imageFit === 'width' || savedSettings.imageFit === 'height' || savedSettings.imageFit === 'contain' || savedSettings.imageFit === 'original'
    ? savedSettings.imageFit as ComicImageFit
    : undefined;

  return {
    ...current,
    fontSize: typeof savedSettings.fontSize === 'number' ? savedSettings.fontSize : current.fontSize,
    lineHeight: typeof savedSettings.lineHeight === 'number' ? savedSettings.lineHeight : current.lineHeight,
    pageWidth: typeof savedSettings.pageWidth === 'number' ? savedSettings.pageWidth : current.pageWidth,
    zoom: typeof savedSettings.zoom === 'number' ? savedSettings.zoom : current.zoom,
    theme: savedTheme ?? current.theme,
    fontFamily: savedFont ?? current.fontFamily,
    ebookFlow: savedFlow ?? current.ebookFlow,
    comicDirection: savedSettings.readingDirection === 'rtl' || savedSettings.readingDirection === 'ltr' ? savedSettings.readingDirection : current.comicDirection,
    comicMode: savedComicMode ?? current.comicMode,
    imageFit: savedFit ?? current.imageFit,
    reversePages: typeof savedSettings.reversePages === 'boolean' ? savedSettings.reversePages : current.reversePages
  };
}

function progressFromPayload(savedProgress: ProgressPayload | null | undefined) {
  if (!savedProgress) return null;
  const extra = safeRecord(savedProgress.extra);
  return {
    progress: {
      page: savedProgress.page ?? (typeof extra.pageIndex === 'number' ? extra.pageIndex : 1),
      total: typeof extra.totalPages === 'number' ? extra.totalPages : null,
      percent: savedProgress.percent,
      position: typeof extra.cfi === 'string' ? extra.cfi : savedProgress.position ?? '',
      label: savedProgress.readerType === 'comic' && (savedProgress.page || extra.pageIndex)
        ? `第 ${savedProgress.page ?? extra.pageIndex} 页`
        : '正在定位'
    } satisfies ReaderProgress,
    extra
  };
}

export function ReaderPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [progress, setProgress] = useState<ReaderProgress>(defaultProgress);
  const [progressExtra, setProgressExtra] = useState<Record<string, unknown>>({});
  const [controls, setControls] = useState<ReaderControls | null>(null);
  const [navigationItems, setNavigationItems] = useState<ReaderNavigationItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const bookRef = useRef<BookView | null>(null);
  const readerTypeRef = useRef<ReaderKind | 'unknown'>('unknown');
  const settingsRef = useRef(settings);
  const progressRef = useRef(progress);
  const progressExtraRef = useRef(progressExtra);
  const preferenceTypeRef = useRef<string | null>(null);
  const progressSyncTimerRef = useRef<number | null>(null);
  const settingsSyncTimerRef = useRef<number | null>(null);
  const lastProgressPayloadRef = useRef('');
  const lastSettingsPayloadRef = useRef('');

  const readerType = useMemo(() => readerTypeForBook(book), [book]);
  const preferenceType = preferenceTypeForReader(readerType);

  useEffect(() => {
    bookRef.current = book;
    readerTypeRef.current = readerType;
    settingsRef.current = settings;
    progressRef.current = progress;
    progressExtraRef.current = progressExtra;
    preferenceTypeRef.current = preferenceType;
  }, [book, preferenceType, progress, progressExtra, readerType, settings]);

  useEffect(() => {
    const cached = readCache<{ progress: ReaderProgress; extra: Record<string, unknown> }>(progressCacheKey(bookId));
    if (cached) {
      setProgress(cached.progress);
      setProgressExtra(cached.extra ?? {});
    }

    let active = true;
    fetch(`/api/reader/${bookId}/bootstrap`)
      .then((response) => response.json() as Promise<BootstrapPayload>)
      .then((payload) => {
        if (!active) return;
        if (!payload.ok || !payload.data) throw new Error(payload.error?.message ?? '读取阅读器启动信息失败');
        const { book: nextBook, progress: savedProgress, preferences, readerType: bootstrapReaderType } = payload.data;
        setBook(nextBook);

        const nextReaderType = bootstrapReaderType === 'comic' ? 'comic' : bootstrapReaderType === 'ebook' ? 'epub' : 'unknown';
        const nextPreferenceType = preferenceTypeForReader(nextReaderType);
        if (nextPreferenceType) {
          const cachedSettings = readCache<ReaderSettings>(settingsCacheKey(nextPreferenceType));
          const serverSettings = safeRecord(preferences[nextPreferenceType]);
          setSettings(coerceSettings(cachedSettings ?? defaultSettings, serverSettings));
        }

        const parsedProgress = progressFromPayload(savedProgress);
        if (parsedProgress) {
          setProgress(parsedProgress.progress);
          setProgressExtra(parsedProgress.extra);
        }

        if (nextReaderType === 'comic') {
          const pages: Array<{ pageIndex: number; title?: string }> = payload.data.pages?.length ? payload.data.pages : Array.from({ length: payload.data.pageCount ?? 0 }, (_, index) => ({ pageIndex: index + 1 }));
          setNavigationItems(pages.map((page) => ({ index: page.pageIndex, title: page.title || `第 ${page.pageIndex} 页` })));
        } else {
          setNavigationItems((payload.data.readingUnits ?? []).map((unit) => ({ index: unit.sortOrder, title: unit.title || `第 ${unit.sortOrder} 章` })));
        }
        setHydrated(true);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取阅读器启动信息失败');
      });
    return () => {
      active = false;
    };
  }, [bookId]);

  function progressPayload() {
    const currentBook = bookRef.current;
    const currentReaderType = readerTypeRef.current;
    if (!currentBook || currentReaderType === 'unknown') return null;
    const currentProgress = progressRef.current;
    return {
      readerType: currentReaderType,
      position: currentProgress.position,
      page: currentProgress.page,
      percent: currentProgress.percent,
      extra: progressExtraRef.current
    };
  }

  function sendProgress(useBeacon = false) {
    if (progressSyncTimerRef.current) {
      window.clearTimeout(progressSyncTimerRef.current);
      progressSyncTimerRef.current = null;
    }
    const currentBook = bookRef.current;
    const payload = progressPayload();
    if (!currentBook || !payload) return;
    const serialized = JSON.stringify(payload);
    if (serialized === lastProgressPayloadRef.current && !useBeacon) return;
    lastProgressPayloadRef.current = serialized;
    const url = `/api/books/${currentBook.id}/progress`;
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([serialized], { type: 'application/json' }));
      return;
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      keepalive: useBeacon
    }).catch(() => undefined);
  }

  function scheduleProgressSync() {
    if (progressSyncTimerRef.current) return;
    progressSyncTimerRef.current = window.setTimeout(() => sendProgress(false), 7000);
  }

  function sendSettings() {
    if (settingsSyncTimerRef.current) {
      window.clearTimeout(settingsSyncTimerRef.current);
      settingsSyncTimerRef.current = null;
    }
    const currentPreferenceType = preferenceTypeRef.current;
    if (!currentPreferenceType) return;
    const payload = JSON.stringify({ settings: settingsRef.current });
    if (payload === lastSettingsPayloadRef.current) return;
    lastSettingsPayloadRef.current = payload;
    fetch(`/api/reader/preferences/${currentPreferenceType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).catch(() => undefined);
  }

  function scheduleSettingsSync() {
    if (settingsSyncTimerRef.current) return;
    settingsSyncTimerRef.current = window.setTimeout(sendSettings, 1500);
  }

  useEffect(() => {
    if (!book || readerType === 'unknown') return;
    writeCache(progressCacheKey(book.id), { progress, extra: progressExtra });
    scheduleProgressSync();
  }, [book, progress, progressExtra, readerType]);

  useEffect(() => {
    if (!hydrated || !preferenceType) return;
    writeCache(settingsCacheKey(preferenceType), settings);
    scheduleSettingsSync();
  }, [hydrated, preferenceType, settings]);

  useEffect(() => {
    function flushOnHidden() {
      if (document.visibilityState === 'hidden') sendProgress(true);
    }
    function flushOnPageHide() {
      sendProgress(true);
    }
    document.addEventListener('visibilitychange', flushOnHidden);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', flushOnHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, []);

  const handleProgress = useCallback((nextProgress: ReaderProgress, nextExtra?: Record<string, unknown>) => {
    setProgress(nextProgress);
    if (nextExtra) setProgressExtra((current) => ({ ...current, ...nextExtra }));
  }, []);

  const handleReaderError = useCallback((message: string) => {
    setError(message);
  }, []);

  function updateSettings(nextSettings: ReaderSettings) {
    setSettings(nextSettings);
  }

  function leaveReader() {
    sendProgress(true);
    if (bookRef.current) router.push(`/books/${bookRef.current.id}`);
  }

  if (error) return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 p-8 text-center text-red-200">{error}</div>;
  if (!book) return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 p-8 text-slate-200">正在打开阅读器...</div>;
  if (readerType === 'unknown') return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-950 p-8 text-center text-slate-200">该读物没有可读内容，或文件格式暂不支持。</div>;

  return (
    <ReaderShell
      bookId={book.id}
      title={book.title}
      readerType={readerType}
      progress={progress}
      controls={controls}
      settings={settings}
      navigationItems={navigationItems}
      onBack={leaveReader}
      onSettingsChange={updateSettings}
    >
      {(readerEvents) => readerType === 'epub' ? (
        <EbookReader
          bookId={book.id}
          title={book.title}
          theme={settings.theme}
          fontSize={settings.fontSize}
          lineHeight={settings.lineHeight}
          pageWidth={settings.pageWidth}
          fontFamily={settings.fontFamily}
          ebookFlow={settings.ebookFlow}
          initialCfi={progress.position}
          initialScrollTop={typeof progressExtra.scrollTop === 'number' ? progressExtra.scrollTop : 0}
          onControls={setControls}
          onProgress={handleProgress}
          onActivity={readerEvents.enterImmersive}
          onTap={readerEvents.toggleControls}
        />
      ) : (
        <ComicReader
          book={book}
          dark={settings.theme === 'night' || settings.theme === 'black'}
          initialPage={progress.page}
          initialPosition={progress.position}
          mode={settings.comicMode}
          direction={settings.comicDirection}
          imageFit={settings.imageFit}
          zoom={settings.zoom}
          reversePages={settings.reversePages}
          onControls={setControls}
          onProgress={handleProgress}
          onActivity={readerEvents.enterImmersive}
          onTap={readerEvents.toggleControls}
          onError={handleReaderError}
        />
      )}
    </ReaderShell>
  );
}
