'use client';

import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import { readerThemeSurfaces, type EbookFlow, type EbookPageTurnAnimation, type ReaderControls, type ReaderFontFamily, type ReaderProgress, type ReaderTheme } from './reader-shell';

type EpubReaderProps = {
  editionId: string;
  volumeId?: string | null;
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
  initialPercentage: number;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress, extra?: Record<string, unknown>) => void;
  onActivity: () => void;
  onTap: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
};

type EpubLocationStore = {
  generate: (chars?: number) => Promise<unknown>;
  cfiFromPercentage: (percentage: number) => string;
  length: () => number;
  locationFromCfi: (cfi: string) => number;
};

type EpubView = {
  document?: Document;
  iframe?: HTMLIFrameElement;
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

type NavigationIntent = 'initial' | 'next' | 'prev' | 'display' | 'progress' | 'index' | 'scroll';

type RenditionWithReporting = Rendition & {
  currentLocation?: () => Location | Location[] | null;
  reportLocation?: () => unknown;
};

const themeTokens: Record<ReaderTheme, { color: string; background: string; link: string }> = {
  day: { color: '#1E293B', background: readerThemeSurfaces.day.background, link: '#2563EB' },
  warm: { color: '#2B2118', background: readerThemeSurfaces.warm.background, link: '#B45309' },
  night: { color: '#E2E8F0', background: readerThemeSurfaces.night.background, link: '#93C5FD' },
  black: { color: '#F8FAFC', background: readerThemeSurfaces.black.background, link: '#93C5FD' }
};

const fontFamilies: Record<ReaderFontFamily, string> = {
  system: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
};

const readerContentMaxWidth = 960;

const executableElementSelector = 'script, iframe, object, embed';
const urlAttributeNames = ['href', 'src', 'xlink:href', 'formaction', 'action', 'data', 'poster', 'srcset'];
const activeStylePattern = /(?:javascript\s*:|expression\s*\()/i;
const fallbackExecutableElementPattern = /<\s*(script|iframe|object|embed)\b[^>]*(?:\/\s*>|>[\s\S]*?<\s*\/\s*\1\s*>)/gi;
const fallbackEventAttributePattern = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const fallbackDangerousUrlAttributePattern = /\s+(href|src|xlink:href|formaction|action|data|poster|srcset)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s"'=<>`]+)/gi;
const fallbackActiveStyleAttributePattern = /\s+style\s*=\s*(?:"[^"]*(?:javascript\s*:|expression\s*\()[^"]*"|'[^']*(?:javascript\s*:|expression\s*\()[^']*'|[^\s"'=<>`]*(?:javascript\s*:|expression\s*\()[^\s"'=<>`]*)/gi;

function applyTheme(rendition: Rendition, theme: ReaderTheme, fontSize: number, lineHeight: number, fontFamily: ReaderFontFamily, pageWidth: number) {
  const tokens = themeTokens[theme];
  rendition.themes.default({
    html: {
      background: `${tokens.background} !important`
    },
    body: {
      color: `${tokens.color} !important`,
      background: `${tokens.background} !important`,
      'font-family': `${fontFamilies[fontFamily]} !important`,
      'font-size': `${fontSize}px !important`,
      'line-height': `${lineHeight} !important`,
      margin: '0 auto !important',
      'max-width': `${pageWidth}px !important`,
      padding: '0 24px !important',
      'box-sizing': 'border-box !important'
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

function normalizedPercentage(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

function readerViewportForContainer(container: HTMLElement) {
  return {
    width: container.clientWidth || window.innerWidth,
    height: container.clientHeight || window.innerHeight
  };
}

function readerPageX(clientX: number, width: number) {
  if (width <= 0) return clientX;
  return ((clientX % width) + width) % width;
}

function isCenterPointer(clientX: number, clientY: number, viewport: { width: number; height: number }) {
  const x = readerPageX(clientX, viewport.width);
  return x >= viewport.width * 0.33 && x <= viewport.width * 0.67 && clientY >= viewport.height * 0.2 && clientY <= viewport.height * 0.85;
}

function isInteractiveElement(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('a, button, input, textarea, select, label, [contenteditable="true"]'));
}

function sanitizeEpubDocument(document: Document) {
  document.querySelectorAll(executableElementSelector).forEach((element) => element.remove());
  document.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (
        name.startsWith('on')
        || (urlAttributeNames.includes(name) && value.includes('javascript:'))
        || (name === 'style' && activeStylePattern.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    });
  });
}

function sanitizeEpubMarkupFallback(markup: string) {
  return markup
    .replace(fallbackExecutableElementPattern, '')
    .replace(fallbackEventAttributePattern, '')
    .replace(fallbackDangerousUrlAttributePattern, '')
    .replace(fallbackActiveStyleAttributePattern, '');
}

function sanitizeEpubMarkup(markup: string) {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return sanitizeEpubMarkupFallback(markup);
  }

  try {
    const document = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
    if (document.querySelector('parsererror')) return sanitizeEpubMarkupFallback(markup);
    sanitizeEpubDocument(document);
    return new XMLSerializer().serializeToString(document);
  } catch {
    return sanitizeEpubMarkupFallback(markup);
  }
}

function allowScriptsForEpubView(view: EpubView) {
  const iframe = view.iframe;
  if (!iframe) return;
  const current = iframe.getAttribute('sandbox') || '';
  if (!current.includes('allow-scripts')) {
    iframe.setAttribute('sandbox', `${current} allow-scripts`.trim());
  }
}

function scrollElementFromView(view: EpubView | null) {
  const doc = view?.document;
  return doc?.scrollingElement ?? doc?.documentElement ?? doc?.body ?? null;
}

function scrollTopFromView(view: EpubView | null) {
  return scrollElementFromView(view)?.scrollTop ?? 0;
}

function scrollViewTo(view: EpubView | null, top: number) {
  scrollElementFromView(view)?.scrollTo({ top });
}

function canScrollPage(view: EpubView | null, direction: 1 | -1) {
  const target = scrollElementFromView(view);
  if (!target) return false;
  if (direction > 0) return target.scrollTop + target.clientHeight < target.scrollHeight - 4;
  return target.scrollTop > 4;
}

function scrollViewByPage(view: EpubView | null, direction: 1 | -1) {
  const target = scrollElementFromView(view);
  if (!target || !canScrollPage(view, direction)) return false;
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
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForNavigationAction(action: () => Promise<unknown>, timeoutMs = 1800) {
  const actionPromise = action();
  actionPromise.catch(() => undefined);
  await Promise.race([actionPromise, wait(timeoutMs)]);
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
  await waitForNavigationAction(action);
  await waitForAnimationFrame();
  const animation = element.animate([
    { transform: `translate3d(${direction * distance}px, 0, 0)`, opacity: 0.72 },
    { transform: 'translate3d(0, 0, 0)', opacity: 1 }
  ], {
    duration: 145,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both'
  });
  await Promise.race([animation.finished.catch(() => undefined), wait(260)]);
  resetPageTurnAnimation(element);
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

function reportRenditionLocation(rendition: Rendition | null) {
  const reporter = (rendition as RenditionWithReporting | null)?.reportLocation;
  if (typeof reporter !== 'function') return;
  try {
    reporter.call(rendition);
  } catch {
    // epub.js can briefly have no current view while it is swapping sections.
  }
}

function currentRenditionLocation(rendition: Rendition | null) {
  const getter = (rendition as RenditionWithReporting | null)?.currentLocation;
  if (typeof getter !== 'function') return null;
  try {
    const location = getter.call(rendition);
    return Array.isArray(location) ? location[0] ?? null : location;
  } catch {
    return null;
  }
}

function hrefFromLocation(location: Location) {
  const start = location.start as { href?: unknown } | undefined;
  return typeof start?.href === 'string' ? start.href : '';
}

export function EbookReader({
  editionId,
  volumeId,
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
  initialPercentage,
  onControls,
  onProgress,
  onActivity,
  onTap,
  onReady,
  onError
}: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const currentViewRef = useRef<EpubView | null>(null);
  const currentCfiRef = useRef(initialCfi);
  const navigationTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const navigationTokenRef = useRef(0);
  const initialScrollTopRef = useRef(initialScrollTop);
  const initialPercentageRef = useRef(initialPercentage);
  const onActivityRef = useRef(onActivity);
  const onProgressRef = useRef(onProgress);
  const onTapRef = useRef(onTap);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const ebookPageTurnAnimationRef = useRef(ebookPageTurnAnimation);
  const themeRef = useRef(theme);
  const fontSizeRef = useRef(fontSize);
  const lineHeightRef = useRef(lineHeight);
  const fontFamilyRef = useRef(fontFamily);
  const pageWidthRef = useRef(pageWidth);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    onActivityRef.current = onActivity;
    onProgressRef.current = onProgress;
    onTapRef.current = onTap;
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    ebookPageTurnAnimationRef.current = ebookPageTurnAnimation;
    themeRef.current = theme;
    fontSizeRef.current = fontSize;
    lineHeightRef.current = lineHeight;
    fontFamilyRef.current = fontFamily;
    pageWidthRef.current = pageWidth;
  }, [ebookPageTurnAnimation, fontFamily, fontSize, lineHeight, onActivity, onError, onProgress, onReady, onTap, pageWidth, theme]);

  useEffect(() => {
    if (initialCfi) currentCfiRef.current = initialCfi;
    initialScrollTopRef.current = initialScrollTop;
    initialPercentageRef.current = initialPercentage;
  }, [initialCfi, initialPercentage, initialScrollTop]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let canceled = false;
    let initializingReader = true;
    let destroyRequested = false;
    let readerDestroyed = false;
    let localRendition: Rendition | null = null;
    let lastRenderedAt = 0;
    let lastRelocatedAt = 0;
    let emitCurrentLocation: (() => void) | null = null;
    const abortController = new AbortController();

    setLoading(true);
    setNavigating(false);
    setError('');
    container.replaceChildren();
    navigationTailRef.current = Promise.resolve();
    navigationTokenRef.current += 1;

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

    const finishVisibleCommit = async (startedAt: number) => {
      await waitForAnimationFrame();
      await waitForAnimationFrame();
      if (lastRenderedAt <= startedAt && lastRelocatedAt <= startedAt) {
        await wait(80);
      }
    };

    const runNavigation = (intent: NavigationIntent, action: () => Promise<unknown>, options: { direction?: 1 | -1; cover?: boolean } = {}) => {
      const token = navigationTokenRef.current + 1;
      navigationTokenRef.current = token;
      const cover = options.cover ?? intent !== 'scroll';
      const task = navigationTailRef.current.catch(() => undefined).then(async () => {
        if (canceled || readerDestroyed) return;
        const startedAt = performance.now();
        if (cover) setNavigating(true);
        const direction = options.direction;
        const shouldAnimate = direction !== undefined
          && ebookFlow === 'paginated'
          && ebookPageTurnAnimationRef.current === 'kindle'
          && !prefersReducedMotion();
        try {
          if (shouldAnimate) await runKindlePageTurn(container, direction, action);
          else await waitForNavigationAction(action);
          reportRenditionLocation(localRendition);
          emitCurrentLocation?.();
          if (cover) await finishVisibleCommit(startedAt);
          emitCurrentLocation?.();
          window.setTimeout(() => {
            if (!canceled && !readerDestroyed && navigationTokenRef.current === token) emitCurrentLocation?.();
          }, 80);
        } finally {
          resetPageTurnAnimation(container);
          if (cover && navigationTokenRef.current === token && !canceled) {
            setNavigating(false);
          }
        }
      });
      navigationTailRef.current = task;
      return task.then(() => undefined);
    };

    const updateScrolledProgress = (view: EpubView, locations: EpubLocationStore) => {
      if (ebookFlow !== 'scrolled') return;
      const scrollElement = scrollElementFromView(view);
      const cfi = currentCfiRef.current;
      const max = Math.max(1, (scrollElement?.scrollHeight ?? 1) - (scrollElement?.clientHeight ?? 0));
      const chapterPercent = clampPercent((scrollTopFromView(view) / max) * 100);
      const locationTotal = locations.length();
      const pageIndex = cfi && locationTotal > 0 ? Math.max(1, locations.locationFromCfi(cfi) + 1) : 1;
      const percent = locationTotal > 1 ? clampPercent(((pageIndex - 1) / (locationTotal - 1)) * 100) : chapterPercent;
      onProgressRef.current({
        page: pageIndex,
        total: locationTotal || null,
        percent,
        position: cfi,
        label: locationTotal ? `第 ${pageIndex} / ${locationTotal} 页` : `${chapterPercent}%`
      }, { scrollTop: scrollTopFromView(view), cfi, percentage: percent, chapterPercent, pageIndex, totalPages: locationTotal || null });
    };

    const setupDocumentEvents = (document: ReaderDocument, locations: EpubLocationStore, ensureLocationsReady: () => Promise<unknown>, runNext: () => Promise<void>, runPrev: () => Promise<void>) => {
      if (document.__shukuReaderEventsBound) return;
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
          void runPrev();
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
          event.preventDefault();
          onActivityRef.current();
          void runNext();
          return;
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          onActivityRef.current();
          const targetPercent = event.key === 'Home' ? 0 : 1;
          void runNavigation('progress', async () => {
            await ensureLocationsReady();
            const cfi = locations.cfiFromPercentage(targetPercent);
            if (cfi) await renditionRef.current?.display(cfi);
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
        const target = event.target;
        const link = target instanceof Element ? target.closest('a') : null;
        if (link) {
          event.preventDefault();
          return;
        }
        if (isInteractiveElement(target)) return;
        const viewport = readerViewportForContainer(container);
        const x = readerPageX(event.clientX, viewport.width);
        if (isCenterPointer(event.clientX, event.clientY, viewport)) {
          onTapRef.current();
          return;
        }
        onActivityRef.current();
        if (x < viewport.width * 0.33) void runPrev();
        else if (x > viewport.width * 0.67) void runNext();
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
          void (deltaX < 0 ? runNext() : runPrev());
          return;
        }
        if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
          suppressClickUntil = Date.now() + 450;
          const viewport = readerViewportForContainer(container);
          const x = readerPageX(touch.clientX, viewport.width);
          if (isCenterPointer(touch.clientX, touch.clientY, viewport)) {
            onTapRef.current();
            return;
          }
          onActivityRef.current();
          if (x < viewport.width * 0.33) void runPrev();
          else if (x > viewport.width * 0.67) void runNext();
        }
      }, { passive: true });

      document.addEventListener('scroll', () => {
        if (ebookFlow !== 'scrolled') return;
        onActivityRef.current();
        const view = currentViewRef.current;
        if (view) updateScrolledProgress(view, locations);
      }, { passive: true });
    };

    const fileUrl = volumeId ? `/api/editions/${editionId}/file?volume=${encodeURIComponent(volumeId)}` : `/api/editions/${editionId}/file`;
    fetch(fileUrl, { signal: abortController.signal })
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
        book.spine.hooks.content.register(sanitizeEpubDocument);
        book.spine.hooks.serialize.register((output: string, section: { output?: string }) => {
          section.output = sanitizeEpubMarkup(section.output ?? output);
        });
        const rendition = book.renderTo(container, {
          manager: 'default',
          width: '100%',
          height: '100%',
          flow: ebookFlow === 'scrolled' ? 'scrolled-doc' : 'paginated',
          spread: 'none',
          allowScriptedContent: true
        });
        localRendition = rendition;
        renditionRef.current = rendition;
        applyTheme(rendition, themeRef.current, fontSizeRef.current, lineHeightRef.current, fontFamilyRef.current, pageWidthRef.current);

        const rawNext = () => (isRtlBook(book as EpubBookWithReadiness) ? rendition.prev() : rendition.next());
        const rawPrev = () => (isRtlBook(book as EpubBookWithReadiness) ? rendition.next() : rendition.prev());
        const locations = book.locations as unknown as EpubLocationStore;
        let locationsGeneration: Promise<unknown> | null = null;
        const ensureLocationsReady = () => {
          if (locations.length() > 0) return Promise.resolve();
          locationsGeneration ??= locations.generate(1200).catch(() => undefined);
          return locationsGeneration;
        };
        const emitLocationProgress = (location: Location) => {
          lastRelocatedAt = performance.now();
          const cfi = location.start?.cfi ?? '';
          if (cfi) currentCfiRef.current = cfi;
          const sectionIndex = Math.max(0, Math.round(location.start?.index ?? 0));
          const currentHref = hrefFromLocation(location);
          const displayed = location.start?.displayed;
          const displayedPage = typeof displayed?.page === 'number' && Number.isFinite(displayed.page)
            ? Math.max(1, Math.round(displayed.page))
            : null;
          const displayedTotal = typeof displayed?.total === 'number' && Number.isFinite(displayed.total) && displayed.total > 0
            ? Math.max(1, Math.round(displayed.total))
            : null;
          const locationTotal = locations.length();
          const locationIndex = cfi && locationTotal > 0 ? locations.locationFromCfi(cfi) : Math.max(0, (location.start?.index ?? 0));
          const fixedPage = locationTotal > 0 ? Math.max(1, Math.min(locationTotal, locationIndex + 1)) : Math.max(1, locationIndex + 1);
          const fixedTotal = locationTotal || null;
          const percent = fixedTotal && fixedTotal > 1
            ? clampPercent(((fixedPage - 1) / (fixedTotal - 1)) * 100)
            : clampPercent((location.start?.percentage ?? 0) * 100);
          const scrollTop = ebookFlow === 'scrolled' ? scrollTopFromView(currentViewRef.current) : 0;
          onProgressRef.current({
            page: fixedPage,
            total: fixedTotal,
            percent,
            position: cfi,
            label: fixedTotal ? `第 ${fixedPage} / ${fixedTotal} 页` : `第 ${fixedPage} 页`
          }, {
            percentage: percent,
            pageIndex: fixedPage,
            totalPages: fixedTotal,
            sectionIndex,
            currentHref,
            sectionPage: displayedPage,
            sectionTotalPages: displayedTotal,
            locationIndex,
            locationTotal: locationTotal || null,
            chapterIndex: location.start?.index ?? 0,
            scrollTop,
            cfi
          });
        };
        emitCurrentLocation = () => {
          const location = currentRenditionLocation(localRendition);
          if (location) emitLocationProgress(location);
          else reportRenditionLocation(localRendition);
        };

        const runNext = async () => {
          if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, 1)) {
            const view = currentViewRef.current;
            if (view) {
              window.requestAnimationFrame(() => updateScrolledProgress(view, locations));
              window.setTimeout(() => updateScrolledProgress(view, locations), 80);
            }
            return;
          }
          await runNavigation('next', rawNext, { direction: 1 });
        };
        const runPrev = async () => {
          if (ebookFlow === 'scrolled' && scrollViewByPage(currentViewRef.current, -1)) {
            const view = currentViewRef.current;
            if (view) {
              window.requestAnimationFrame(() => updateScrolledProgress(view, locations));
              window.setTimeout(() => updateScrolledProgress(view, locations), 80);
            }
            return;
          }
          await runNavigation('prev', rawPrev, { direction: -1 });
        };

        rendition.on('rendered', (_section: unknown, view: EpubView) => {
          lastRenderedAt = performance.now();
          currentViewRef.current = view;
          allowScriptsForEpubView(view);
          const document = view.document as ReaderDocument | undefined;
          if (!document) return;
          sanitizeEpubDocument(document);
          setupDocumentEvents(document, locations, ensureLocationsReady, runNext, runPrev);
        });

        rendition.on('relocated', emitLocationProgress);

        onControls({
          next: async () => {
            onActivityRef.current();
            await runNext();
          },
          prev: async () => {
            onActivityRef.current();
            await runPrev();
          },
          jumpToProgress: async (value) => {
            onActivityRef.current();
            await ensureLocationsReady();
            const cfi = locations.cfiFromPercentage(Math.max(0, Math.min(1, value / 100)));
            if (cfi) {
              await runNavigation('progress', async () => {
                await rendition.display(cfi);
              });
            }
          },
          jumpToHref: async (href) => {
            onActivityRef.current();
            await runNavigation('index', async () => {
              await rendition.display(href);
            });
          },
          jumpToIndex: async (index) => {
            onActivityRef.current();
            await runNavigation('index', async () => {
              await rendition.display(Math.max(0, index - 1));
            });
          }
        });

        await runNavigation('initial', async () => {
          if (initialCfi) {
            try {
              await rendition.display(initialCfi);
              return;
            } catch {
              currentCfiRef.current = '';
            }
          }
          const fallbackPercentage = initialPercentageRef.current;
          const fallbackCfi = fallbackPercentage > 0 && locations.length() > 0 ? locations.cfiFromPercentage(normalizedPercentage(fallbackPercentage)) : '';
          await rendition.display(fallbackCfi || undefined);
        });

        if (ebookFlow === 'scrolled' && initialScrollTopRef.current > 0) {
          window.setTimeout(() => {
            if (!canceled) scrollViewTo(currentViewRef.current, initialScrollTopRef.current);
          }, 150);
        }
      })
      .then(() => {
        if (!canceled) {
          setLoading(false);
          setNavigating(false);
          onReadyRef.current?.();
        }
      })
      .catch((reason: unknown) => {
        if (!canceled && !isAbortError(reason)) {
          const message = reason instanceof Error ? reason.message : 'EPUB 加载失败';
          setError(message);
          onErrorRef.current?.(message);
        }
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
  }, [editionId, volumeId, ebookFlow, onControls, retryToken]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    applyTheme(rendition, theme, fontSize, lineHeight, fontFamily, pageWidth);
    const container = containerRef.current;
    rendition.resize(container?.clientWidth ?? window.innerWidth, container?.clientHeight ?? window.innerHeight);
  }, [fontFamily, fontSize, lineHeight, pageWidth, theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const rendition = renditionRef.current;
        if (!rendition) return;
        rendition.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
        reportRenditionLocation(rendition);
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const tokens = themeTokens[theme];
  const constrainedPageWidth = Math.min(pageWidth, readerContentMaxWidth);

  return (
    <div className="flex h-full w-full flex-col px-4 pb-4 pt-6 md:px-8 md:pb-6 md:pt-10" data-allow-text-selection="true" style={{ background: tokens.background }}>
      <div
        className="relative mx-auto min-h-0 w-full flex-1 overflow-hidden"
        style={{ background: tokens.background, maxWidth: constrainedPageWidth }}
      >
        <div ref={containerRef} className="h-full w-full" aria-label={`${title} EPUB 阅读器`} />
        {loading || navigating ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-100"
            style={{ background: tokens.background, opacity: loading ? 1 : 0.96 }}
          />
        ) : null}
        {error ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-red-950/90 p-6 text-center text-sm text-red-100">
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
