'use client';

import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import type { EbookFlow, EbookPageTurnAnimation, ReaderControls, ReaderFontFamily, ReaderProgress, ReaderTheme } from './reader-shell';

type EpubReaderProps = {
  bookId: string;
  title: string;
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  fontFamily: ReaderFontFamily;
  ebookFlow: EbookFlow;
  ebookPageTurnAnimation: EbookPageTurnAnimation;
  initialCfi: string;
  initialScrollTop: number;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress, extra?: Record<string, unknown>) => void;
  onActivity: () => void;
  onTap: () => void;
  onReady?: () => void;
};

type EpubLocationStore = {
  generate: (chars?: number) => Promise<unknown>;
  cfiFromPercentage: (percentage: number) => string;
  length: () => number;
  locationFromCfi: (cfi: string) => number;
};

type EpubView = {
  document?: Document;
};

type EpubBookWithReadiness = Book & {
  ready?: Promise<unknown>;
  opened?: Promise<unknown>;
  displayOptions?: unknown;
  package?: {
    metadata?: {
      direction?: string;
    };
  };
};

type ReaderDocument = Document & {
  __shukuReaderEventsBound?: boolean;
};

const themeTokens: Record<ReaderTheme, { color: string; background: string; link: string }> = {
  day: { color: '#1E293B', background: '#F7F7F4', link: '#2563EB' },
  warm: { color: '#2B2118', background: '#FDF6EA', link: '#B45309' },
  night: { color: '#E2E8F0', background: '#0F172A', link: '#93C5FD' },
  black: { color: '#F8FAFC', background: '#000000', link: '#93C5FD' }
};

const fontFamilies: Record<ReaderFontFamily, string> = {
  system: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
};

function applyTheme(rendition: Rendition, theme: ReaderTheme, fontSize: number, lineHeight: number, fontFamily: ReaderFontFamily) {
  const tokens = themeTokens[theme];
  rendition.themes.default({
    body: {
      color: `${tokens.color} !important`,
      background: `${tokens.background} !important`,
      'font-family': `${fontFamilies[fontFamily]} !important`,
      'font-size': `${fontSize}px !important`,
      'line-height': `${lineHeight} !important`,
      margin: '0 !important'
    },
    p: {
      'line-height': `${lineHeight} !important`
    },
    a: {
      color: `${tokens.link} !important`
    },
    img: {
      'max-width': '100% !important',
      height: 'auto !important'
    }
  });
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readerViewportForContainer(container: HTMLElement) {
  return {
    width: container.clientWidth || window.innerWidth,
    height: container.clientHeight || window.innerHeight
  };
}

function isCenterClick(event: MouseEvent, viewport: { width: number; height: number }) {
  const { width, height } = viewport;
  const x = readerPageX(event.clientX, width);
  return x >= width * 0.33 && x <= width * 0.67 && event.clientY >= height * 0.2 && event.clientY <= height * 0.85;
}

function readerPageX(clientX: number, width: number) {
  if (width <= 0) return clientX;
  return ((clientX % width) + width) % width;
}

function isInteractiveElement(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('a, button, input, textarea, select, label, [contenteditable="true"]'));
}

function stripScripts(document: Document) {
  document.querySelectorAll('script').forEach((script) => script.remove());
}

function scrollTopFromView(view: EpubView | null) {
  const doc = view?.document;
  if (!doc) return 0;
  return doc.scrollingElement?.scrollTop ?? doc.documentElement.scrollTop ?? doc.body.scrollTop ?? 0;
}

function scrollViewTo(view: EpubView | null, top: number) {
  const target = view?.document?.scrollingElement ?? view?.document?.documentElement ?? view?.document?.body;
  target?.scrollTo({ top });
}

function scrollViewByPage(view: EpubView | null, direction: 1 | -1) {
  const target = view?.document?.scrollingElement ?? view?.document?.documentElement ?? view?.document?.body;
  if (!target) return false;
  target.scrollBy({ top: target.clientHeight * 0.86 * direction, behavior: 'smooth' });
  return true;
}

function isStaleEpubDisplayOptionsError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("Cannot read properties of undefined") && message.includes("displayOptions");
}

async function waitForEpubPackage(book: EpubBookWithReadiness) {
  await book.opened?.catch(() => undefined);
  await book.ready?.catch(() => undefined);
  if (!book.displayOptions) {
    book.displayOptions = {};
  }
}

function isRtlBook(book: EpubBookWithReadiness) {
  return book.package?.metadata?.direction === 'rtl';
}

function waitForAnimationFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resetPageTurnAnimation(element: HTMLElement | null) {
  if (!element) return;
  element.style.transition = '';
  element.style.transform = '';
  element.style.opacity = '';
  element.style.willChange = '';
}

async function runKindlePageTurn(element: HTMLElement, direction: 1 | -1, action: () => Promise<unknown>) {
  const distance = Math.min(28, Math.max(14, element.clientWidth * 0.026));
  element.style.willChange = 'transform, opacity';
  await action();
  await waitForAnimationFrame();
  const animation = element.animate([
    { transform: `translate3d(${direction * distance}px, 0, 0)`, opacity: 0.72 },
    { transform: 'translate3d(0, 0, 0)', opacity: 1 }
  ], {
    duration: 145,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both'
  });
  await animation.finished.catch(() => undefined);
  resetPageTurnAnimation(element);
}

export function EbookReader({
  bookId,
  title,
  theme,
  fontSize,
  lineHeight,
  pageWidth,
  fontFamily,
  ebookFlow,
  ebookPageTurnAnimation,
  initialCfi,
  initialScrollTop,
  onControls,
  onProgress,
  onActivity,
  onTap,
  onReady
}: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const currentViewRef = useRef<EpubView | null>(null);
  const onActivityRef = useRef(onActivity);
  const onProgressRef = useRef(onProgress);
  const onTapRef = useRef(onTap);
  const onReadyRef = useRef(onReady);
  const ebookPageTurnAnimationRef = useRef(ebookPageTurnAnimation);
  const navigationBusyRef = useRef(false);
  const lastNavigationAtRef = useRef(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    onActivityRef.current = onActivity;
    onProgressRef.current = onProgress;
    onTapRef.current = onTap;
    onReadyRef.current = onReady;
    ebookPageTurnAnimationRef.current = ebookPageTurnAnimation;
  }, [ebookPageTurnAnimation, onActivity, onProgress, onReady, onTap]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let canceled = false;
    let initializingReader = true;
    let destroyRequested = false;
    let readerDestroyed = false;
    let localRendition: Rendition | null = null;
    const abortController = new AbortController();
    setLoading(true);
    setError('');
    container.replaceChildren();

    const book = ePub();
    bookRef.current = book;

    const suppressStaleCleanupError = (event: PromiseRejectionEvent) => {
      if ((canceled || destroyRequested) && isStaleEpubDisplayOptionsError(event.reason)) {
        event.preventDefault();
      }
    };
    const suppressStaleCleanupWindowError = (event: ErrorEvent) => {
      if ((canceled || destroyRequested) && isStaleEpubDisplayOptionsError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', suppressStaleCleanupError, { capture: true });
    window.addEventListener('error', suppressStaleCleanupWindowError, { capture: true });

    const destroyReader = () => {
      if (readerDestroyed) return;
      readerDestroyed = true;
      localRendition?.destroy();
      window.setTimeout(() => book.destroy(), 10000);
    };

    fetch(`/api/books/${bookId}/file`, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) throw new Error('EPUB 文件加载失败');
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        if (canceled) return;
        await book.open(buffer, 'binary');
        await waitForEpubPackage(book as EpubBookWithReadiness);
      })
      .then(async () => {
        if (canceled || destroyRequested) return;
        book.spine.hooks.content.register(stripScripts);
        const rendition = book.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: ebookFlow === 'scrolled' ? 'scrolled-doc' : 'paginated',
          spread: 'none',
          allowScriptedContent: false
        });
        localRendition = rendition;
        renditionRef.current = rendition;
        applyTheme(rendition, theme, fontSize, lineHeight, fontFamily);
        const rawNext = () => (isRtlBook(book as EpubBookWithReadiness) ? rendition.prev() : rendition.next());
        const rawPrev = () => (isRtlBook(book as EpubBookWithReadiness) ? rendition.next() : rendition.prev());
        const navigateOnce = (direction: 1 | -1, action: () => Promise<unknown>) => {
          if (navigationBusyRef.current || Date.now() - lastNavigationAtRef.current < 220) {
            return Promise.resolve();
          }
          navigationBusyRef.current = true;
          const shouldAnimate = ebookFlow === 'paginated' && ebookPageTurnAnimationRef.current === 'kindle' && !prefersReducedMotion();
          const navigation = shouldAnimate
            ? runKindlePageTurn(container, direction, action)
            : action();
          return navigation.finally(() => {
            resetPageTurnAnimation(container);
            navigationBusyRef.current = false;
            lastNavigationAtRef.current = Date.now();
          });
        };
        const goNext = () => navigateOnce(1, rawNext);
        const goPrev = () => navigateOnce(-1, rawPrev);

        const locations = book.locations as unknown as EpubLocationStore;
        const locationsReady = locations.generate(1200).catch(() => undefined);

        rendition.on('rendered', (_section: unknown, view: EpubView) => {
          currentViewRef.current = view;
          const document = view.document as ReaderDocument | undefined;
          if (document && !document.__shukuReaderEventsBound) {
            document.__shukuReaderEventsBound = true;
            let touchStartX = 0;
            let touchStartY = 0;
            let touchStartTime = 0;
            let suppressClickUntil = 0;

            document.addEventListener('keydown', (event) => {
              if (isInteractiveElement(event.target)) return;
              if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
                event.preventDefault();
                onActivityRef.current();
                if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) return;
                void goPrev();
                return;
              }
              if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
                event.preventDefault();
                onActivityRef.current();
                if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) return;
                void goNext();
                return;
              }
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                onActivityRef.current();
                if (ebookFlow === 'scrolled') {
                  const target = currentViewRef.current?.document?.scrollingElement ?? currentViewRef.current?.document?.documentElement;
                  if (target) {
                    const top = event.key === 'Home' ? 0 : Math.max(0, target.scrollHeight - target.clientHeight);
                    target.scrollTo({ top, behavior: 'smooth' });
                    return;
                  }
                }
                void locationsReady.then(() => {
                  const cfi = locations.cfiFromPercentage(event.key === 'Home' ? 0 : 1);
                  if (cfi) void rendition.display(cfi);
                });
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onActivityRef.current();
              }
            });

            document.addEventListener('click', (event) => {
              if (Date.now() < suppressClickUntil) return;
              if (isInteractiveElement(event.target)) return;
              const viewport = readerViewportForContainer(container);
              const { width } = viewport;
              const x = readerPageX(event.clientX, width);
              if (isCenterClick(event, viewport)) {
                onTapRef.current();
                return;
              }
              onActivityRef.current();
              if (x < width * 0.33) {
                if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) return;
                void goPrev();
              } else if (x > width * 0.67) {
                if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) return;
                void goNext();
              }
            });

            document.addEventListener('touchstart', (event) => {
              const touch = event.changedTouches[0];
              if (!touch) return;
              touchStartX = touch.clientX;
              touchStartY = touch.clientY;
              touchStartTime = Date.now();
            }, { passive: true });

            document.addEventListener('touchend', (event) => {
              if (isInteractiveElement(event.target)) return;
              const touch = event.changedTouches[0];
              if (!touch) return;
              const deltaX = touch.clientX - touchStartX;
              const deltaY = touch.clientY - touchStartY;
              const elapsed = Date.now() - touchStartTime;
              if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 900) {
                suppressClickUntil = Date.now() + 450;
                onActivityRef.current();
                if (deltaX < 0) {
                  if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) return;
                  void goNext();
                } else {
                  if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) return;
                  void goPrev();
                }
                return;
              }
              if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
                const { width } = readerViewportForContainer(container);
                const x = readerPageX(touch.clientX, width);
                suppressClickUntil = Date.now() + 450;
                if (x >= width * 0.33 && x <= width * 0.67) {
                  onTapRef.current();
                  return;
                }
                onActivityRef.current();
                if (x < width * 0.33) {
                  if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) return;
                  void goPrev();
                } else {
                  if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) return;
                  void goNext();
                }
              }
            }, { passive: true });
          }
          view.document?.addEventListener('scroll', () => {
            if (ebookFlow !== 'scrolled') return;
            onActivityRef.current();
            const top = scrollTopFromView(view);
            const scrollElement = view.document?.scrollingElement ?? view.document?.documentElement;
            const max = Math.max(1, (scrollElement?.scrollHeight ?? 1) - (scrollElement?.clientHeight ?? 0));
            onProgressRef.current({
              page: 1,
              total: null,
              percent: clampPercent((top / max) * 100),
              position: initialCfi || '',
              label: `${clampPercent((top / max) * 100)}%`
            }, { scrollTop: top, cfi: initialCfi || '', percentage: clampPercent((top / max) * 100), chapterIndex: 1 });
          }, { passive: true });
        });

        onControls({
          next: async () => {
            onActivityRef.current();
            if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) return;
            await goNext();
          },
          prev: async () => {
            onActivityRef.current();
            if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) return;
            await goPrev();
          },
          jumpToProgress: async (value) => {
            onActivityRef.current();
            if (ebookFlow === 'scrolled') {
              const view = currentViewRef.current;
              const target = view?.document?.scrollingElement ?? view?.document?.documentElement;
              if (target) {
                const max = Math.max(0, target.scrollHeight - target.clientHeight);
                target.scrollTo({ top: Math.round(max * (clampPercent(value) / 100)), behavior: 'smooth' });
                return;
              }
            }
            await locationsReady;
            const cfi = locations.cfiFromPercentage(Math.max(0, Math.min(1, value / 100)));
            if (cfi) await rendition.display(cfi);
          },
          jumpToIndex: async (index) => {
            onActivityRef.current();
            await rendition.display(Math.max(0, index - 1));
          }
        });

        rendition.on('relocated', async (location: Location) => {
          await locationsReady;
          const cfi = location.start?.cfi ?? '';
          const locationTotal = locations.length();
          const globalPage = cfi && locationTotal > 0 ? Math.max(1, locations.locationFromCfi(cfi) + 1) : Math.max(1, (location.start?.index ?? 0) + 1);
          const percent = locationTotal > 1
            ? clampPercent(((globalPage - 1) / (locationTotal - 1)) * 100)
            : clampPercent((location.start?.percentage ?? 0) * 100);
          const displayed = location.start?.displayed;
          const scrollTop = ebookFlow === 'scrolled' ? scrollTopFromView(currentViewRef.current) : 0;
          onProgressRef.current({
            page: globalPage,
            total: locationTotal || (displayed?.total ?? null),
            percent,
            position: cfi,
            label: locationTotal ? `第 ${globalPage} / ${locationTotal} 页` : displayed?.total ? `第 ${displayed.page} / ${displayed.total} 屏` : `第 ${globalPage} 章`
          }, { percentage: percent, pageIndex: globalPage, totalPages: locationTotal || (displayed?.total ?? null), chapterIndex: location.start?.index ?? 0, scrollTop, cfi });
        });

        await rendition.display(initialCfi || undefined);
        if (ebookFlow === 'scrolled' && initialScrollTop > 0) {
          window.setTimeout(() => scrollViewTo(currentViewRef.current, initialScrollTop), 150);
        }
      })
      .then(() => {
        if (!canceled) {
          setLoading(false);
          onReadyRef.current?.();
        }
      })
      .catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : 'EPUB 加载失败');
      })
      .finally(() => {
        initializingReader = false;
        if (destroyRequested) destroyReader();
      });

    return () => {
      canceled = true;
      destroyRequested = true;
      abortController.abort();
      onControls(null);
      if (!initializingReader) destroyReader();
      resetPageTurnAnimation(container);
      renditionRef.current = null;
      bookRef.current = null;
      currentViewRef.current = null;
      window.setTimeout(() => {
        window.removeEventListener('unhandledrejection', suppressStaleCleanupError, { capture: true });
        window.removeEventListener('error', suppressStaleCleanupWindowError, { capture: true });
      }, 30000);
    };
  }, [bookId, ebookFlow, retryToken]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    applyTheme(rendition, theme, fontSize, lineHeight, fontFamily);
  }, [fontFamily, fontSize, lineHeight, theme]);

  const tokens = themeTokens[theme];

  return (
    <div className="flex h-full w-full justify-center px-3 py-4 md:px-8 md:py-8">
      <div
        className="relative h-full min-h-0 w-full overflow-hidden shadow-2xl md:rounded-[24px] md:border md:border-white/10"
        style={{ maxWidth: `${pageWidth}px`, background: tokens.background }}
      >
        <div ref={containerRef} className="h-full w-full" aria-label={`${title} EPUB 阅读器`} />
        {loading ? <div className="pointer-events-none absolute inset-0" style={{ background: tokens.background }} /> : null}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-red-950/90 p-6 text-center text-sm text-red-100">
            <div>{error}</div>
            <button
              type="button"
              onClick={() => setRetryToken((value) => value + 1)}
              className="min-h-11 rounded-xl bg-white/10 px-4 font-medium text-white transition active:scale-[0.98] hover:bg-white/15"
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { EbookReader as EpubReader };
