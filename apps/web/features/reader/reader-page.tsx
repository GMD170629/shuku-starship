'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookView } from '../../lib/books';
import { ComicReader, type ComicDirection, type ComicImageFit, type ComicMode } from './comic-reader';
import { EbookReader } from './epub-reader';
import { ReaderShell, type ReaderControls, type ReaderKind, type ReaderProgress, type ReaderSettings } from './reader-shell';

type ProgressPayload = {
  id: string;
  readerType: string;
  position: string;
  page?: number | null;
  percent: number;
  extra: string;
};

const defaultProgress: ReaderProgress = {
  page: 1,
  total: null,
  percent: 0,
  position: '',
  label: '正在定位'
};

const defaultSettings: ReaderSettings = {
  dark: true,
  fontSize: 18,
  lineHeight: 1.9,
  pageWidth: 960,
  zoom: 1,
  comicDirection: 'ltr',
  comicMode: 'single',
  imageFit: 'width'
};

function readerTypeForBook(book: BookView | null): ReaderKind | 'unknown' {
  if (!book) return 'unknown';
  if (book.formatValue === 'EPUB') return 'epub';
  if (book.formatValue === 'COMIC') return 'comic';
  return 'unknown';
}

function safeExtra(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function ReaderPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<ReaderSettings>(defaultSettings);
  const [progress, setProgress] = useState<ReaderProgress>(defaultProgress);
  const [controls, setControls] = useState<ReaderControls | null>(null);

  const readerType = useMemo(() => readerTypeForBook(book), [book]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const bookPayload = (await fetch(`/api/books/${bookId}`).then((response) => response.json())) as { ok: boolean; data?: { book: BookView }; error?: { message: string } };
        if (!bookPayload.ok || !bookPayload.data?.book) throw new Error(bookPayload.error?.message ?? '读取读物失败');
        if (!active) return;
        setBook(bookPayload.data.book);

        const progressPayload = (await fetch(`/api/books/${bookId}/progress`).then((response) => response.json())) as { ok: boolean; data?: { progress: ProgressPayload | null } };
        const savedProgress = progressPayload.data?.progress;
        if (savedProgress && active) {
          const extra = safeExtra(savedProgress.extra);
          setProgress({
            page: savedProgress.page ?? 1,
            total: null,
            percent: savedProgress.percent,
            position: savedProgress.position ?? '',
            label: savedProgress.readerType === 'comic' && savedProgress.page ? `第 ${savedProgress.page} 页` : '正在定位'
          });
          setSettings((current) => ({
            ...current,
            zoom: typeof extra.zoom === 'number' ? extra.zoom : current.zoom,
            fontSize: typeof extra.fontSize === 'number' ? extra.fontSize : current.fontSize,
            lineHeight: typeof extra.lineHeight === 'number' ? extra.lineHeight : current.lineHeight
          }));
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '读取读物失败');
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [bookId]);

  useEffect(() => {
    if (readerType === 'unknown') return;
    let active = true;
    fetch(`/api/reader/preferences?readerType=${readerType}`)
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { settings: Record<string, unknown> } }>)
      .then((payload) => {
        if (!active) return;
        const savedSettings = payload.data?.settings ?? {};
        setSettings((current) => ({
          ...current,
          fontSize: typeof savedSettings.fontSize === 'number' ? savedSettings.fontSize : current.fontSize,
          lineHeight: typeof savedSettings.lineHeight === 'number' ? savedSettings.lineHeight : current.lineHeight,
          pageWidth: typeof savedSettings.pageWidth === 'number' ? savedSettings.pageWidth : current.pageWidth,
          zoom: typeof savedSettings.zoom === 'number' ? savedSettings.zoom : current.zoom,
          dark: savedSettings.theme === 'light' ? false : savedSettings.theme === 'dark' ? true : current.dark,
          comicDirection: savedSettings.readingDirection === 'rtl' || savedSettings.readingDirection === 'ltr' ? savedSettings.readingDirection : current.comicDirection,
          comicMode: savedSettings.mode === 'single' || savedSettings.mode === 'scroll' ? savedSettings.mode : current.comicMode,
          imageFit: savedSettings.imageFit === 'width' || savedSettings.imageFit === 'height' || savedSettings.imageFit === 'contain' ? savedSettings.imageFit : current.imageFit
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [readerType]);

  useEffect(() => {
    if (!book || readerType === 'unknown') return;
    const timer = window.setTimeout(() => {
      fetch(`/api/books/${book.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readerType,
          position: progress.position,
          page: progress.page,
          percent: progress.percent,
          extra: { zoom: settings.zoom, fontSize: settings.fontSize, lineHeight: settings.lineHeight }
        })
      }).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [book, progress.page, progress.percent, progress.position, readerType, settings.fontSize, settings.lineHeight, settings.zoom]);

  useEffect(() => {
    if (readerType === 'unknown') return;
    const timer = window.setTimeout(() => {
      const payload = readerType === 'comic'
        ? {
            readingDirection: settings.comicDirection,
            mode: settings.comicMode,
            imageFit: settings.imageFit,
            zoom: settings.zoom,
            theme: settings.dark ? 'dark' : 'light'
          }
        : {
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
            pageWidth: settings.pageWidth,
            theme: settings.dark ? 'dark' : 'light'
          };
      fetch('/api/reader/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readerType, settings: payload })
      }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [readerType, settings]);

  const handleProgress = useCallback((nextProgress: ReaderProgress) => {
    setProgress(nextProgress);
  }, []);

  const handleReaderError = useCallback((message: string) => {
    setError(message);
  }, []);

  function updateSettings(nextSettings: ReaderSettings) {
    setSettings(nextSettings);
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
      onBack={() => router.push(`/books/${book.id}`)}
      onSettingsChange={updateSettings}
    >
      {(readerEvents) => readerType === 'epub' ? (
        <EbookReader
          bookId={book.id}
          title={book.title}
          dark={settings.dark}
          fontSize={settings.fontSize}
          lineHeight={settings.lineHeight}
          pageWidth={settings.pageWidth}
          initialCfi={progress.position}
          onControls={setControls}
          onProgress={handleProgress}
          onActivity={readerEvents.enterImmersive}
          onTap={readerEvents.toggleControls}
        />
      ) : (
        <ComicReader
          book={book}
          dark={settings.dark}
          initialPage={progress.page}
          initialPosition={progress.position}
          mode={settings.comicMode as ComicMode}
          direction={settings.comicDirection as ComicDirection}
          imageFit={settings.imageFit as ComicImageFit}
          zoom={settings.zoom}
          onControls={setControls}
          onProgress={handleProgress}
          onActivity={readerEvents.enterImmersive}
          onError={handleReaderError}
        />
      )}
    </ReaderShell>
  );
}
