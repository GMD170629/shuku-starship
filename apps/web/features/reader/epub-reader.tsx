'use client';

import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Location, type Rendition } from 'epubjs';
import { cn } from '../../components/ui/cn';
import type { ReaderControls, ReaderProgress } from './reader-shell';

type EpubReaderProps = {
  bookId: string;
  title: string;
  dark: boolean;
  fontSize: number;
  lineHeight: number;
  pageWidth: number;
  initialCfi: string;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress) => void;
  onActivity: () => void;
  onTap: () => void;
};

type EpubLocationStore = {
  generate: (chars?: number) => Promise<unknown>;
  cfiFromPercentage: (percentage: number) => string;
};

function applyTheme(rendition: Rendition, dark: boolean, fontSize: number, lineHeight: number) {
  rendition.themes.default({
    body: {
      color: `${dark ? '#E2E8F0' : '#1E293B'} !important`,
      background: `${dark ? '#0F172A' : '#FDF9F0'} !important`,
      'font-family': 'ui-serif, Georgia, Cambria, "Times New Roman", serif !important',
      'font-size': `${fontSize}px !important`,
      'line-height': `${lineHeight} !important`
    },
    p: {
      'line-height': `${lineHeight} !important`
    },
    a: {
      color: `${dark ? '#93C5FD' : '#2563EB'} !important`
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

type EpubView = {
  document?: Document;
};

export function EbookReader({ bookId, title, dark, fontSize, lineHeight, pageWidth, initialCfi, onControls, onProgress, onActivity, onTap }: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
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
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: false
        });
        renditionRef.current = rendition;
        applyTheme(rendition, dark, fontSize, lineHeight);

        const locations = book.locations as unknown as EpubLocationStore;
        const locationsReady = locations.generate(1200).catch(() => undefined);

        rendition.on('rendered', (_section: unknown, view: EpubView) => {
          view.document?.addEventListener('click', (event) => {
            if (isCenterClick(event)) onTap();
          });
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
            await locationsReady;
            const cfi = locations.cfiFromPercentage(Math.max(0, Math.min(1, value / 100)));
            if (cfi) await rendition.display(cfi);
          }
        });

        rendition.on('relocated', (location: Location) => {
          const percent = clampPercent((location.start?.percentage ?? 0) * 100);
          const page = Math.max(1, (location.start?.index ?? 0) + 1);
          const displayed = location.start?.displayed;
          onProgress({
            page,
            total: displayed?.total ?? null,
            percent,
            position: location.start?.cfi ?? '',
            label: displayed?.total ? `第 ${displayed.page} / ${displayed.total} 屏` : `第 ${page} 章`
          });
        });

        await rendition.display(initialCfi || undefined);
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
    };
  }, [bookId]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    applyTheme(rendition, dark, fontSize, lineHeight);
  }, [dark, fontSize, lineHeight]);

  return (
    <div className="flex h-full w-full justify-center px-3 py-4 md:px-8 md:py-8">
      <div
        className="relative h-full min-h-0 w-full overflow-hidden bg-white shadow-2xl md:rounded-[24px] md:border md:border-white/10"
        style={{ maxWidth: `${pageWidth}px` }}
      >
        <div ref={containerRef} className="h-full w-full" aria-label={`${title} EPUB 阅读器`} />
        {loading ? (
          <div className={cn('absolute inset-0 flex items-center justify-center text-sm', dark ? 'bg-slate-900 text-slate-300' : 'bg-[#FDF9F0] text-slate-500')}>
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
