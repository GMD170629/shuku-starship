'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type TouchEvent } from 'react';
import { cn } from '../../components/ui/cn';
import { comicPreloadAfterVisibleDelayMs, comicPreloadPages, comicRetainedPages } from '../../lib/comic-preload';
import type { WorkView } from '../../types/work';
import type { ReaderControls, ReaderProgress } from './reader-shell';

export type ComicMode = 'single' | 'double';
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
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const suppressClickUntilRef = useRef(0);
  const preloadControllersRef = useRef(new Map<number, AbortController>());
  const cachedImageUrlsRef = useRef(new Map<number, string>());
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageMeta, setPageMeta] = useState<Record<number, ComicPageMeta>>({});
  const [page, setPage] = useState(Math.max(1, initialPage || 1));
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set());
  const [cachedImageUrls, setCachedImageUrls] = useState<Record<number, string>>({});
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
    const visibleCount = mode === 'double' ? 2 : 1;
    return comicPreloadPages(orderedPages, page, visibleCount);
  }, [mode, orderedPages, page]);

  const retainedPages = useMemo(() => {
    const visibleCount = mode === 'double' ? 2 : 1;
    return comicRetainedPages(orderedPages, page, visibleCount);
  }, [mode, orderedPages, page]);

  const visiblePagesLoaded = useMemo(() => {
    return spreadPages.every((pageNumber) => loadedPages.has(pageNumber));
  }, [loadedPages, spreadPages]);

  useEffect(() => {
    let active = true;
    const seedPage = Math.max(1, initialPage || 1);
    setPageCount(null);
    setPageMeta({});
    setFailedPages(new Set());
    setLoadedPages(new Set());
    setCachedImageUrls({});
    setRetryTokens({});
    preloadControllersRef.current.forEach((controller) => controller.abort());
    preloadControllersRef.current.clear();
    cachedImageUrlsRef.current.forEach((imageUrl) => window.URL.revokeObjectURL(imageUrl));
    cachedImageUrlsRef.current.clear();
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
  }, [book.editionId, book.id, initialPage, initialPageCount, initialPages, onError, pageIndexKey, volumeId]);

  useEffect(() => {
    const visiblePages = new Set(spreadPages);
    const preloadPages = new Set(pagedPreloadPages.filter((pageNumber) => !visiblePages.has(pageNumber) && !failedPages.has(pageNumber)));
    const retainedPageSet = new Set(retainedPages);
    preloadControllersRef.current.forEach((controller, pageNumber) => {
      if (!retainedPageSet.has(pageNumber)) {
        controller.abort();
        preloadControllersRef.current.delete(pageNumber);
      }
    });
    cachedImageUrlsRef.current.forEach((_imageUrl, pageNumber) => {
      if (!retainedPageSet.has(pageNumber)) releaseCachedImage(pageNumber);
    });
    if (!visiblePagesLoaded) return undefined;
    const timeoutId = window.setTimeout(() => {
      preloadPages.forEach((pageNumber) => {
        if (cachedImageUrlsRef.current.has(pageNumber) || preloadControllersRef.current.has(pageNumber)) return;
        const controller = new AbortController();
        preloadControllersRef.current.set(pageNumber, controller);
        fetch(archivePageUrl(book.id, pageNumber, volumeId, retryTokens[pageNumber] ?? 0), { signal: controller.signal })
          .then((response) => {
            if (!response.ok) throw new Error(`comic preload failed: ${response.status}`);
            return response.blob();
          })
          .then((blob) => {
            if (controller.signal.aborted) return;
            const imageUrl = window.URL.createObjectURL(blob);
            cachePageImageUrl(pageNumber, imageUrl);
            markImageLoaded(pageNumber);
          })
          .catch(() => {
            // Visible pages still load through their own <img>; preload failures should stay quiet.
          })
          .finally(() => {
            if (preloadControllersRef.current.get(pageNumber) === controller) {
              preloadControllersRef.current.delete(pageNumber);
            }
          });
      });
    }, comicPreloadAfterVisibleDelayMs);
    return () => window.clearTimeout(timeoutId);
  }, [book.id, failedPages, pagedPreloadPages, retainedPages, retryTokens, spreadPages, visiblePagesLoaded, volumeId]);

  useEffect(() => {
    return () => {
      preloadControllersRef.current.forEach((controller) => controller.abort());
      preloadControllersRef.current.clear();
      cachedImageUrlsRef.current.forEach((imageUrl) => window.URL.revokeObjectURL(imageUrl));
      cachedImageUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
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
  }

  function moveByReaderIntent(intent: 'next' | 'prev') {
    const pageStep = mode === 'double' ? 2 : 1;
    const directionStep = intent === 'next' ? 1 : -1;
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

  function intentFromSwipe(deltaX: number) {
    if (direction === 'rtl') return deltaX > 0 ? 'next' : 'prev';
    return deltaX < 0 ? 'next' : 'prev';
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
      moveByReaderIntent(intentFromSwipe(deltaX));
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
        const orderedIndex = clamp(Math.round((clamp(value, 0, 100) / 100) * Math.max(0, orderedPages.length - 1)), 0, Math.max(0, orderedPages.length - 1));
        const next = orderedPages[orderedIndex];
        if (next) setPage(next);
      },
      jumpToIndex: async (index) => {
        onActivity();
        const next = orderedPages.includes(index) ? index : orderedPages[0];
        if (next) setPage(next);
      }
    });
    return () => onControls(null);
  }, [mode, onActivity, onControls, onNextVolume, orderedPages, page]);

  function handlePagedClick(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (Date.now() < suppressClickUntilRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    handleContentTap(x, rect.width);
  }

  function markImageFailed(pageNumber: number) {
    releaseCachedImage(pageNumber);
    setFailedPages((current) => new Set(current).add(pageNumber));
    setLoadedPages((current) => {
      if (!current.has(pageNumber)) return current;
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
  }

  function cachePageImageUrl(pageNumber: number, imageUrl: string) {
    const previousUrl = cachedImageUrlsRef.current.get(pageNumber);
    if (previousUrl && previousUrl !== imageUrl) window.URL.revokeObjectURL(previousUrl);
    cachedImageUrlsRef.current.set(pageNumber, imageUrl);
    setCachedImageUrls((current) => {
      if (current[pageNumber] === imageUrl) return current;
      return { ...current, [pageNumber]: imageUrl };
    });
  }

  function releaseCachedImage(pageNumber: number) {
    const imageUrl = cachedImageUrlsRef.current.get(pageNumber);
    if (!imageUrl) return;
    cachedImageUrlsRef.current.delete(pageNumber);
    window.URL.revokeObjectURL(imageUrl);
    setCachedImageUrls((current) => {
      if (!current[pageNumber]) return current;
      const next = { ...current };
      delete next[pageNumber];
      return next;
    });
  }

  function markImageLoaded(pageNumber: number) {
    setLoadedPages((current) => {
      if (current.has(pageNumber)) return current;
      return new Set(current).add(pageNumber);
    });
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
    setRetryTokens((current) => ({ ...current, [pageNumber]: (current[pageNumber] ?? 0) + 1 }));
  }

  function pagePlaceholderStyle(pageNumber: number) {
    const meta = pageMeta[pageNumber];
    if (meta?.width && meta.height) return { aspectRatio: `${meta.width} / ${meta.height}` };
    return undefined;
  }

  const imageClass = cn(
    'block max-h-full max-w-full object-contain',
    dark ? 'shadow-black/40' : 'shadow-slate-300/80',
    imageFit === 'height' ? 'h-full w-auto' : '',
    imageFit === 'contain' ? 'h-full w-auto' : '',
    imageFit === 'width' ? 'h-auto w-full' : '',
    imageFit === 'original' ? 'h-auto w-auto' : ''
  );
  const pagedFrameClass = mode === 'double' ? 'max-w-[82rem]' : 'max-w-[56rem]';

  function pagedImageSlotClass(index: number) {
    if (mode !== 'double') return 'flex h-full w-full items-center justify-center overflow-hidden';
    return cn(
      'flex h-full min-w-0 flex-1 basis-1/2 items-center overflow-hidden',
      index === 0 ? 'justify-end' : 'justify-start'
    );
  }

  function renderPageImage(pageNumber: number) {
    if (failedPages.has(pageNumber)) {
      return (
        <ComicImageFallback
          dark={dark}
          pageNumber={pageNumber}
          className="h-full max-h-full max-w-full"
          style={pagePlaceholderStyle(pageNumber)}
          onRetry={() => retryImage(pageNumber)}
        />
      );
    }

    return (
      <img
        src={cachedImageUrls[pageNumber] ?? archivePageUrl(book.id, pageNumber, volumeId, retryTokens[pageNumber] ?? 0)}
        alt={`${book.title} 第 ${pageNumber} 页`}
        className={cn(imageClass, 'shadow-2xl')}
        loading="lazy"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
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
      className="h-full w-full overflow-hidden overscroll-contain px-4 pb-4 pt-6 landscape:px-3 landscape:pb-3 landscape:pt-5 md:px-8 md:pb-6 md:pt-10"
      dir={direction}
    >
      <div
        className={cn('mx-auto flex h-full min-h-0 w-full items-center justify-center overflow-hidden', mode === 'double' ? 'gap-0' : 'gap-2 md:gap-4', pagedFrameClass)}
        onClick={handlePagedClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {visualSpreadPages.map((pageNumber, index) => (
          <div key={pageNumber} className={pagedImageSlotClass(index)}>
            {renderPageImage(pageNumber)}
          </div>
        ))}
      </div>
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
