'use client';

import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Rendition, type Location } from 'epubjs';
import { cn } from '../../components/ui/cn';

export type EpubControls = {
  next: () => Promise<void>;
  prev: () => Promise<void>;
};

type EpubReaderProps = {
  bookId: string;
  title: string;
  dark: boolean;
  fontSize: number;
  lineHeight: number;
  initialCfi: string;
  onControls: (controls: EpubControls | null) => void;
  onProgress: (progress: { cfi: string; page: number; percent: number; label: string }) => void;
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

export function EpubReader({ bookId, title, dark, fontSize, lineHeight, initialCfi, onControls, onProgress }: EpubReaderProps) {
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
      .then(() => {
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
        onControls({
          next: () => rendition.next(),
          prev: () => rendition.prev()
        });
        rendition.on('relocated', (location: Location) => {
          const percent = Math.max(0, Math.min(100, Math.round((location.start?.percentage ?? 0) * 100)));
          const page = Math.max(1, (location.start?.index ?? 0) + 1);
          const displayed = location.start?.displayed;
          onProgress({
            cfi: location.start?.cfi ?? '',
            page,
            percent,
            label: displayed?.total ? `第 ${displayed.page} / ${displayed.total} 屏` : `第 ${page} 章`
          });
        });
        return rendition.display(initialCfi || undefined);
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
    <div className="relative h-[calc(100vh-12rem)] w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-white shadow-2xl">
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
  );
}
