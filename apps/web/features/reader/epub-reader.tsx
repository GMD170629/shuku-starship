'use client';

import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import { readerThemeSurfaces, type EbookPageTurnAnimation, type ReaderControls, type ReaderFontFamily, type ReaderProgress, type ReaderTheme } from './reader-shell';

type EpubReaderProps = {
  editionId: string;
  volumeId?: string | null;
  title: string;
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  fontFamily: ReaderFontFamily;
  ebookPageTurnAnimation: EbookPageTurnAnimation;
  initialCfi: string;
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

type EpubSpineItem = {
  href?: string;
  index?: number;
};

type EpubBookWithReadiness = Book & {
  ready?: Promise<unknown>;
  opened?: Promise<unknown>;
  displayOptions?: unknown;
  spine?: {
    items?: unknown[];
    spineItems?: unknown[];
    length?: number;
  };
  package?: {
    metadata?: {
      direction?: string;
    };
  };
};

type ReaderDocument = Document & {
  __shukuReaderEventsBound?: boolean;
};

type NavigationIntent = 'initial' | 'next' | 'prev' | 'progress' | 'index';
type ReadingDirection = 'ltr' | 'rtl';

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

function readerPointerPosition(clientX: number, clientY: number, viewport: { width: number; height: number }) {
  return {
    x: readerPageX(clientX, viewport.width),
    y: Math.max(0, Math.min(viewport.height, clientY))
  };
}

function physicalSideIntent(side: 'left' | 'right', direction: ReadingDirection): 'prev' | 'next' {
  if (direction === 'rtl') return side === 'left' ? 'next' : 'prev';
  return side === 'left' ? 'prev' : 'next';
}

function horizontalSwipeIntent(deltaX: number, direction: ReadingDirection): 'prev' | 'next' {
  if (direction === 'rtl') return deltaX > 0 ? 'next' : 'prev';
  return deltaX < 0 ? 'next' : 'prev';
}

function readerPointerIntent(clientX: number, clientY: number, viewport: { width: number; height: number }, direction: ReadingDirection): 'center' | 'prev' | 'next' | null {
  const pointer = readerPointerPosition(clientX, clientY, viewport);
  if (pointer.x >= viewport.width * 0.33 && pointer.x <= viewport.width * 0.67 && pointer.y >= viewport.height * 0.2 && pointer.y <= viewport.height * 0.85) {
    return 'center';
  }
  if (pointer.x < viewport.width * 0.33) return physicalSideIntent('left', direction);
  if (pointer.x > viewport.width * 0.67) return physicalSideIntent('right', direction);
  return null;
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

function isStaleEpubLifecycleError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("Cannot read properties of undefined")
    && (message.includes("displayOptions") || message.includes("package") || message.includes("resize") || message.includes("size"));
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
  return new Promise<void>((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 80);
    window.requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    });
  });
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

function resizeRenditionSafely(rendition: Rendition | null, width: number, height: number) {
  if (!rendition) return;
  try {
    rendition.resize(width, height);
  } catch (reason) {
    if (!isStaleEpubLifecycleError(reason)) throw reason;
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

function normalizeEpubHref(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const decoded = decodeURIComponent(value).split('#')[0].replace(/\\/g, '/');
    const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(decoded) ? new URL(decoded).pathname : decoded;
    return path.replace(/^\.?\//, '').toLowerCase();
  } catch {
    return value.split('#')[0].replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  }
}

function hrefFileName(value: string) {
  const parts = value.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function epubSpineItems(book: EpubBookWithReadiness) {
  const items = book.spine?.items ?? book.spine?.spineItems;
  return Array.isArray(items) ? items as EpubSpineItem[] : [];
}

function spineIndexForHref(book: EpubBookWithReadiness, href: string) {
  const target = normalizeEpubHref(href);
  if (!target) return null;
  const targetFile = hrefFileName(target);
  const items = epubSpineItems(book);
  const match = items.find((item) => normalizeEpubHref(item.href) === target)
    ?? items.find((item) => {
      const itemHref = normalizeEpubHref(item.href);
      return itemHref.endsWith(`/${target}`) || target.endsWith(`/${itemHref}`);
    })
    ?? items.find((item) => hrefFileName(normalizeEpubHref(item.href)) === targetFile);
  if (!match) return null;
  const index = items.indexOf(match);
  if (index >= 0) return index;
  return typeof match.index === 'number' && Number.isFinite(match.index) ? Math.max(0, Math.round(match.index)) : null;
}

function spineHrefForHref(book: EpubBookWithReadiness, href: string) {
  const target = normalizeEpubHref(href);
  if (!target) return '';
  const targetFile = hrefFileName(target);
  const items = epubSpineItems(book);
  const match = items.find((item) => normalizeEpubHref(item.href) === target)
    ?? items.find((item) => {
      const itemHref = normalizeEpubHref(item.href);
      return itemHref.endsWith(`/${target}`) || target.endsWith(`/${itemHref}`);
    })
    ?? items.find((item) => hrefFileName(normalizeEpubHref(item.href)) === targetFile);
  return typeof match?.href === 'string' ? match.href : href;
}

function viewHref(view: EpubView | null) {
  const base = view?.document?.querySelector('base')?.getAttribute('href') ?? '';
  return normalizeEpubHref(base);
}

function viewMatchesHref(view: EpubView | null, href: string) {
  const current = viewHref(view);
  const target = normalizeEpubHref(href);
  return Boolean(current && target && (current === target || current.endsWith(`/${target}`) || target.endsWith(`/${current}`)));
}

async function displayTargetWithTimeout(rendition: Rendition, target?: string | number, timeoutMs = 1800) {
  const displayPromise = typeof target === 'number'
    ? rendition.display(target)
    : target === undefined
      ? rendition.display()
      : rendition.display(target);
  displayPromise.catch(() => undefined);
  await Promise.race([displayPromise, wait(timeoutMs)]);
}

async function displayHref(rendition: Rendition, book: EpubBookWithReadiness, href: string, currentView: () => EpubView | null) {
  let lastError: unknown = null;
  const spineHref = spineHrefForHref(book, href);
  const targets: Array<string | number | undefined> = [];
  if (spineHref) targets.push(spineHref);
  if (href && href !== spineHref) targets.push(href);
  const spineIndex = spineIndexForHref(book, href);
  if (spineIndex !== null) targets.push(spineIndex);
  targets.push(undefined);

  for (const target of targets) {
    try {
      await displayTargetWithTimeout(rendition, target);
      await wait(120);
      if (viewMatchesHref(currentView(), href)) return;
    } catch (reason) {
      lastError = reason;
    }
  }
  if (lastError) throw lastError;
  const currentHref = viewHref(currentView());
  throw new Error(`无法定位 EPUB 章节：${href}${currentHref ? `（当前章节：${currentHref}）` : ''}`);
}

function spineSectionCount(book: EpubBookWithReadiness) {
  const items = book.spine?.items ?? book.spine?.spineItems;
  if (Array.isArray(items) && items.length > 0) return items.length;
  return typeof book.spine?.length === 'number' && Number.isFinite(book.spine.length) ? Math.max(0, Math.round(book.spine.length)) : 0;
}

function fallbackPercentFromLocation(location: Location, sectionIndex: number, displayedPage: number | null, displayedTotal: number | null, sectionCount: number) {
  const rawPercentage = typeof location.start?.percentage === 'number' && Number.isFinite(location.start.percentage)
    ? location.start.percentage
    : 0;
  if (rawPercentage > 0) return clampPercent(rawPercentage * 100);
  if (sectionCount > 1) {
    const pageOffset = displayedPage && displayedTotal && displayedTotal > 1
      ? Math.max(0, Math.min(displayedTotal - 1, displayedPage - 1)) / displayedTotal
      : 0;
    return clampPercent(((sectionIndex + pageOffset) / sectionCount) * 100);
  }
  if (displayedPage && displayedTotal && displayedTotal > 1) {
    return clampPercent(((displayedPage - 1) / (displayedTotal - 1)) * 100);
  }
  return 0;
}

export function EpubReader({
  editionId,
  volumeId,
  title,
  theme,
  fontSize,
  lineHeight,
  pageWidth,
  fontFamily,
  ebookPageTurnAnimation,
  initialCfi,
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
  const runNextRef = useRef<() => Promise<void>>(async () => undefined);
  const runPrevRef = useRef<() => Promise<void>>(async () => undefined);
  const readingDirectionRef = useRef<ReadingDirection>('ltr');
  const hostTouchRef = useRef({ x: 0, y: 0, time: 0 });
  const hostSuppressClickUntilRef = useRef(0);
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
    initialPercentageRef.current = initialPercentage;
  }, [initialCfi, initialPercentage]);

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
      if ((canceled || destroyRequested) && isStaleEpubLifecycleError(event.reason)) {
        event.preventDefault();
      }
    };
    const suppressStaleCleanupWindowError = (event: ErrorEvent) => {
      if ((canceled || destroyRequested) && isStaleEpubLifecycleError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', suppressStaleCleanupError, { capture: true });
    window.addEventListener('error', suppressStaleCleanupWindowError, { capture: true });

    const destroyReader = () => {
      if (readerDestroyed) return;
      readerDestroyed = true;
      try {
        localRendition?.destroy();
      } catch (reason) {
        if (!isStaleEpubLifecycleError(reason)) throw reason;
      }
      window.setTimeout(() => book.destroy(), 10000);
    };

    const finishVisibleCommit = async (startedAt: number) => {
      await waitForAnimationFrame();
      await waitForAnimationFrame();
      if (lastRenderedAt <= startedAt && lastRelocatedAt <= startedAt) {
        await wait(80);
      }
    };

    const runNavigation = (intent: NavigationIntent, action: () => Promise<unknown>, options: { direction?: 1 | -1; cover?: boolean; timeoutMs?: number } = {}) => {
      const token = navigationTokenRef.current + 1;
      navigationTokenRef.current = token;
      const cover = options.cover ?? intent !== 'initial';
      const task = navigationTailRef.current.catch(() => undefined).then(async () => {
        if (canceled || readerDestroyed) return;
        const startedAt = performance.now();
        if (cover) setNavigating(true);
        const direction = options.direction;
        const shouldAnimate = direction !== undefined
          && ebookPageTurnAnimationRef.current === 'kindle'
          && !prefersReducedMotion();
        try {
          if (shouldAnimate) await runKindlePageTurn(container, direction, action);
          else await waitForNavigationAction(action, options.timeoutMs);
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

    const handleReaderPointerIntent = (clientX: number, clientY: number, readingDirection: ReadingDirection, runNext: () => Promise<void>, runPrev: () => Promise<void>) => {
      const viewport = readerViewportForContainer(container);
      const intent = readerPointerIntent(clientX, clientY, viewport, readingDirection);
      if (intent === 'center') {
        onTapRef.current();
        return;
      }
      onActivityRef.current();
      if (intent === 'prev') void runPrev();
      else if (intent === 'next') void runNext();
    };

    const setupDocumentEvents = (document: ReaderDocument, locations: EpubLocationStore, ensureLocationsReady: () => Promise<unknown>, readingDirection: ReadingDirection, runNext: () => Promise<void>, runPrev: () => Promise<void>) => {
      if (document.__shukuReaderEventsBound) return;
      document.__shukuReaderEventsBound = true;
      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;
      let suppressClickUntil = 0;

      document.addEventListener('keydown', (event) => {
        if (isInteractiveElement(event.target)) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onActivityRef.current();
          void (physicalSideIntent('left', readingDirection) === 'next' ? runNext() : runPrev());
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onActivityRef.current();
          void (physicalSideIntent('right', readingDirection) === 'next' ? runNext() : runPrev());
          return;
        }
        if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
          event.preventDefault();
          onActivityRef.current();
          void runPrev();
          return;
        }
        if (event.key === 'PageDown' || event.key === ' ') {
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
        handleReaderPointerIntent(event.clientX, event.clientY, readingDirection, runNext, runPrev);
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
          void (horizontalSwipeIntent(deltaX, readingDirection) === 'next' ? runNext() : runPrev());
          return;
        }
        if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
          suppressClickUntil = Date.now() + 450;
          handleReaderPointerIntent(touch.clientX, touch.clientY, readingDirection, runNext, runPrev);
        }
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
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: true
        });
        localRendition = rendition;
        renditionRef.current = rendition;
        applyTheme(rendition, themeRef.current, fontSizeRef.current, lineHeightRef.current, fontFamilyRef.current, pageWidthRef.current);
        const readingDirection: ReadingDirection = isRtlBook(book as EpubBookWithReadiness) ? 'rtl' : 'ltr';
        readingDirectionRef.current = readingDirection;

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
            : fallbackPercentFromLocation(location, sectionIndex, displayedPage, displayedTotal, spineSectionCount(book as EpubBookWithReadiness));
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
            cfi
          });
        };
        emitCurrentLocation = () => {
          const location = currentRenditionLocation(localRendition);
          if (location) emitLocationProgress(location);
          else reportRenditionLocation(localRendition);
        };

        const runNext = async () => {
          await runNavigation('next', rawNext, { direction: 1 });
        };
        const runPrev = async () => {
          await runNavigation('prev', rawPrev, { direction: -1 });
        };
        runNextRef.current = runNext;
        runPrevRef.current = runPrev;

        rendition.on('rendered', (_section: unknown, view: EpubView) => {
          lastRenderedAt = performance.now();
          currentViewRef.current = view;
          allowScriptsForEpubView(view);
          const document = view.document as ReaderDocument | undefined;
          if (!document) return;
          sanitizeEpubDocument(document);
          setupDocumentEvents(document, locations, ensureLocationsReady, readingDirection, runNext, runPrev);
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
              await displayHref(rendition, book as EpubBookWithReadiness, href, () => currentViewRef.current);
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

        void ensureLocationsReady().then(() => {
          if (!canceled && !destroyRequested) emitCurrentLocation?.();
        });
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
      runNextRef.current = async () => undefined;
      runPrevRef.current = async () => undefined;
      window.setTimeout(() => {
        window.removeEventListener('unhandledrejection', suppressStaleCleanupError, { capture: true });
        window.removeEventListener('error', suppressStaleCleanupWindowError, { capture: true });
      }, 30000);
    };
  }, [editionId, volumeId, onControls, retryToken]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    applyTheme(rendition, theme, fontSize, lineHeight, fontFamily, pageWidth);
    const container = containerRef.current;
    resizeRenditionSafely(rendition, container?.clientWidth ?? window.innerWidth, container?.clientHeight ?? window.innerHeight);
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
        resizeRenditionSafely(rendition, container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
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

  const handleHostPointerIntent = (clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const viewport = {
      width: container.clientWidth || rect.width || window.innerWidth,
      height: container.clientHeight || rect.height || window.innerHeight
    };
    const intent = readerPointerIntent(clientX - rect.left, clientY - rect.top, viewport, readingDirectionRef.current);
    if (intent === 'center') {
      onTapRef.current();
      return;
    }
    onActivityRef.current();
    if (intent === 'prev') void runPrevRef.current();
    else if (intent === 'next') void runNextRef.current();
  };

  const handleHostClick = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() < hostSuppressClickUntilRef.current || isInteractiveElement(event.target)) return;
    event.stopPropagation();
    handleHostPointerIntent(event.clientX, event.clientY);
  };

  const handleHostTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (isInteractiveElement(event.target)) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    hostTouchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  };

  const handleHostTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (isInteractiveElement(event.target)) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - hostTouchRef.current.x;
    const deltaY = touch.clientY - hostTouchRef.current.y;
    const elapsed = Date.now() - hostTouchRef.current.time;
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 900) {
      event.stopPropagation();
      hostSuppressClickUntilRef.current = Date.now() + 450;
      onActivityRef.current();
      void (horizontalSwipeIntent(deltaX, readingDirectionRef.current) === 'next' ? runNextRef.current() : runPrevRef.current());
      return;
    }
    if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
      event.stopPropagation();
      hostSuppressClickUntilRef.current = Date.now() + 450;
      handleHostPointerIntent(touch.clientX, touch.clientY);
    }
  };

  return (
    <div className="flex h-full w-full flex-col px-4 py-6 md:px-8 md:py-10" data-allow-text-selection="true" style={{ background: tokens.background }}>
      <div
        className="relative mx-auto min-h-0 w-full flex-1 overflow-hidden"
        style={{ background: tokens.background, maxWidth: constrainedPageWidth }}
      >
        <div
          ref={containerRef}
          className="h-full w-full"
          aria-label={`${title} EPUB 阅读器`}
          onClick={handleHostClick}
          onTouchStart={handleHostTouchStart}
          onTouchEnd={handleHostTouchEnd}
        />
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
