'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import type { BookView } from '../../lib/books';
import type { ReaderControls, ReaderProgress } from './reader-shell';

export type ComicMode = 'single' | 'scroll';
export type ComicDirection = 'ltr' | 'rtl';
export type ComicImageFit = 'width' | 'height' | 'contain';

type ComicReaderProps = {
  book: BookView;
  dark: boolean;
  initialPage: number;
  initialPosition: string;
  mode: ComicMode;
  direction: ComicDirection;
  imageFit: ComicImageFit;
  zoom: number;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress) => void;
  onActivity: () => void;
  onError: (message: string) => void;
};

type ComicPageIndexPayload = {
  ok: boolean;
  data?: {
    pageCount: number;
    pages?: Array<{ pageIndex: number; title?: string; mimeType?: string; width?: number | null; height?: number | null; size?: number | null }>;
  };
  error?: { message: string };
};

function archivePageUrl(bookId: string, pageIndex: number) {
  return `/api/books/${bookId}/pages/${pageIndex}`;
}

function isArchiveComicFile(file: BookView['files'][number] | undefined) {
  if (!file) return false;
  const lowerPath = file.path.toLowerCase();
  return lowerPath.endsWith('.cbz') || lowerPath.endsWith('.zip') || file.mimeType === 'application/vnd.comicbook+zip' || file.mimeType === 'application/zip';
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function pagePercent(page: number, total: number) {
  if (total <= 1) return 0;
  return Math.round(((page - 1) / (total - 1)) * 100);
}

export function ComicReader({ book, dark, initialPage, initialPosition, mode, direction, imageFit, zoom, onControls, onProgress, onActivity, onError }: ComicReaderProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [page, setPage] = useState(Math.max(1, initialPage || 1));
  const archiveComic = book.files.length === 1 && isArchiveComicFile(book.files[0]);

  const pageNumbers = useMemo(() => Array.from({ length: pageCount ?? 0 }, (_, index) => index + 1), [pageCount]);

  useEffect(() => {
    let active = true;
    setPageCount(null);
    fetch(`/api/books/${book.id}/pages`)
      .then((response) => {
        if (!response.ok) throw new Error('漫画页面索引加载失败');
        return response.json() as Promise<ComicPageIndexPayload>;
      })
      .then((payload) => {
        if (!active) return;
        const data = payload.data;
        if (!payload.ok || !data) throw new Error(payload.error?.message ?? '漫画页面索引加载失败');
        setPageCount(data.pageCount);
        setPage((current) => clamp(current || initialPage || 1, 1, Math.max(1, data.pageCount)));
      })
      .catch((reason) => {
        if (active) onError(reason instanceof Error ? reason.message : '漫画页面索引加载失败');
      });
    return () => {
      active = false;
    };
  }, [book.id, initialPage, onError]);

  useEffect(() => {
    if (mode !== 'scroll' || pageCount === null) return;
    const timer = window.setTimeout(() => {
      const top = Number(initialPosition);
      if (Number.isFinite(top)) scrollerRef.current?.scrollTo({ top });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [initialPosition, mode, pageCount]);

  useEffect(() => {
    const total = Math.max(1, pageCount ?? 1);
    if (mode === 'single') {
      onProgress({
        page,
        total,
        percent: pagePercent(page, total),
        position: String(page),
        label: `第 ${page} / ${total} 页`
      });
    }
  }, [mode, onProgress, page, pageCount]);

  useEffect(() => {
    const total = Math.max(1, pageCount ?? 1);
    onControls({
      next: async () => {
        onActivity();
        setPage((current) => clamp(current + 1, 1, total));
      },
      prev: async () => {
        onActivity();
        setPage((current) => clamp(current - 1, 1, total));
      },
      jumpToProgress: async (value) => {
        onActivity();
        if (mode === 'scroll') {
          const element = scrollerRef.current;
          if (!element) return;
          const max = Math.max(0, element.scrollHeight - element.clientHeight);
          element.scrollTo({ top: Math.round(max * (clamp(value, 0, 100) / 100)), behavior: 'smooth' });
          return;
        }
        const nextPage = clamp(Math.round((clamp(value, 0, 100) / 100) * Math.max(0, total - 1)) + 1, 1, total);
        setPage(nextPage);
      }
    });
    return () => onControls(null);
  }, [mode, onActivity, onControls, pageCount]);

  function reportScrollProgress() {
    const element = scrollerRef.current;
    const total = Math.max(1, pageCount ?? 1);
    if (!element) return;
    const max = Math.max(1, element.scrollHeight - element.clientHeight);
    const percent = clamp(Math.round((element.scrollTop / max) * 100), 0, 100);
    const estimatedPage = clamp(Math.round((percent / 100) * Math.max(0, total - 1)) + 1, 1, total);
    setPage(estimatedPage);
    onProgress({
      page: estimatedPage,
      total,
      percent,
      position: String(Math.round(element.scrollTop)),
      label: `第 ${estimatedPage} / ${total} 页`
    });
    onActivity();
  }

  const imageClass = cn(
    'block shadow-2xl',
    dark ? 'shadow-black/40' : 'shadow-slate-300/80',
    imageFit === 'height' ? 'h-[calc(100dvh-2rem)] w-auto max-w-none' : '',
    imageFit === 'contain' ? 'max-h-[calc(100dvh-2rem)] max-w-full object-contain' : '',
    imageFit === 'width' ? 'w-full max-w-5xl' : ''
  );

  if (!archiveComic) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm opacity-70">
        该漫画没有可读取的 CBZ/ZIP 页面。
      </div>
    );
  }

  if (pageCount === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm opacity-70">
        正在建立漫画页面索引...
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="h-full w-full overflow-auto overscroll-contain px-3 py-4 md:px-8 md:py-8"
      onScroll={mode === 'scroll' ? reportScrollProgress : undefined}
      dir={direction}
    >
      {mode === 'single' ? (
        <div className="flex min-h-full items-start justify-center">
          <img
            src={archivePageUrl(book.id, page)}
            alt={`${book.title} 第 ${page} 页`}
            className={imageClass}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          />
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-4">
          {pageNumbers.map((pageNumber) => (
            <img
              key={pageNumber}
              src={archivePageUrl(book.id, pageNumber)}
              alt={`${book.title} 第 ${pageNumber} 页`}
              className={imageClass}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
