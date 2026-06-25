'use client';

import { BookOpen, ChevronLeft, ChevronRight, ListTree, Minus, Moon, Plus, Settings, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import type { ComicDirection, ComicImageFit, ComicImageVariant, ComicMode } from './comic-reader';

export type ReaderKind = 'epub' | 'comic' | 'pdf';
export type ReaderTheme = 'day' | 'warm' | 'night' | 'black';
export type ReaderFontFamily = 'system' | 'serif' | 'sans';
export type EbookPageTurnAnimation = 'kindle' | 'off';

export type ReaderProgress = {
  page: number;
  total: number | null;
  percent: number;
  position: string;
  label: string;
};

export type ReaderControls = {
  next: () => Promise<void>;
  prev: () => Promise<void>;
  jumpToProgress: (value: number) => Promise<void>;
  jumpToHref?: (href: string) => Promise<void>;
  jumpToIndex?: (index: number) => Promise<void>;
};

export type ReaderSettings = {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  fontFamily: ReaderFontFamily;
  ebookPageTurnAnimation: EbookPageTurnAnimation;
  zoom: number;
  comicDirection: ComicDirection;
  comicMode: ComicMode;
  imageFit: ComicImageFit;
  imageVariant: ComicImageVariant;
  reversePages: boolean;
};

export type ReaderShellEvents = {
  enterImmersive: () => void;
  toggleControls: () => void;
  shouldIgnoreInteraction: (target: EventTarget | null) => boolean;
};

type ReaderShellProps = {
  editionId: string;
  title: string;
  readerType: ReaderKind;
  progress: ReaderProgress;
  progressExtra?: Record<string, unknown>;
  controls: ReaderControls | null;
  settings: ReaderSettings;
  onBack: () => void;
  onSettingsChange: (settings: ReaderSettings) => void;
  navigationItems?: ReaderNavigationItem[];
  volumeNavigation?: ReaderVolumeNavigation;
  children: ReactNode | ((events: ReaderShellEvents) => ReactNode);
};

export type ReaderNavigationItem = {
  index: number;
  title: string;
  href?: string;
  sectionIndex?: number;
};

export type ReaderVolumeNavigation = {
  editions: Array<{
    id: string;
    versionName: string;
    format: string;
    progress: number;
    lastReadAt: string | null;
    volumes: Array<{ id: string; title: string; pageCount: number | null }>;
  }>;
  volumeSections: Array<{ id: string; title: string; pageCount: number }>;
  pages: ReaderNavigationItem[];
  currentEditionId: string;
  currentVolumeId: string | null;
  loading: boolean;
  onSelectEdition: (editionId: string) => void;
  onSelectVolume: (volumeId: string) => void;
  onSelectItem: (item: ReaderNavigationItem) => void;
};

type ReadingUnitsPayload = {
  ok: boolean;
  data?: {
    readingUnits: Array<{ title: string; sortOrder: number; href?: string }>;
  };
};

type ComicPagesPayload = {
  ok: boolean;
  data?: {
    pages?: Array<{ pageIndex: number; title?: string }>;
    pageCount: number;
  };
};

type PdfPagesPayload = {
  ok: boolean;
  data?: {
    pageCount?: number;
  };
};

export const readerThemeSurfaces: Record<ReaderTheme, { background: string; textClass: string; statusBarStyle: 'default' | 'black-translucent' }> = {
  day: { background: '#F7F7F4', textClass: 'text-slate-950', statusBarStyle: 'black-translucent' },
  warm: { background: '#FDF6EA', textClass: 'text-slate-950', statusBarStyle: 'black-translucent' },
  night: { background: '#0F172A', textClass: 'text-slate-100', statusBarStyle: 'black-translucent' },
  black: { background: '#000000', textClass: 'text-slate-100', statusBarStyle: 'black-translucent' }
};

const readerBottomAreaHeight = 'calc(6rem + env(safe-area-inset-bottom))';
const readerBottomAreaOffset = 'calc(10px - env(safe-area-inset-bottom))';
const readerBottomControlsMaxWidth = 'max-w-4xl';
const progressJumpDebounceMs = 160;

function ensureMeta(name: string) {
  const existing = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (existing) return { meta: existing, created: false };
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  document.head.appendChild(meta);
  return { meta, created: true };
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function progressPageLabel(progress: ReaderProgress) {
  return progress.total ? `第 ${progress.page} 页 / 共 ${progress.total} 页` : `第 ${progress.page} 页`;
}

function normalizeReaderHref(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value).split('#')[0].replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  } catch {
    return value.split('#')[0].replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
  }
}

function numberFromExtra(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isActiveNavigationItem(readerType: ReaderKind, item: ReaderNavigationItem, progress: ReaderProgress, progressExtra: Record<string, unknown>) {
  if (readerType === 'comic') return item.index === progress.page;
  if (readerType === 'pdf') return item.index === progress.page;
  const currentHref = normalizeReaderHref(progressExtra.currentHref);
  if (item.href && currentHref && normalizeReaderHref(item.href) === currentHref) return true;
  if (currentHref) return false;
  const chapterHref = normalizeReaderHref(progressExtra.chapterHref);
  if (item.href && chapterHref && normalizeReaderHref(item.href) === chapterHref) return true;
  if (chapterHref) return false;
  const sectionIndex = numberFromExtra(progressExtra.sectionIndex ?? progressExtra.chapterIndex);
  if (sectionIndex !== null) return item.sectionIndex === sectionIndex || item.index === sectionIndex + 1;
  return false;
}

function navigationItemKey(item: ReaderNavigationItem) {
  return `${item.index}:${item.href ?? ''}:${item.title}`;
}

function activeNavigationItem(readerType: ReaderKind, items: ReaderNavigationItem[], progress: ReaderProgress, progressExtra: Record<string, unknown>, selectedKey: string | null) {
  const selectedItem = selectedKey ? items.find((item) => navigationItemKey(item) === selectedKey) : null;
  if (selectedItem && isActiveNavigationItem(readerType, selectedItem, progress, progressExtra)) return selectedItem;
  return items.find((item) => isActiveNavigationItem(readerType, item, progress, progressExtra)) ?? null;
}

function isDarkTheme(theme: ReaderTheme) {
  return theme === 'night' || theme === 'black';
}

function stopControlEvent(event: MouseEvent) {
  event.stopPropagation();
}

function isCenterPointer(clientX: number, clientY: number) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return clientX >= width * 0.18 && clientX <= width * 0.82 && clientY >= height * 0.28 && clientY <= height * 0.72;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button';
}

function shouldIgnoreReaderInteraction(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return isEditableTarget(target) || Boolean(target.closest('[data-reader-control="true"]'));
}

function useReaderPwaSurface(theme: ReaderTheme) {
  useEffect(() => {
    const themeSurface = readerThemeSurfaces[theme];
    const previousHtmlBackground = document.documentElement.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousColorScheme = document.documentElement.style.colorScheme;
    const foundThemeColorMetas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const createdThemeColor = foundThemeColorMetas.length === 0 ? ensureMeta('theme-color') : null;
    const themeColorMetas = createdThemeColor ? [createdThemeColor.meta] : foundThemeColorMetas;
    const { meta: statusBarMeta, created: createdStatusBarMeta } = ensureMeta('apple-mobile-web-app-status-bar-style');
    const previousThemeColors = themeColorMetas.map((meta) => meta.content);
    const previousStatusBarStyle = statusBarMeta.content;

    function applySurface() {
      document.documentElement.style.backgroundColor = themeSurface.background;
      document.body.style.backgroundColor = themeSurface.background;
      document.documentElement.style.colorScheme = themeSurface.statusBarStyle === 'black-translucent' ? 'dark' : 'light';
      const currentThemeColorMetas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
      const targetThemeColorMetas = currentThemeColorMetas.length > 0 ? currentThemeColorMetas : [ensureMeta('theme-color').meta];
      targetThemeColorMetas.forEach((meta) => {
        if (meta.getAttribute('content') !== themeSurface.background) meta.setAttribute('content', themeSurface.background);
      });
      const currentStatusBarMeta = ensureMeta('apple-mobile-web-app-status-bar-style').meta;
      if (currentStatusBarMeta.getAttribute('content') !== themeSurface.statusBarStyle) {
        currentStatusBarMeta.setAttribute('content', themeSurface.statusBarStyle);
      }
    }

    applySurface();
    const frame = window.requestAnimationFrame(applySurface);
    const settleTimer = window.setTimeout(applySurface, 250);
    const lateSettleTimer = window.setTimeout(applySurface, 1000);
    const syncTimer = window.setInterval(applySurface, 500);
    const headObserver = new MutationObserver(applySurface);
    headObserver.observe(document.head, { attributes: true, childList: true, subtree: true, attributeFilter: ['content'] });

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(lateSettleTimer);
      window.clearInterval(syncTimer);
      headObserver.disconnect();
      document.documentElement.style.backgroundColor = previousHtmlBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      document.documentElement.style.colorScheme = previousColorScheme;
      themeColorMetas.forEach((meta, index) => {
        const previousThemeColor = previousThemeColors[index];
        if (createdThemeColor?.meta === meta) {
          meta.remove();
          return;
        }
        meta.setAttribute('content', previousThemeColor);
      });
      if (createdStatusBarMeta) statusBarMeta.remove();
      else statusBarMeta.setAttribute('content', previousStatusBarStyle);
    };
  }, [theme]);
}

export function ReaderShell({ editionId, title, readerType, progress, progressExtra = {}, controls, settings, onBack, onSettingsChange, navigationItems, volumeNavigation, children }: ReaderShellProps) {
  const controlsVisibleRef = useRef(false);
  const controlsRef = useRef<ReaderControls | null>(null);
  const panelRef = useRef<'toc' | 'settings' | null>(null);
  const touchRef = useRef({ x: 0, y: 0, time: 0 });
  const suppressClickUntilRef = useRef(0);
  const backRequestAtRef = useRef(0);
  const progressJumpTimerRef = useRef<number | null>(null);
  const pendingProgressJumpRef = useRef<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [panel, setPanel] = useState<'toc' | 'settings' | null>(null);
  const [navItems, setNavItems] = useState<ReaderNavigationItem[]>(navigationItems ?? []);
  const [navLoading, setNavLoading] = useState(false);
  const [selectedNavigationKey, setSelectedNavigationKey] = useState<string | null>(null);
  const [progressScrubPercent, setProgressScrubPercent] = useState<number | null>(null);
  const dark = isDarkTheme(settings.theme);
  const themeSurface = readerThemeSurfaces[settings.theme];
  const currentNavigationItem = activeNavigationItem(readerType, navItems, progress, progressExtra, selectedNavigationKey);
  const currentNavigationTitle = currentNavigationItem?.title ?? null;
  const progressDetail = currentNavigationTitle ? `${currentNavigationTitle} · ${progress.label}` : progress.label;
  useReaderPwaSurface(settings.theme);

  function setControlsVisibility(visible: boolean) {
    controlsVisibleRef.current = visible;
    setControlsVisible(visible);
  }

  function keepControlsOpen() {
    setControlsVisibility(true);
  }

  function enterImmersive() {
    setControlsVisibility(false);
    setPanel(null);
  }

  function toggleControls() {
    if (controlsVisibleRef.current) enterImmersive();
    else keepControlsOpen();
  }

  function closePanelOrImmersive() {
    if (panelRef.current) {
      setPanel(null);
      return;
    }
    enterImmersive();
  }

  function requestBackFromControl(event: SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - backRequestAtRef.current < 700) return;
    backRequestAtRef.current = now;
    onBack();
  }

  async function goNext() {
    await controlsRef.current?.next();
  }

  async function goPrev() {
    await controlsRef.current?.prev();
  }

  async function jumpToStart() {
    await controlsRef.current?.jumpToProgress(0);
  }

  async function jumpToEnd() {
    await controlsRef.current?.jumpToProgress(100);
  }

  function clearPendingProgressJump() {
    if (progressJumpTimerRef.current !== null) {
      window.clearTimeout(progressJumpTimerRef.current);
      progressJumpTimerRef.current = null;
    }
    pendingProgressJumpRef.current = null;
  }

  function flushPendingProgressJump() {
    const value = pendingProgressJumpRef.current;
    clearPendingProgressJump();
    if (value === null) return;
    void controlsRef.current?.jumpToProgress(value);
  }

  function handleReaderTap(clientX: number, clientY: number) {
    if (isCenterPointer(clientX, clientY)) {
      toggleControls();
      return;
    }
    const width = window.innerWidth;
    if (clientX < width * 0.33) void goPrev();
    else if (clientX > width * 0.67) void goNext();
  }

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
  }, [controlsVisible]);

  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  useEffect(() => {
    return () => clearPendingProgressJump();
  }, []);

  useEffect(() => {
    if (progressScrubPercent === null) return;
    if (Math.abs(clampPercent(progress.percent) - progressScrubPercent) <= 1) {
      setProgressScrubPercent(null);
    }
  }, [progress.percent, progressScrubPercent]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreReaderInteraction(event.target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanelOrImmersive();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
        event.preventDefault();
        void goPrev();
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        void goNext();
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        void jumpToStart();
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        void jumpToEnd();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!panel) return;
    setControlsVisibility(true);
  }, [panel]);

  useEffect(() => {
    setNavItems(navigationItems ?? []);
  }, [editionId, navigationItems, readerType, settings.reversePages]);

  useEffect(() => {
    if (!selectedNavigationKey) return;
    const selectedItem = navItems.find((item) => navigationItemKey(item) === selectedNavigationKey);
    if (!selectedItem || !isActiveNavigationItem(readerType, selectedItem, progress, progressExtra)) {
      setSelectedNavigationKey(null);
    }
  }, [navItems, progress, progressExtra, readerType, selectedNavigationKey]);

  useEffect(() => {
    if (navigationItems || panel !== 'toc' || navItems.length > 0) return;
    let active = true;
    setNavLoading(true);
    const endpoint = `/api/reader/${editionId}/bootstrap`;
    fetch(endpoint)
      .then((response) => response.json() as Promise<ReadingUnitsPayload | ComicPagesPayload | PdfPagesPayload>)
      .then((payload) => {
        if (!active || !payload.ok || !payload.data) return;
        if (readerType === 'comic') {
          const data = payload.data as ComicPagesPayload['data'];
          const pages: Array<{ pageIndex: number; title?: string }> = data?.pages?.length ? data.pages : Array.from({ length: data?.pageCount ?? 0 }, (_, index) => ({ pageIndex: index + 1 }));
          const orderedPages = settings.reversePages ? [...pages].reverse() : pages;
          setNavItems(orderedPages.map((page) => ({ index: page.pageIndex, title: page.title || `第 ${page.pageIndex} 页` })));
        } else if (readerType === 'pdf') {
          const data = payload.data as PdfPagesPayload['data'];
          setNavItems(Array.from({ length: data?.pageCount ?? progress.total ?? 0 }, (_, index) => ({ index: index + 1, title: `第 ${index + 1} 页` })));
        } else {
          const data = payload.data as ReadingUnitsPayload['data'];
          setNavItems((data?.readingUnits ?? []).map((unit) => ({ index: unit.sortOrder, sectionIndex: Math.max(0, unit.sortOrder - 1), title: unit.title || `第 ${unit.sortOrder} 章`, href: unit.href })));
        }
      })
      .finally(() => {
        if (active) setNavLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editionId, navigationItems, navItems.length, panel, readerType, settings.reversePages]);

  async function jumpToPercent(value: number, debounce = false) {
    const nextValue = clampPercent(value);
    if (!debounce) {
      clearPendingProgressJump();
      setProgressScrubPercent(null);
      await controlsRef.current?.jumpToProgress(nextValue);
      return;
    }
    pendingProgressJumpRef.current = nextValue;
    setProgressScrubPercent(nextValue);
    if (progressJumpTimerRef.current !== null) {
      window.clearTimeout(progressJumpTimerRef.current);
    }
    progressJumpTimerRef.current = window.setTimeout(flushPendingProgressJump, progressJumpDebounceMs);
  }

  async function jumpToItem(item: ReaderNavigationItem) {
    setSelectedNavigationKey(navigationItemKey(item));
    if (item.href && controls?.jumpToHref) {
      await controls.jumpToHref(item.href);
      return;
    }
    if (controls?.jumpToIndex) {
      await controls.jumpToIndex(item.index);
      return;
    }
    const total = progress.total ?? navItems.length;
    const percent = total > 1 ? ((item.index - 1) / (total - 1)) * 100 : 0;
    await jumpToPercent(percent);
  }

  function updateSettings(next: Partial<ReaderSettings>) {
    onSettingsChange({ ...settings, ...next });
    keepControlsOpen();
  }

  return (
    <div
      className={cn('fixed inset-x-0 top-0 z-50 h-[var(--pwa-screen-height,100svh)] overflow-hidden transition-colors', themeSurface.textClass)}
      style={{
        backgroundColor: themeSurface.background
      }}
    >
      <div
        className="relative flex h-[100svh] min-h-[100dvh] flex-col overflow-hidden"
        style={{
          backgroundColor: themeSurface.background,
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)'
        }}
      onClick={(event) => {
        if (Date.now() < suppressClickUntilRef.current || shouldIgnoreReaderInteraction(event.target)) return;
        handleReaderTap(event.clientX, event.clientY);
      }}
      onTouchStart={(event) => {
        if (shouldIgnoreReaderInteraction(event.target)) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        touchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
      }}
      onTouchEnd={(event) => {
        if (shouldIgnoreReaderInteraction(event.target)) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        const deltaX = touch.clientX - touchRef.current.x;
        const deltaY = touch.clientY - touchRef.current.y;
        const elapsed = Date.now() - touchRef.current.time;
        if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4 && elapsed < 900) {
          suppressClickUntilRef.current = Date.now() + 450;
          if (deltaX < 0) void goNext();
          else void goPrev();
          return;
        }
        if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
          suppressClickUntilRef.current = Date.now() + 450;
          handleReaderTap(touch.clientX, touch.clientY);
        }
      }}
      tabIndex={-1}
    >
      <main className="min-h-0 flex-1 w-full" style={{ paddingBottom: 'calc(6rem + 10px)' }}>
        {typeof children === 'function' ? children({ enterImmersive, toggleControls, shouldIgnoreInteraction: shouldIgnoreReaderInteraction }) : children}
      </main>

      <div
        className={cn(
          'absolute inset-x-0 top-0 z-20 border-b px-3 py-2 backdrop-blur-xl transition duration-200 md:px-5',
          dark ? 'border-white/10 bg-slate-950/80' : 'border-slate-200 bg-white/80'
        )}
        style={{
          paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
          transform: controlsVisible ? 'translateY(0)' : 'translateY(-100%)',
          opacity: controlsVisible ? 1 : 0
        }}
        data-reader-control="true"
        onClick={stopControlEvent}
      >
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={requestBackFromControl}
              onTouchEnd={requestBackFromControl}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-[0.98] hover:bg-white/10"
              aria-label="返回详情页"
            >
              <ChevronLeft size={22} />
            </button>
            <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 md:flex">
              <BookOpen size={18} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold md:text-base">{title}</div>
              <div className="truncate text-xs opacity-60">{readerType === 'comic' ? '漫画阅读' : readerType === 'pdf' ? 'PDF 阅读' : 'EPUB 阅读'} · {progressDetail}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={() => setPanel((value) => (value === 'toc' ? null : 'toc'))} className="flex h-11 w-11 items-center justify-center rounded-full transition active:scale-[0.98] hover:bg-white/10" aria-label="目录">
              <ListTree size={19} />
            </button>
            <button type="button" onClick={() => setPanel((value) => (value === 'settings' ? null : 'settings'))} className="flex h-11 w-11 items-center justify-center rounded-full transition active:scale-[0.98] hover:bg-white/10" aria-label="阅读设置">
              <Settings size={19} />
            </button>
          </div>
        </div>
	      </div>

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 py-3 transition duration-200 md:px-5 md:py-4"
        style={{
          bottom: readerBottomAreaOffset,
          height: readerBottomAreaHeight,
          paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
          paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
          transform: controlsVisible ? 'translateY(100%)' : 'translateY(0)',
          opacity: controlsVisible ? 0 : 1
        }}
        aria-hidden={controlsVisible}
      >
        <div className={cn('mx-auto flex h-full flex-col gap-3', readerBottomControlsMaxWidth)}>
          <div className="flex items-center justify-between gap-3 text-[11px] opacity-60 md:text-xs">
            <span className="truncate">{progressPageLabel(progress)}</span>
            <span className="shrink-0">{clampPercent(progress.percent)}%</span>
          </div>
          <div className="min-h-0 flex-1" aria-hidden="true" />
        </div>
      </div>

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20 border-t px-3 py-3 backdrop-blur-xl transition duration-200 md:px-5 md:py-4',
          dark ? 'border-white/10 bg-slate-950/80' : 'border-slate-200 bg-white/80'
        )}
        style={{
          bottom: readerBottomAreaOffset,
          height: readerBottomAreaHeight,
          paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
          paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
          transform: controlsVisible ? 'translateY(0)' : 'translateY(100%)',
          opacity: controlsVisible ? 1 : 0
        }}
        data-reader-control="true"
        onClick={stopControlEvent}
      >
        <div className={cn('mx-auto flex flex-col gap-3', readerBottomControlsMaxWidth)}>
          <div className="flex items-center gap-2">
            <Button variant="ghost" icon={ChevronLeft} className={cn('min-h-11 shrink-0 px-3', dark ? 'text-slate-100 hover:bg-white/10' : '')} onClick={() => { void controls?.prev(); keepControlsOpen(); }}>
              <span className="hidden sm:inline">上一页</span>
            </Button>
            <input
              aria-label="阅读进度"
              type="range"
              min={0}
              max={100}
              value={progressScrubPercent ?? clampPercent(progress.percent)}
              onChange={(event) => {
                void jumpToPercent(Number(event.target.value), true);
                keepControlsOpen();
              }}
              onBlur={flushPendingProgressJump}
              className="h-11 min-w-0 flex-1 accent-blue-500"
            />
            <Button variant="ghost" icon={ChevronRight} className={cn('min-h-11 shrink-0 px-3', dark ? 'text-slate-100 hover:bg-white/10' : '')} onClick={() => { void controls?.next(); keepControlsOpen(); }}>
              <span className="hidden sm:inline">下一页</span>
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs opacity-70 md:text-sm" aria-hidden="true">
            <span className="truncate">&nbsp;</span>
            <span className="shrink-0">&nbsp;</span>
          </div>
        </div>
      </div>

      {panel ? (
        <aside
          className={cn(
            'absolute inset-x-0 bottom-0 z-30 flex max-h-[82dvh] w-full flex-col overflow-hidden overscroll-contain rounded-t-3xl border-t p-4 shadow-2xl backdrop-blur-xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:max-w-sm md:rounded-none md:border-l md:border-t-0 md:p-5',
            dark ? 'border-white/10 bg-slate-950/95' : 'border-slate-200 bg-white/95'
          )}
          style={{
            bottom: 'calc(-1 * env(safe-area-inset-bottom))',
            paddingTop: 'max(1rem, env(safe-area-inset-top))',
            paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            paddingLeft: 'max(1rem, env(safe-area-inset-left))',
            paddingRight: 'max(1rem, env(safe-area-inset-right))'
          }}
          data-reader-control="true"
          onClick={stopControlEvent}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{panel === 'toc' ? '目录' : '阅读设置'}</div>
              <div className="mt-0.5 text-xs opacity-60">{progressDetail}</div>
            </div>
            <button type="button" onClick={() => { setPanel(null); keepControlsOpen(); }} className="flex h-11 w-11 items-center justify-center rounded-full transition active:scale-[0.98] hover:bg-white/10" aria-label="关闭面板">
              <X size={18} />
            </button>
          </div>

          {panel === 'toc' && volumeNavigation ? (
            <VolumeNavigationPanel
              navigation={volumeNavigation}
              readerType={readerType}
              progress={progress}
              progressExtra={progressExtra}
              activeItemKey={currentNavigationItem ? navigationItemKey(currentNavigationItem) : null}
              dark={dark}
              onJumpItem={(item) => {
                setSelectedNavigationKey(navigationItemKey(item));
                volumeNavigation.onSelectItem(item);
                keepControlsOpen();
              }}
            />
          ) : null}

          {panel === 'toc' && !volumeNavigation ? (
            <div data-pwa-scroll="true" className="mt-5 min-h-0 flex-1 overflow-auto overscroll-contain pr-1">
              {navLoading ? <div className="py-6 text-sm opacity-60">正在读取...</div> : null}
              {!navLoading && navItems.length === 0 ? <div className="py-6 text-sm opacity-60">暂无可跳转条目</div> : null}
              <div className="space-y-1">
                {navItems.map((item) => (
                  <button
                    key={`${item.index}-${item.title}`}
                    type="button"
                    onClick={() => { void jumpToItem(item); }}
                    className={cn('flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition active:scale-[0.99]', currentNavigationItem && navigationItemKey(item) === navigationItemKey(currentNavigationItem) ? 'bg-blue-500 text-white' : 'hover:bg-white/10')}
                  >
                    <span className="w-9 shrink-0 tabular-nums opacity-60">{item.index}</span>
                    <span className="line-clamp-2">{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {panel === 'settings' ? (
            <div data-pwa-scroll="true" className="mt-5 min-h-0 flex-1 space-y-5 overflow-auto overscroll-contain pr-1 text-sm">
              {readerType === 'epub' ? (
                <>
                  <SegmentedSetting
                    label="主题"
                    value={settings.theme}
                    options={[
                      { value: 'day', label: '白天' },
                      { value: 'warm', label: '暖色' },
                      { value: 'night', label: '夜间' },
                      { value: 'black', label: '纯黑' }
                    ]}
                    onChange={(value) => updateSettings({ theme: value as ReaderTheme })}
                  />
                  <SettingStepper label="字号" value={`${settings.fontSize}px`} onMinus={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })} onPlus={() => updateSettings({ fontSize: Math.min(30, settings.fontSize + 1) })} />
                  <SettingStepper label="行距" value={settings.lineHeight.toFixed(1)} onMinus={() => updateSettings({ lineHeight: Math.max(1.4, Number((settings.lineHeight - 0.1).toFixed(1))) })} onPlus={() => updateSettings({ lineHeight: Math.min(2.4, Number((settings.lineHeight + 0.1).toFixed(1))) })} />
                  <SegmentedSetting
                    label="字体"
                    value={settings.fontFamily}
                    options={[{ value: 'system', label: '默认' }, { value: 'serif', label: '衬线' }, { value: 'sans', label: '无衬线' }]}
                    onChange={(value) => updateSettings({ fontFamily: value as ReaderFontFamily })}
                  />
                  <SegmentedSetting
                    label="页宽"
                    value={String(settings.pageWidth)}
                    options={[760, 960, 1180].map((value) => ({ value: String(value), label: `${value}px` }))}
                    onChange={(value) => updateSettings({ pageWidth: Number(value) })}
                  />
                  <SegmentedSetting
                    label="翻页动画"
                    value={settings.ebookPageTurnAnimation}
                    options={[{ value: 'kindle', label: 'Kindle' }, { value: 'off', label: '关闭' }]}
                    onChange={(value) => updateSettings({ ebookPageTurnAnimation: value as EbookPageTurnAnimation })}
                  />
                </>
              ) : readerType === 'comic' ? (
                <>
                  <button type="button" onClick={() => updateSettings({ theme: settings.theme === 'black' ? 'night' : 'black' })} className="flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-3 transition active:scale-[0.98] hover:bg-white/15">
                    {settings.theme === 'black' ? <Sun size={16} /> : <Moon size={16} />}
                    {settings.theme === 'black' ? '夜间' : '纯黑'}
                  </button>
                  <SegmentedSetting
                    label="模式"
                    value={settings.comicMode}
                    options={[{ value: 'single', label: '单页' }, { value: 'double', label: '双页' }]}
                    onChange={(value) => updateSettings({ comicMode: value as ComicMode })}
                  />
                  <SegmentedSetting
                    label="适配"
                    value={settings.imageFit}
                    options={[
                      { value: 'width', label: '宽度' },
                      { value: 'height', label: '高度' },
                      { value: 'contain', label: '完整' },
                      { value: 'original', label: '原始' }
                    ]}
                    onChange={(value) => updateSettings({ imageFit: value as ComicImageFit })}
                  />
                  <SegmentedSetting
                    label="画质"
                    value={settings.imageVariant}
                    options={[{ value: 'original', label: '原图' }, { value: 'data-saver', label: '省流' }]}
                    onChange={(value) => updateSettings({ imageVariant: value as ComicImageVariant })}
                  />
                  <SegmentedSetting
                    label="方向"
                    value={settings.comicDirection}
                    options={[{ value: 'ltr', label: '左至右' }, { value: 'rtl', label: '右至左' }]}
                    onChange={(value) => updateSettings({ comicDirection: value as ComicDirection })}
                  />
                  <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-white/10 px-3 py-2.5">
                    <span>倒序页码</span>
                    <input type="checkbox" checked={settings.reversePages} onChange={(event) => updateSettings({ reversePages: event.target.checked })} className="h-5 w-5 accent-blue-500" />
                  </label>
                </>
              ) : (
                <>
                  <SegmentedSetting
                    label="主题"
                    value={settings.theme}
                    options={[
                      { value: 'day', label: '白天' },
                      { value: 'warm', label: '暖色' },
                      { value: 'night', label: '夜间' },
                      { value: 'black', label: '纯黑' }
                    ]}
                    onChange={(value) => updateSettings({ theme: value as ReaderTheme })}
                  />
                  <SettingStepper label="缩放" value={`${Math.round(settings.zoom * 100)}%`} onMinus={() => updateSettings({ zoom: Math.max(0.6, Number((settings.zoom - 0.1).toFixed(1))) })} onPlus={() => updateSettings({ zoom: Math.min(2.4, Number((settings.zoom + 0.1).toFixed(1))) })} />
                </>
              )}
            </div>
          ) : null}
        </aside>
      ) : null}
      </div>
    </div>
  );
}

function SettingStepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onMinus} className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 transition active:scale-[0.98] hover:bg-white/15" aria-label={`${label}减少`}>
          <Minus size={15} />
        </button>
        <span className="w-14 text-center tabular-nums">{value}</span>
        <button type="button" onClick={onPlus} className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 transition active:scale-[0.98] hover:bg-white/15" aria-label={`${label}增加`}>
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

function VolumeNavigationPanel({ navigation, readerType, progress, progressExtra, activeItemKey, dark, onJumpItem }: { navigation: ReaderVolumeNavigation; readerType: ReaderKind; progress: ReaderProgress; progressExtra: Record<string, unknown>; activeItemKey: string | null; dark: boolean; onJumpItem: (item: ReaderNavigationItem) => void }) {
  const currentEdition = navigation.editions.find((edition) => edition.id === navigation.currentEditionId);
  const currentVolume = navigation.volumeSections.find((volume) => volume.id === navigation.currentVolumeId);
  const showEditions = navigation.editions.length > 1;
  const showVolumes = navigation.volumeSections.length > 1;
  const idleText = navigation.loading ? '正在切换...' : null;
  const isComic = readerType === 'comic';

  return (
    <div data-pwa-scroll="true" className="mt-5 min-h-0 flex-1 overflow-auto overscroll-contain pr-1">
      {idleText ? <div className="mb-3 rounded-xl bg-white/10 px-3 py-2 text-xs opacity-70">{idleText}</div> : null}
      {showEditions ? (
        <VolumeNavigationGroup title="版本">
          {navigation.editions.map((edition) => {
            const selected = edition.id === navigation.currentEditionId;
            const detail = [
              edition.format,
              edition.volumes.length > 0 ? `${edition.volumes.length} ${isComic ? '卷/话' : '卷'}` : '',
              edition.progress > 0 ? `${edition.progress}%` : ''
            ].filter(Boolean).join(' · ');
            return (
              <button
                key={edition.id}
                type="button"
                disabled={navigation.loading}
                onClick={() => navigation.onSelectEdition(edition.id)}
                className={comicNavButtonClass(selected, dark)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{edition.versionName}</span>
                  <span className="mt-0.5 block truncate text-xs opacity-65">{detail || '默认版本'}</span>
                </span>
              </button>
            );
          })}
        </VolumeNavigationGroup>
      ) : currentEdition ? (
        <div className={cn('mb-4 rounded-xl px-3 py-2 text-sm', dark ? 'bg-white/10' : 'bg-slate-100')}>
          <div className="truncate font-medium">{currentEdition.versionName}</div>
          <div className="mt-0.5 truncate text-xs opacity-60">{currentEdition.format}</div>
        </div>
      ) : null}

      {showVolumes ? (
        <VolumeNavigationGroup title={isComic ? '卷/话' : '卷册'}>
          {navigation.volumeSections.map((volume, index) => (
            <button
              key={volume.id}
              type="button"
              disabled={navigation.loading}
              onClick={() => navigation.onSelectVolume(volume.id)}
              className={comicNavButtonClass(volume.id === navigation.currentVolumeId, dark)}
            >
              <span className="w-8 shrink-0 tabular-nums opacity-60">{index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{volume.title || `第 ${index + 1} ${isComic ? '话' : '卷'}`}</span>
                <span className="mt-0.5 block truncate text-xs opacity-65">{volume.pageCount || 0} {isComic ? '页' : '章'}</span>
              </span>
            </button>
          ))}
        </VolumeNavigationGroup>
      ) : currentVolume ? (
        <div className={cn('mb-4 rounded-xl px-3 py-2 text-sm', dark ? 'bg-white/10' : 'bg-slate-100')}>
          <div className="truncate font-medium">{currentVolume.title}</div>
          <div className="mt-0.5 truncate text-xs opacity-60">{currentVolume.pageCount || progress.total || 0} {isComic ? '页' : '章'}</div>
        </div>
      ) : null}

      <VolumeNavigationGroup title={isComic ? '当前卷页码' : '当前卷章节'}>
        {navigation.pages.length === 0 ? <div className="py-6 text-sm opacity-60">{isComic ? '暂无可跳转页码' : '暂无可跳转章节'}</div> : null}
        <div className={isComic ? 'grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-3' : 'space-y-1'}>
          {navigation.pages.map((item) => (
            <button
              key={`${item.index}-${item.title}`}
              type="button"
              disabled={navigation.loading}
              onClick={() => onJumpItem(item)}
              className={cn(
                isComic ? 'min-h-11 rounded-xl px-2 text-sm tabular-nums transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60' : 'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-60',
                (activeItemKey ? navigationItemKey(item) === activeItemKey : isActiveNavigationItem(readerType, item, progress, progressExtra)) ? 'bg-blue-500 text-white' : dark ? 'bg-white/10 hover:bg-white/15' : 'bg-slate-100 hover:bg-slate-200'
              )}
            >
              {isComic ? item.index : (
                <>
                  <span className="w-9 shrink-0 tabular-nums opacity-60">{item.index}</span>
                  <span className="line-clamp-2">{item.title}</span>
                </>
              )}
            </button>
          ))}
        </div>
      </VolumeNavigationGroup>
    </div>
  );
}

function VolumeNavigationGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 text-xs font-semibold uppercase opacity-50">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function comicNavButtonClass(selected: boolean, dark: boolean) {
  return cn(
    'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-60',
    selected ? 'bg-blue-500 text-white' : dark ? 'hover:bg-white/10' : 'hover:bg-slate-100'
  );
}

function SegmentedSetting({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <div>{label}</div>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn('min-h-11 rounded-xl px-2 text-sm transition active:scale-[0.98]', value === option.value ? 'bg-blue-500 text-white' : 'bg-white/10 hover:bg-white/15')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
