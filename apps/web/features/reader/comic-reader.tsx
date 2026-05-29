'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type TouchEvent } from 'react';
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

type ComicPageMeta = {
  pageIndex: number;
  width?: number | null;
  height?: number | null;
};

function archivePageUrl(bookId: string, pageIndex: number, retryToken = 0) {
  const retry = retryToken > 0 ? `?retry=${retryToken}` : '';
  return `/api/books/${bookId}/pages/${pageIndex}${retry}`;
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

function compactSet(values: number[]) {
  return new Set(values.filter((value) => Number.isFinite(value)));
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
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const suppressClickUntilRef = useRef(0);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageMeta, setPageMeta] = useState<Record<number, ComicPageMeta>>({});
  const [page, setPage] = useState(Math.max(1, initialPage || 1));
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const [retryTokens, setRetryTokens] = useState<Record<number, number>>({});
  const archiveComic = book.files.length === 1 && isArchiveComicFile(book.files[0]);

  const orderedPages = useMemo(() => {
    const pages = Array.from({ length: pageCount ?? 0 }, (_, index) => index + 1);
    return reversePages ? pages.reverse() : pages;
  }, [pageCount, reversePages]);

  const singlePreloadPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    return orderedPages.slice(Math.max(0, currentIndex - 1), currentIndex + 2);
  }, [orderedPages, page]);

  const continuousWarmPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    return orderedPages.slice(Math.max(0, currentIndex - 2), currentIndex + 3);
  }, [orderedPages, page]);

  const continuousRenderPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return compactSet([page]);
    return compactSet(orderedPages.slice(Math.max(0, currentIndex - 5), currentIndex + 6));
  }, [orderedPages, page]);

  useEffect(() => {
    let active = true;
    setPageCount(null);
    setPageMeta({});
    setLoadedPages(new Set());
    setFailedPages(new Set());
    setRetryTokens({});
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
        setPageMeta(Object.fromEntries((data.pages ?? []).map((item) => [item.pageIndex, item])));
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
      if (mode === 'single') return new Set(singlePreloadPages);
      const next = new Set(current);
      continuousWarmPages.forEach((pageNumber) => next.add(pageNumber));
      return next;
    });
  }, [continuousWarmPages, mode, singlePreloadPages]);

  useEffect(() => {
    if (mode !== 'continuous') return;
    setLoadedPages((current) => {
      const next = new Set<number>();
      current.forEach((pageNumber) => {
        if (continuousRenderPages.has(pageNumber)) next.add(pageNumber);
      });
      continuousWarmPages.forEach((pageNumber) => next.add(pageNumber));
      return next;
    });
  }, [continuousRenderPages, continuousWarmPages, mode]);

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
        setLoadedPages((current) => {
          const next = new Set<number>();
          current.forEach((pageNumber) => {
            if (continuousRenderPages.has(pageNumber) || pageNumber === pageIndex) next.add(pageNumber);
          });
          next.add(pageIndex);
          return next;
        });
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
  }, [continuousRenderPages, direction, imageFit, mode, onProgress, pageCount, reversePages]);

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
    if (!next) return;
    setPage(next);
    if (mode === 'continuous') {
      pageRefs.current.get(next)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function moveByReaderIntent(intent: 'next' | 'prev') {
    const step = direction === 'rtl'
      ? (intent === 'next' ? -1 : 1)
      : (intent === 'next' ? 1 : -1);
    onActivity();
    moveOrdered(step);
  }

  function handleContentTap(clientX: number, width: number) {
    if (clientX > width * 0.33 && clientX < width * 0.67) {
      onTap();
      return;
    }
    const clickedLeadingSide = clientX <= width * 0.33;
    const intent = direction === 'rtl'
      ? (clickedLeadingSide ? 'next' : 'prev')
      : (clickedLeadingSide ? 'prev' : 'next');
    moveByReaderIntent(intent);
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0];
    if (!touch) return;
    touchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - touchRef.current.x;
    const deltaY = touch.clientY - touchRef.current.y;
    const elapsed = Date.now() - touchRef.current.time;
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 900) {
      event.stopPropagation();
      suppressClickUntilRef.current = Date.now() + 450;
      moveByReaderIntent(deltaX < 0 ? 'next' : 'prev');
      return;
    }
    if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
      event.stopPropagation();
      suppressClickUntilRef.current = Date.now() + 450;
      const rect = event.currentTarget.getBoundingClientRect();
      handleContentTap(touch.clientX - rect.left, rect.width);
    }
  }

  useEffect(() => {
    onControls({
      next: async () => {
        moveByReaderIntent('next');
      },
      prev: async () => {
        moveByReaderIntent('prev');
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
    if (Date.now() < suppressClickUntilRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    handleContentTap(x, rect.width);
  }

  function markImageFailed(pageNumber: number) {
    setFailedPages((current) => new Set(current).add(pageNumber));
  }

  function markImageLoaded(pageNumber: number) {
    setFailedPages((current) => {
      if (!current.has(pageNumber)) return current;
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
  }

  function retryImage(pageNumber: number) {
    setFailedPages((current) => {
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
    setLoadedPages((current) => new Set(current).add(pageNumber));
    setRetryTokens((current) => ({ ...current, [pageNumber]: (current[pageNumber] ?? 0) + 1 }));
  }

  function pagePlaceholderStyle(pageNumber: number) {
    const meta = pageMeta[pageNumber];
    if (meta?.width && meta.height) return { aspectRatio: `${meta.width} / ${meta.height}` };
    return undefined;
  }

  const imageClass = cn(
    'block',
    dark ? 'shadow-black/40' : 'shadow-slate-300/80',
    imageFit === 'height' ? 'h-[calc(100dvh-1rem)] w-auto max-w-none md:h-[calc(100dvh-2rem)]' : '',
    imageFit === 'contain' ? 'max-h-[calc(100dvh-1rem)] max-w-full object-contain md:max-h-[calc(100dvh-2rem)]' : '',
    imageFit === 'width' ? 'w-full max-w-6xl landscape:max-w-none' : '',
    imageFit === 'original' ? 'h-auto w-auto max-w-none' : ''
  );

  function renderPageImage(pageNumber: number, hidden = false) {
    if (failedPages.has(pageNumber) && !hidden) {
      return (
        <ComicImageFallback
          dark={dark}
          pageNumber={pageNumber}
          style={pagePlaceholderStyle(pageNumber)}
          onRetry={() => retryImage(pageNumber)}
        />
      );
    }

    return (
      <img
        src={archivePageUrl(book.id, pageNumber, retryTokens[pageNumber] ?? 0)}
        alt={hidden ? '' : `${book.title} 第 ${pageNumber} 页`}
        aria-hidden={hidden ? 'true' : undefined}
        className={hidden ? '' : cn(imageClass, 'shadow-2xl')}
        loading={hidden ? 'eager' : 'lazy'}
        style={hidden ? undefined : { transform: `scale(${zoom})`, transformOrigin: 'top center' }}
        onLoad={() => markImageLoaded(pageNumber)}
        onError={() => markImageFailed(pageNumber)}
      />
    );
  }

  if (!archiveComic) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm opacity-70">
        该漫画没有可读取的 CBZ/ZIP 页面。
      </div>
    );
  }

  if (pageCount === null) {
    return (
      <div className="flex h-full items-center justify-center p-4 md:p-8">
        <div className={cn('w-full max-w-3xl animate-pulse rounded-2xl p-4', dark ? 'bg-white/5' : 'bg-slate-200/70')}>
          <div className={cn('mx-auto h-[68dvh] rounded-xl', dark ? 'bg-white/10' : 'bg-white/80')} />
          <div className={cn('mt-4 h-4 w-40 rounded-full', dark ? 'bg-white/10' : 'bg-slate-300')} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="h-full w-full overflow-auto overscroll-contain px-2 py-2 landscape:px-1 landscape:py-1 md:px-8 md:py-8"
      onScroll={mode === 'continuous' ? reportScrollProgress : undefined}
      dir={direction}
    >
      {mode === 'single' ? (
        <div className="flex min-h-full items-start justify-center" onClick={handleSingleClick} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          {renderPageImage(page)}
          <div className="hidden">
            {singlePreloadPages.filter((pageNumber) => pageNumber !== page).map((pageNumber) => (
              <span key={pageNumber}>{renderPageImage(pageNumber, true)}</span>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="flex w-full flex-col items-center gap-4"
          onClick={(event) => {
            if (Date.now() < suppressClickUntilRef.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            handleContentTap(event.clientX - rect.left, rect.width);
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
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
              {loadedPages.has(pageNumber) && continuousRenderPages.has(pageNumber) ? (
                renderPageImage(pageNumber)
              ) : (
                <div
                  className={cn(
                    'flex min-h-80 w-full max-w-6xl items-center justify-center rounded-xl text-sm opacity-60 landscape:max-w-none',
                    dark ? 'bg-white/5' : 'bg-slate-200/70'
                  )}
                  style={pagePlaceholderStyle(pageNumber)}
                >
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

function ComicImageFallback({ dark, pageNumber, style, onRetry }: { dark: boolean; pageNumber: number; style?: CSSProperties; onRetry: () => void }) {
  return (
    <div
      className={cn(
        'flex min-h-80 w-full max-w-6xl flex-col items-center justify-center gap-3 rounded-xl border px-4 text-center text-sm landscape:max-w-none',
        dark ? 'border-white/10 bg-white/5 text-slate-200' : 'border-slate-200 bg-white/80 text-slate-700'
      )}
      style={style}
    >
      <div>第 {pageNumber} 页加载失败</div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRetry();
        }}
        className={cn(
          'min-h-11 rounded-xl px-4 text-sm font-medium transition active:scale-[0.98]',
          dark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-slate-900 text-white hover:bg-slate-700'
        )}
      >
        重试
      </button>
    </div>
  );
}
