'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { cn } from '../../components/ui/cn';
import type { BookView } from '../../lib/books';
import type { ReaderControls, ReaderProgress } from './reader-shell';

export type ComicMode = 'single' | 'continuous';
export type ComicDirection = 'ltr' | 'rtl';
export type ComicImageFit = 'width' | 'height' | 'contain' | 'original';

type ComicReaderProps = {
  book: BookView;
  dark: boolean;
  initialPage: number;
  initialPosition: string;
  mode: ComicMode;
  direction: ComicDirection;
  imageFit: ComicImageFit;
  zoom: number;
  reversePages: boolean;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress, extra?: Record<string, unknown>) => void;
  onActivity: () => void;
  onTap: () => void;
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

function pagePercentByOrder(pageIndex: number, orderedPages: number[]) {
  if (orderedPages.length <= 1) return 0;
  const orderedIndex = Math.max(0, orderedPages.indexOf(pageIndex));
  return Math.round((orderedIndex / (orderedPages.length - 1)) * 100);
}

function scrollPercent(element: HTMLElement) {
  const max = Math.max(1, element.scrollHeight - element.clientHeight);
  return clamp(Math.round((element.scrollTop / max) * 100), 0, 100);
}

export function ComicReader({
  book,
  dark,
  initialPage,
  initialPosition,
  mode,
  direction,
  imageFit,
  zoom,
  reversePages,
  onControls,
  onProgress,
  onActivity,
  onTap,
  onError
}: ComicReaderProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [page, setPage] = useState(Math.max(1, initialPage || 1));
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set());
  const archiveComic = book.files.length === 1 && isArchiveComicFile(book.files[0]);

  const orderedPages = useMemo(() => {
    const pages = Array.from({ length: pageCount ?? 0 }, (_, index) => index + 1);
    return reversePages ? pages.reverse() : pages;
  }, [pageCount, reversePages]);

  const preloadPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    return orderedPages.slice(Math.max(0, currentIndex - 3), currentIndex + 4);
  }, [orderedPages, page]);

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
    setLoadedPages((current) => {
      if (mode === 'single') return new Set(preloadPages);
      const next = new Set(current);
      preloadPages.forEach((pageNumber) => next.add(pageNumber));
      return next;
    });
  }, [mode, preloadPages]);

  useEffect(() => {
    if (mode !== 'continuous' || pageCount === null) return;
    const timer = window.setTimeout(() => {
      const top = Number(initialPosition);
      if (Number.isFinite(top)) scrollerRef.current?.scrollTo({ top });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [initialPosition, mode, pageCount]);

  useEffect(() => {
    if (mode !== 'continuous' || !scrollerRef.current) return;
    const root = scrollerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (!visible) return;
        const pageIndex = Number((visible.target as HTMLElement).dataset.pageIndex);
        if (!Number.isFinite(pageIndex)) return;
        setLoadedPages((current) => new Set(current).add(pageIndex));
        setPage(pageIndex);
        const percent = scrollPercent(root);
        onProgress({
          page: pageIndex,
          total: Math.max(1, pageCount ?? 1),
          percent,
          position: String(Math.round(root.scrollTop)),
          label: `第 ${pageIndex} / ${Math.max(1, pageCount ?? 1)} 页`
        }, { pageIndex, totalPages: pageCount ?? 1, percentage: percent, mode, direction, fitMode: imageFit, reversePages });
      },
      { root, threshold: [0.35, 0.6, 0.85], rootMargin: '800px 0px' }
    );
    pageRefs.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [direction, imageFit, mode, onProgress, orderedPages, pageCount, reversePages]);

  useEffect(() => {
    if (mode !== 'single') return;
    onProgress({
      page,
      total: Math.max(1, pageCount ?? 1),
      percent: pagePercentByOrder(page, orderedPages),
      position: String(page),
      label: `第 ${page} / ${Math.max(1, pageCount ?? 1)} 页`
    }, { pageIndex: page, totalPages: pageCount ?? 1, percentage: pagePercentByOrder(page, orderedPages), mode, direction, fitMode: imageFit, reversePages });
  }, [direction, imageFit, mode, onProgress, orderedPages, page, pageCount, reversePages]);

  function moveOrdered(step: number) {
    const currentIndex = Math.max(0, orderedPages.indexOf(page));
    const next = orderedPages[clamp(currentIndex + step, 0, Math.max(0, orderedPages.length - 1))];
    if (next) setPage(next);
  }

  useEffect(() => {
    onControls({
      next: async () => {
        onActivity();
        const step = direction === 'rtl' ? -1 : 1;
        moveOrdered(step);
      },
      prev: async () => {
        onActivity();
        const step = direction === 'rtl' ? 1 : -1;
        moveOrdered(step);
      },
      jumpToProgress: async (value) => {
        onActivity();
        if (mode === 'continuous') {
          const element = scrollerRef.current;
          if (!element) return;
          const max = Math.max(0, element.scrollHeight - element.clientHeight);
          element.scrollTo({ top: Math.round(max * (clamp(value, 0, 100) / 100)), behavior: 'smooth' });
          return;
        }
        const orderedIndex = clamp(Math.round((clamp(value, 0, 100) / 100) * Math.max(0, orderedPages.length - 1)), 0, Math.max(0, orderedPages.length - 1));
        const next = orderedPages[orderedIndex];
        if (next) setPage(next);
      },
      jumpToIndex: async (index) => {
        onActivity();
        const next = orderedPages.includes(index) ? index : orderedPages[0];
        if (next) {
          setPage(next);
          if (mode === 'continuous') {
            pageRefs.current.get(next)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      }
    });
    return () => onControls(null);
  }, [direction, mode, onActivity, onControls, orderedPages, page]);

  function reportScrollProgress() {
    const element = scrollerRef.current;
    if (!element) return;
    onProgress({
      page,
      total: Math.max(1, pageCount ?? 1),
      percent: scrollPercent(element),
      position: String(Math.round(element.scrollTop)),
      label: `第 ${page} / ${Math.max(1, pageCount ?? 1)} 页`
    }, { pageIndex: page, totalPages: pageCount ?? 1, percentage: scrollPercent(element), mode, direction, fitMode: imageFit, reversePages });
    onActivity();
  }

  function handleSingleClick(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x > rect.width * 0.33 && x < rect.width * 0.67) {
      onTap();
      return;
    }
    const clickedLeadingSide = x <= rect.width * 0.33;
    const step = direction === 'rtl'
      ? (clickedLeadingSide ? 1 : -1)
      : (clickedLeadingSide ? -1 : 1);
    onActivity();
    moveOrdered(step);
  }

  const imageClass = cn(
    'block',
    dark ? 'shadow-black/40' : 'shadow-slate-300/80',
    imageFit === 'height' ? 'h-[calc(100dvh-2rem)] w-auto max-w-none' : '',
    imageFit === 'contain' ? 'max-h-[calc(100dvh-2rem)] max-w-full object-contain' : '',
    imageFit === 'width' ? 'w-full max-w-5xl' : '',
    imageFit === 'original' ? 'h-auto w-auto max-w-none' : ''
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
      onScroll={mode === 'continuous' ? reportScrollProgress : undefined}
      dir={direction}
    >
      {mode === 'single' ? (
        <div className="flex min-h-full items-start justify-center" onClick={handleSingleClick}>
          <img
            src={archivePageUrl(book.id, page)}
            alt={`${book.title} 第 ${page} 页`}
            className={cn(imageClass, 'shadow-2xl')}
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          />
          <div className="hidden">
            {preloadPages.filter((pageNumber) => pageNumber !== page).map((pageNumber) => (
              <img key={pageNumber} src={archivePageUrl(book.id, pageNumber)} alt="" aria-hidden="true" />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-4">
          {orderedPages.map((pageNumber) => (
            <div
              key={pageNumber}
              ref={(element) => {
                if (element) pageRefs.current.set(pageNumber, element);
                else pageRefs.current.delete(pageNumber);
              }}
              data-page-index={pageNumber}
              className="flex min-h-48 w-full justify-center"
            >
              {loadedPages.has(pageNumber) ? (
                <img
                  src={archivePageUrl(book.id, pageNumber)}
                  alt={`${book.title} 第 ${pageNumber} 页`}
                  className={cn(imageClass, 'shadow-2xl')}
                  loading="lazy"
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
                />
              ) : (
                <div className="flex h-80 w-full max-w-5xl items-center justify-center rounded-xl bg-white/5 text-sm opacity-60">
                  第 {pageNumber} 页
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
