'use client';

import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import { cn } from '../../components/ui/cn';
import type { EbookFlow, ReaderControls, ReaderFontFamily, ReaderProgress, ReaderTheme } from './reader-shell';

type EpubReaderProps = {
  bookId: string;
  title: string;
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  fontFamily: ReaderFontFamily;
  ebookFlow: EbookFlow;
  initialCfi: string;
  initialScrollTop: number;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress, extra?: Record<string, unknown>) => void;
  onActivity: () => void;
  onTap: () => void;
};

type EpubLocationStore = {
  generate: (chars?: number) => Promise<unknown>;
  cfiFromPercentage: (percentage: number) => string;
};

type EpubView = {
  document?: Document;
};

const themeTokens: Record<ReaderTheme, { color: string; background: string; link: string; loadingText: string }> = {
  day: { color: '#1E293B', background: '#F7F7F4', link: '#2563EB', loadingText: 'text-slate-500' },
  warm: { color: '#2B2118', background: '#FDF6EA', link: '#B45309', loadingText: 'text-stone-500' },
  night: { color: '#E2E8F0', background: '#0F172A', link: '#93C5FD', loadingText: 'text-slate-300' },
  black: { color: '#F8FAFC', background: '#000000', link: '#93C5FD', loadingText: 'text-slate-300' }
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

function isCenterClick(event: MouseEvent) {
  const view = event.view;
  const width = view?.innerWidth ?? window.innerWidth;
  const height = view?.innerHeight ?? window.innerHeight;
  return event.clientX >= width * 0.18 && event.clientX <= width * 0.82 && event.clientY >= height * 0.28 && event.clientY <= height * 0.72;
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

export function EbookReader({
  bookId,
  title,
  theme,
  fontSize,
  lineHeight,
  pageWidth,
  fontFamily,
  ebookFlow,
  initialCfi,
  initialScrollTop,
  onControls,
  onProgress,
  onActivity,
  onTap
}: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const currentViewRef = useRef<EpubView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let canceled = false;
    setLoading(true);
    setError('');
    container.replaceChildren();

    const book = ePub();
    bookRef.current = book;

    fetch(`/api/books/${bookId}/file`)
      .then((response) => {
        if (!response.ok) throw new Error('EPUB 文件加载失败');
        return response.arrayBuffer();
      })
      .then((buffer) => book.open(buffer, 'binary'))
      .then(async () => {
        if (canceled) return;
        const rendition = book.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: ebookFlow === 'scrolled' ? 'scrolled-doc' : 'paginated',
          spread: 'none',
          allowScriptedContent: false
        });
        renditionRef.current = rendition;
        applyTheme(rendition, theme, fontSize, lineHeight, fontFamily);

        const locations = book.locations as unknown as EpubLocationStore;
        const locationsReady = locations.generate(1200).catch(() => undefined);

        rendition.on('rendered', (_section: unknown, view: EpubView) => {
          currentViewRef.current = view;
          view.document?.addEventListener('click', (event) => {
            if (isCenterClick(event)) onTap();
          });
          view.document?.addEventListener('scroll', () => {
            if (ebookFlow !== 'scrolled') return;
            onActivity();
            const top = scrollTopFromView(view);
            const scrollElement = view.document?.scrollingElement ?? view.document?.documentElement;
            const max = Math.max(1, (scrollElement?.scrollHeight ?? 1) - (scrollElement?.clientHeight ?? 0));
            onProgress({
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
            onActivity();
            await rendition.next();
          },
          prev: async () => {
            onActivity();
            await rendition.prev();
          },
          jumpToProgress: async (value) => {
            onActivity();
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
            onActivity();
            await rendition.display(Math.max(0, index - 1));
          }
        });

        rendition.on('relocated', (location: Location) => {
          const percent = clampPercent((location.start?.percentage ?? 0) * 100);
          const page = Math.max(1, (location.start?.index ?? 0) + 1);
          const displayed = location.start?.displayed;
          const scrollTop = ebookFlow === 'scrolled' ? scrollTopFromView(currentViewRef.current) : 0;
          onProgress({
            page,
            total: displayed?.total ?? null,
            percent,
            position: location.start?.cfi ?? '',
            label: displayed?.total ? `第 ${displayed.page} / ${displayed.total} 屏` : `第 ${page} 章`
          }, { percentage: percent, chapterIndex: page, scrollTop, cfi: location.start?.cfi ?? '' });
        });

        await rendition.display(initialCfi || undefined);
        if (ebookFlow === 'scrolled' && initialScrollTop > 0) {
          window.setTimeout(() => scrollViewTo(currentViewRef.current, initialScrollTop), 150);
        }
      })
      .then(() => {
        if (!canceled) setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : 'EPUB 加载失败');
      });

    return () => {
      canceled = true;
      onControls(null);
      renditionRef.current?.destroy();
      book.destroy();
      renditionRef.current = null;
      bookRef.current = null;
      currentViewRef.current = null;
    };
  }, [bookId, ebookFlow]);

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
        {loading ? (
          <div
            className={cn('absolute inset-0 flex items-center justify-center text-sm', tokens.loadingText)}
            style={{ background: tokens.background }}
          >
            正在打开 EPUB...
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-red-950/90 p-6 text-center text-sm text-red-100">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { EbookReader as EpubReader };
