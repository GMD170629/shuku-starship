'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type TouchEvent } from 'react';
import { cn } from '../../components/ui/cn';
import type { WorkView } from '../../types/work';
import type { ReaderControls, ReaderProgress } from './reader-shell';

export type ComicMode = 'single' | 'double' | 'continuous';
export type ComicDirection = 'ltr' | 'rtl';
export type ComicImageFit = 'width' | 'height' | 'contain' | 'original';

type ComicReaderProps = {
  book: WorkView;
  volumeId?: string | null;
  volumeTitle?: string | null;
  initialPages?: ComicPageMeta[];
  initialPageCount?: number | null;
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
  onNextVolume?: () => void;
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

export type ComicPageMeta = {
  pageIndex: number;
  title?: string;
  mimeType?: string;
  width?: number | null;
  height?: number | null;
  size?: number | null;
};

function archivePageUrl(bookId: string, pageIndex: number, volumeId?: string | null, retryToken = 0) {
  const params = new URLSearchParams();
  if (retryToken > 0) params.set('retry', String(retryToken));
  const query = params.toString();
  const resolvedVolumeId = volumeId ?? bookId;
  return `/api/volumes/${resolvedVolumeId}/pages/${pageIndex}${query ? `?${query}` : ''}`;
}

function isArchiveComicFile(file: WorkView['files'][number] | undefined) {
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

function pageMetaByIndex(pages: ComicPageMeta[] | undefined) {
  return Object.fromEntries((pages ?? []).map((item) => [item.pageIndex, item]));
}

function spreadLabel(pages: number[], total: number) {
  const sortedPages = [...pages].sort((left, right) => left - right);
  if (sortedPages.length <= 1) return `第 ${sortedPages[0] ?? 1} / ${total} 页`;
  return `第 ${sortedPages[0]}-${sortedPages[sortedPages.length - 1]} / ${total} 页`;
}

export function ComicReader({
  book,
  volumeId: requestedVolumeId,
  volumeTitle,
  initialPages,
  initialPageCount,
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
  onNextVolume,
  onError
}: ComicReaderProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const suppressClickUntilRef = useRef(0);
  const restoredScrollKeyRef = useRef('');
  const visiblePageRef = useRef(Math.max(1, initialPage || 1));
  const scrollProgressFrameRef = useRef<number | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageMeta, setPageMeta] = useState<Record<number, ComicPageMeta>>({});
  const [page, setPage] = useState(Math.max(1, initialPage || 1));
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const [retryTokens, setRetryTokens] = useState<Record<number, number>>({});
  const archiveComic = book.files.some(isArchiveComicFile);
  const progressPrefix = volumeTitle ? `${volumeTitle} · ` : '';
  const volumeId = requestedVolumeId ?? book.volumes[0]?.id ?? null;
  const pageIndexKey = `${book.editionId ?? book.id}:${volumeId ?? 'none'}`;

  const orderedPages = useMemo(() => {
    const pages = Array.from({ length: pageCount ?? 0 }, (_, index) => index + 1);
    return reversePages ? pages.reverse() : pages;
  }, [pageCount, reversePages]);

  const spreadPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    const count = mode === 'double' ? 2 : 1;
    return orderedPages.slice(currentIndex, currentIndex + count);
  }, [mode, orderedPages, page]);

  const visualSpreadPages = useMemo(() => {
    return direction === 'rtl' ? [...spreadPages].reverse() : spreadPages;
  }, [direction, spreadPages]);

  const pagedPreloadPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    const lookAhead = mode === 'double' ? 4 : 2;
    return orderedPages.slice(Math.max(0, currentIndex - 2), currentIndex + lookAhead);
  }, [mode, orderedPages, page]);

  const continuousWarmPages = useMemo(() => {
    const currentIndex = orderedPages.indexOf(page);
    if (currentIndex < 0) return [page];
    return orderedPages.slice(Math.max(0, currentIndex - 2), currentIndex + 3);
  }, [orderedPages, page]);

  useEffect(() => {
    let active = true;
    const seedPage = Math.max(1, initialPage || 1);
    setPageCount(null);
    setPageMeta({});
    setLoadedPages(new Set());
    setFailedPages(new Set());
    setRetryTokens({});
    restoredScrollKeyRef.current = '';
    visiblePageRef.current = seedPage;
    if (!volumeId) {
      onError('漫画卷不存在');
      return;
    }

    const applyPageIndex = (data: { pageCount: number; pages?: ComicPageMeta[] }) => {
      if (!active) return;
      const total = Math.max(1, data.pageCount || data.pages?.length || 1);
      setPageCount(total);
      setPageMeta(pageMetaByIndex(data.pages));
      setPage(clamp(seedPage, 1, total));
    };

    if (initialPageCount || initialPages?.length) {
      applyPageIndex({ pageCount: initialPageCount ?? initialPages?.length ?? 1, pages: initialPages });
      return () => {
        active = false;
      };
    }

    fetch(`/api/volumes/${volumeId}/pages`)
      .then((response) => {
        if (!response.ok) throw new Error('漫画页面索引加载失败');
        return response.json() as Promise<ComicPageIndexPayload>;
      })
      .then((payload) => {
        if (!active) return;
        const data = payload.data;
        if (!payload.ok || !data) throw new Error(payload.error?.message ?? '漫画页面索引加载失败');
        applyPageIndex(data);
      })
      .catch((reason) => {
        if (active) onError(reason instanceof Error ? reason.message : '漫画页面索引加载失败');
      });
    return () => {
      active = false;
    };
  }, [book.editionId, book.id, initialPageCount, initialPages, onError, pageIndexKey, volumeId]);

  useEffect(() => {
    setLoadedPages((current) => {
      if (mode !== 'continuous') return new Set(pagedPreloadPages);
      if (continuousWarmPages.every((pageNumber) => current.has(pageNumber))) return current;
      const next = new Set(current);
      continuousWarmPages.forEach((pageNumber) => next.add(pageNumber));
      return next;
    });
  }, [continuousWarmPages, mode, pagedPreloadPages]);

  useEffect(() => {
    if (mode !== 'continuous' || pageCount === null) return;
    if (restoredScrollKeyRef.current === pageIndexKey) return;
    restoredScrollKeyRef.current = pageIndexKey;
    const timer = window.setTimeout(() => {
      const top = Number(initialPosition);
      if (Number.isFinite(top)) scrollerRef.current?.scrollTo({ top });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [initialPosition, mode, pageCount, pageIndexKey]);

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
          if (current.has(pageIndex)) return current;
          const next = new Set(current);
          next.add(pageIndex);
          return next;
        });
        setPage((current) => (current === pageIndex ? current : pageIndex));
        if (visiblePageRef.current === pageIndex) return;
        visiblePageRef.current = pageIndex;
        const percent = scrollPercent(root);
        onProgress({
          page: pageIndex,
          total: Math.max(1, pageCount ?? 1),
          percent,
          position: String(Math.round(root.scrollTop)),
          label: `${progressPrefix}第 ${pageIndex} / ${Math.max(1, pageCount ?? 1)} 页`
        }, { pageIndex, totalPages: pageCount ?? 1, percentage: percent, mode, direction, fitMode: imageFit, reversePages, volumeId, volumeTitle });
      },
      { root, threshold: [0.35, 0.6, 0.85], rootMargin: '800px 0px' }
    );
    pageRefs.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [direction, imageFit, mode, onProgress, pageCount, progressPrefix, reversePages, volumeId, volumeTitle]);

  useEffect(() => {
    return () => {
      if (scrollProgressFrameRef.current !== null) window.cancelAnimationFrame(scrollProgressFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (mode === 'continuous') return;
    const total = Math.max(1, pageCount ?? 1);
    const percent = pagePercentByOrder(page, orderedPages);
    onProgress({
      page,
      total,
      percent,
      position: String(page),
      label: `${progressPrefix}${spreadLabel(spreadPages, total)}`
    }, { pageIndex: page, visiblePages: spreadPages, totalPages: total, percentage: percent, mode, direction, fitMode: imageFit, reversePages, volumeId, volumeTitle });
  }, [direction, imageFit, mode, onProgress, orderedPages, page, pageCount, progressPrefix, reversePages, volumeId, volumeTitle, spreadPages]);

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
    const pageStep = mode === 'double' ? 2 : 1;
    const directionStep = direction === 'rtl'
      ? (intent === 'next' ? -1 : 1)
      : (intent === 'next' ? 1 : -1);
    const currentIndex = Math.max(0, orderedPages.indexOf(page));
    const targetIndex = currentIndex + directionStep * pageStep;
    onActivity();
    if (intent === 'next' && (targetIndex < 0 || targetIndex >= orderedPages.length)) {
      onNextVolume?.();
      return;
    }
    moveOrdered(directionStep * pageStep);
  }

  function handleContentTap(clientX: number, width: number) {
    if (clientX > width * 0.38 && clientX < width * 0.62) {
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
  }, [direction, mode, onActivity, onControls, onNextVolume, orderedPages, page]);

  function reportScrollProgress() {
    const element = scrollerRef.current;
    if (!element) return;
    const percent = scrollPercent(element);
    onProgress({
      page,
      total: Math.max(1, pageCount ?? 1),
      percent,
      position: String(Math.round(element.scrollTop)),
      label: `${progressPrefix}第 ${page} / ${Math.max(1, pageCount ?? 1)} 页`
    }, { pageIndex: page, totalPages: pageCount ?? 1, percentage: percent, mode, direction, fitMode: imageFit, reversePages, volumeId, volumeTitle });
    onActivity();
  }

  function scheduleScrollProgress() {
    if (scrollProgressFrameRef.current !== null) return;
    scrollProgressFrameRef.current = window.requestAnimationFrame(() => {
      scrollProgressFrameRef.current = null;
      reportScrollProgress();
    });
  }

  function handlePagedClick(event: MouseEvent<HTMLDivElement>) {
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
    imageFit === 'height' ? 'h-[calc(100dvh-1rem)] w-auto max-w-full md:h-[calc(100dvh-2rem)]' : '',
    imageFit === 'contain' ? 'max-h-[calc(100dvh-1rem)] max-w-full object-contain md:max-h-[calc(100dvh-2rem)]' : '',
    imageFit === 'width' && mode === 'continuous' ? 'w-full max-w-[52rem]' : '',
    imageFit === 'width' && mode === 'single' ? 'w-full max-w-[56rem]' : '',
    imageFit === 'width' && mode === 'double' ? 'w-full max-w-full' : '',
    imageFit === 'original' ? 'h-auto w-auto max-h-[calc(100dvh-1rem)] max-w-full md:max-h-[calc(100dvh-2rem)]' : ''
  );
  const continuousPageFrameClass = imageFit === 'width'
    ? 'max-w-[52rem]'
    : imageFit === 'contain'
      ? 'max-w-full'
      : imageFit === 'height' || imageFit === 'original'
        ? 'max-w-[56rem]'
        : 'max-w-6xl';
  const pagedFrameClass = mode === 'double' ? 'max-w-[82rem]' : 'max-w-[56rem]';
  const pagedImageSlotClass = mode === 'double' ? 'min-w-0 flex-1 basis-1/2' : 'w-full';

  function renderPageImage(pageNumber: number, hidden = false) {
    if (failedPages.has(pageNumber) && !hidden) {
      return (
        <ComicImageFallback
          dark={dark}
          pageNumber={pageNumber}
          className={mode === 'continuous' ? continuousPageFrameClass : mode === 'double' ? 'max-w-full' : 'max-w-[56rem]'}
          style={pagePlaceholderStyle(pageNumber)}
          onRetry={() => retryImage(pageNumber)}
        />
      );
    }

    return (
      <img
        src={archivePageUrl(book.id, pageNumber, volumeId, retryTokens[pageNumber] ?? 0)}
        alt={hidden ? '' : `${book.title} 第 ${pageNumber} 页`}
        aria-hidden={hidden ? 'true' : undefined}
        className={hidden ? '' : cn(imageClass, 'shadow-2xl')}
        loading={hidden ? 'eager' : 'lazy'}
        style={hidden ? undefined : { transform: `scale(${zoom})`, transformOrigin: mode === 'continuous' ? 'top center' : 'center center' }}
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
      data-pwa-scroll="true"
      className="h-full w-full overflow-auto overscroll-contain px-2 py-2 landscape:px-1 landscape:py-1 md:px-8 md:py-8"
      onScroll={mode === 'continuous' ? scheduleScrollProgress : undefined}
      dir={direction}
    >
      {mode !== 'continuous' ? (
        <div
          className={cn('mx-auto flex min-h-full w-full justify-center gap-2 md:gap-4', pagedFrameClass)}
          style={{ alignItems: 'safe center' }}
          onClick={handlePagedClick}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {visualSpreadPages.map((pageNumber) => (
            <div key={pageNumber} className={pagedImageSlotClass}>
              {renderPageImage(pageNumber)}
            </div>
          ))}
          <div className="hidden">
            {pagedPreloadPages.filter((pageNumber) => !spreadPages.includes(pageNumber)).map((pageNumber) => (
              <span key={pageNumber}>{renderPageImage(pageNumber, true)}</span>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="flex w-full flex-col items-center gap-4"
          onClick={(event) => {
            event.stopPropagation();
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
              {loadedPages.has(pageNumber) ? (
                renderPageImage(pageNumber)
              ) : (
                <div
                  className={cn(
                    'flex min-h-80 w-full items-center justify-center rounded-xl text-sm opacity-60',
                    continuousPageFrameClass,
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

function ComicImageFallback({ dark, pageNumber, className, style, onRetry }: { dark: boolean; pageNumber: number; className?: string; style?: CSSProperties; onRetry: () => void }) {
  return (
    <div
      className={cn(
        'flex min-h-80 w-full flex-col items-center justify-center gap-3 rounded-xl border px-4 text-center text-sm',
        className,
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
