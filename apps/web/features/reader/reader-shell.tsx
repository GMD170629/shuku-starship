'use client';

import { BookOpen, ChevronLeft, ChevronRight, ListTree, Minus, Moon, Plus, Settings, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import type { ComicDirection, ComicImageFit, ComicMode } from './comic-reader';

export type ReaderKind = 'epub' | 'comic';
export type ReaderTheme = 'day' | 'warm' | 'night' | 'black';
export type ReaderFontFamily = 'system' | 'serif' | 'sans';
export type EbookFlow = 'paginated' | 'scrolled';

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
  jumpToIndex?: (index: number) => Promise<void>;
};

export type ReaderSettings = {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  fontFamily: ReaderFontFamily;
  ebookFlow: EbookFlow;
  zoom: number;
  comicDirection: ComicDirection;
  comicMode: ComicMode;
  imageFit: ComicImageFit;
  reversePages: boolean;
};

export type ReaderShellEvents = {
  enterImmersive: () => void;
  toggleControls: () => void;
};

type ReaderShellProps = {
  bookId: string;
  title: string;
  readerType: ReaderKind;
  progress: ReaderProgress;
  controls: ReaderControls | null;
  settings: ReaderSettings;
  onBack: () => void;
  onSettingsChange: (settings: ReaderSettings) => void;
  children: ReactNode | ((events: ReaderShellEvents) => ReactNode);
};

type NavigationItem = {
  index: number;
  title: string;
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

const themeClasses: Record<ReaderTheme, string> = {
  day: 'bg-[#F7F7F4] text-slate-950',
  warm: 'bg-[#F5F1E8] text-slate-950',
  night: 'bg-[#0F172A] text-slate-100',
  black: 'bg-black text-slate-100'
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
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

export function ReaderShell({ bookId, title, readerType, progress, controls, settings, onBack, onSettingsChange, children }: ReaderShellProps) {
  const hideTimerRef = useRef<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [panel, setPanel] = useState<'toc' | 'settings' | null>(null);
  const [navItems, setNavItems] = useState<NavigationItem[]>([]);
  const [navLoading, setNavLoading] = useState(false);
  const dark = isDarkTheme(settings.theme);

  function clearHideTimer() {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setPanel(null);
    }, 3000);
  }

  function showTemporarily() {
    setControlsVisible(true);
    scheduleHide();
  }

  function keepVisibleIfShown() {
    if (controlsVisible) scheduleHide();
  }

  function enterImmersive() {
    clearHideTimer();
    setControlsVisible(false);
    setPanel(null);
  }

  function toggleControls() {
    if (controlsVisible) enterImmersive();
    else showTemporarily();
  }

  useEffect(() => {
    scheduleHide();
    return clearHideTimer;
  }, []);

  useEffect(() => {
    if (!panel) return;
    setControlsVisible(true);
    clearHideTimer();
  }, [panel]);

  useEffect(() => {
    setNavItems([]);
  }, [bookId, readerType, settings.reversePages]);

  useEffect(() => {
    if (panel !== 'toc' || navItems.length > 0) return;
    let active = true;
    setNavLoading(true);
    const endpoint = readerType === 'comic' ? `/api/books/${bookId}/pages` : `/api/books/${bookId}/reading-units`;
    fetch(endpoint)
      .then((response) => response.json() as Promise<ReadingUnitsPayload | ComicPagesPayload>)
      .then((payload) => {
        if (!active || !payload.ok || !payload.data) return;
        if (readerType === 'comic') {
          const data = payload.data as ComicPagesPayload['data'];
          const pages: Array<{ pageIndex: number; title?: string }> = data?.pages?.length ? data.pages : Array.from({ length: data?.pageCount ?? 0 }, (_, index) => ({ pageIndex: index + 1 }));
          const orderedPages = settings.reversePages ? [...pages].reverse() : pages;
          setNavItems(orderedPages.map((page) => ({ index: page.pageIndex, title: page.title || `第 ${page.pageIndex} 页` })));
        } else {
          const data = payload.data as ReadingUnitsPayload['data'];
          setNavItems((data?.readingUnits ?? []).map((unit) => ({ index: unit.sortOrder, title: unit.title || `第 ${unit.sortOrder} 章` })));
        }
      })
      .finally(() => {
        if (active) setNavLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookId, navItems.length, panel, readerType, settings.reversePages]);

  async function jumpToPercent(value: number) {
    await controls?.jumpToProgress(clampPercent(value));
    enterImmersive();
  }

  async function jumpToItem(item: NavigationItem) {
    if (controls?.jumpToIndex) {
      await controls.jumpToIndex(item.index);
      enterImmersive();
      return;
    }
    const total = progress.total ?? navItems.length;
    const percent = total > 1 ? ((item.index - 1) / (total - 1)) * 100 : 0;
    await jumpToPercent(percent);
  }

  function updateSettings(next: Partial<ReaderSettings>) {
    onSettingsChange({ ...settings, ...next });
    showTemporarily();
  }

  return (
    <div
      className={cn('fixed inset-0 z-50 h-[100dvh] overflow-hidden transition-colors', themeClasses[settings.theme])}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)'
      }}
      onClick={(event) => {
        if (isCenterPointer(event.clientX, event.clientY)) toggleControls();
      }}
      onMouseMove={keepVisibleIfShown}
      onTouchStart={keepVisibleIfShown}
      onWheel={enterImmersive}
    >
      <main className="h-full w-full" onScroll={enterImmersive}>
        {typeof children === 'function' ? children({ enterImmersive, toggleControls }) : children}
      </main>

      <div
        className={cn(
          'absolute inset-x-0 top-0 z-20 border-b px-3 py-2 backdrop-blur-xl transition duration-200 md:px-5',
          dark ? 'border-white/10 bg-slate-950/82' : 'border-slate-200 bg-white/82',
          controlsVisible ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'
        )}
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
        onClick={stopControlEvent}
      >
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onBack} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:bg-white/10" aria-label="返回详情页">
              <ChevronLeft size={22} />
            </button>
            <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 md:flex">
              <BookOpen size={18} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold md:text-base">{title}</div>
              <div className="truncate text-xs opacity-60">{readerType === 'comic' ? '漫画阅读' : 'EPUB 阅读'} · {progress.label}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={() => setPanel((value) => (value === 'toc' ? null : 'toc'))} className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10" aria-label={readerType === 'comic' ? '页码' : '目录'}>
              <ListTree size={19} />
            </button>
            <button type="button" onClick={() => setPanel((value) => (value === 'settings' ? null : 'settings'))} className="flex h-10 w-10 items-center justify-center rounded-full transition hover:bg-white/10" aria-label="阅读设置">
              <Settings size={19} />
            </button>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20 border-t px-3 py-3 backdrop-blur-xl transition duration-200 md:px-5 md:py-4',
          dark ? 'border-white/10 bg-slate-950/82' : 'border-slate-200 bg-white/82',
          controlsVisible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'
        )}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        onClick={stopControlEvent}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" icon={ChevronLeft} className={cn('h-10 shrink-0 px-3', dark ? 'text-slate-100 hover:bg-white/10' : '')} onClick={() => { void controls?.prev(); enterImmersive(); }}>
              <span className="hidden sm:inline">上一页</span>
            </Button>
            <input
              aria-label="阅读进度"
              type="range"
              min={0}
              max={100}
              value={clampPercent(progress.percent)}
              onChange={(event) => { void jumpToPercent(Number(event.target.value)); }}
              className="h-8 min-w-0 flex-1 accent-blue-500"
            />
            <Button variant="ghost" icon={ChevronRight} className={cn('h-10 shrink-0 px-3', dark ? 'text-slate-100 hover:bg-white/10' : '')} onClick={() => { void controls?.next(); enterImmersive(); }}>
              <span className="hidden sm:inline">下一页</span>
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs opacity-70 md:text-sm">
            <span className="truncate">{progress.label}</span>
            <span className="shrink-0">{clampPercent(progress.percent)}%</span>
          </div>
        </div>
      </div>

      {panel ? (
        <aside
          className={cn(
            'absolute bottom-0 right-0 top-0 z-30 w-full max-w-sm border-l p-4 shadow-2xl backdrop-blur-xl md:p-5',
            dark ? 'border-white/10 bg-slate-950/94' : 'border-slate-200 bg-white/94'
          )}
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          onClick={stopControlEvent}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{panel === 'toc' ? (readerType === 'comic' ? '页码' : '目录') : '阅读设置'}</div>
              <div className="mt-0.5 text-xs opacity-60">{progress.label}</div>
            </div>
            <button type="button" onClick={() => { setPanel(null); scheduleHide(); }} className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/10" aria-label="关闭面板">
              <X size={18} />
            </button>
          </div>

          {panel === 'toc' ? (
            <div className="mt-5 h-[calc(100%-4rem)] overflow-auto pr-1">
              {navLoading ? <div className="py-6 text-sm opacity-60">正在读取...</div> : null}
              {!navLoading && navItems.length === 0 ? <div className="py-6 text-sm opacity-60">暂无可跳转条目</div> : null}
              <div className="space-y-1">
                {navItems.map((item) => (
                  <button
                    key={`${item.index}-${item.title}`}
                    type="button"
                    onClick={() => { void jumpToItem(item); }}
                    className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition', item.index === progress.page ? 'bg-blue-500 text-white' : 'hover:bg-white/10')}
                  >
                    <span className="w-9 shrink-0 tabular-nums opacity-60">{item.index}</span>
                    <span className="line-clamp-2">{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {panel === 'settings' ? (
            <div className="mt-5 space-y-5 text-sm">
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
                    label="模式"
                    value={settings.ebookFlow}
                    options={[{ value: 'paginated', label: '分页' }, { value: 'scrolled', label: '滚动' }]}
                    onChange={(value) => updateSettings({ ebookFlow: value as EbookFlow })}
                  />
                </>
              ) : (
                <>
                  <button type="button" onClick={() => updateSettings({ theme: settings.theme === 'black' ? 'night' : 'black' })} className="flex h-10 items-center gap-2 rounded-xl bg-white/10 px-3 transition hover:bg-white/15">
                    {settings.theme === 'black' ? <Sun size={16} /> : <Moon size={16} />}
                    {settings.theme === 'black' ? '夜间' : '纯黑'}
                  </button>
                  <SegmentedSetting
                    label="模式"
                    value={settings.comicMode}
                    options={[{ value: 'single', label: '单页' }, { value: 'continuous', label: '连续' }]}
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
                    label="方向"
                    value={settings.comicDirection}
                    options={[{ value: 'ltr', label: '左至右' }, { value: 'rtl', label: '右至左' }]}
                    onChange={(value) => updateSettings({ comicDirection: value as ComicDirection })}
                  />
                  <label className="flex items-center justify-between gap-3 rounded-xl bg-white/10 px-3 py-2.5">
                    <span>倒序页码</span>
                    <input type="checkbox" checked={settings.reversePages} onChange={(event) => updateSettings({ reversePages: event.target.checked })} className="h-5 w-5 accent-blue-500" />
                  </label>
                </>
              )}
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function SettingStepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onMinus} className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 transition hover:bg-white/15" aria-label={`${label}减少`}>
          <Minus size={15} />
        </button>
        <span className="w-14 text-center tabular-nums">{value}</span>
        <button type="button" onClick={onPlus} className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 transition hover:bg-white/15" aria-label={`${label}增加`}>
          <Plus size={15} />
        </button>
      </div>
    </div>
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
            className={cn('h-10 rounded-xl px-2 text-sm transition', value === option.value ? 'bg-blue-500 text-white' : 'bg-white/10 hover:bg-white/15')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
