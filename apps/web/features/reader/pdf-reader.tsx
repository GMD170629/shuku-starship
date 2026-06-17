'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReaderControls, ReaderProgress, ReaderTheme } from './reader-shell';

type PdfReaderProps = {
  editionId: string;
  title: string;
  totalPages: number | null;
  initialPage: number;
  zoom: number;
  theme: ReaderTheme;
  onControls: (controls: ReaderControls | null) => void;
  onProgress: (progress: ReaderProgress, extra?: Record<string, unknown>) => void;
  onReady: () => void;
  onError: (message: string) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function pageProgress(page: number, total: number): ReaderProgress {
  const safeTotal = Math.max(1, total);
  const safePage = clamp(page, 1, safeTotal);
  return {
    page: safePage,
    total: safeTotal,
    percent: safeTotal > 1 ? Math.round(((safePage - 1) / (safeTotal - 1)) * 100) : 0,
    position: String(safePage),
    label: `第 ${safePage} / ${safeTotal} 页`
  };
}

export function PdfReader({ editionId, title, totalPages, initialPage, zoom, theme, onControls, onProgress, onReady, onError }: PdfReaderProps) {
  const total = Math.max(1, totalPages ?? 1);
  const [page, setPage] = useState(() => clamp(initialPage || 1, 1, total));
  const [failed, setFailed] = useState(false);
  const fileUrl = `/api/editions/${editionId}/file`;
  const src = useMemo(() => {
    const zoomPercent = clamp(Math.round((zoom || 1) * 100), 50, 240);
    return `${fileUrl}#page=${page}&zoom=${zoomPercent}&toolbar=0&navpanes=0&view=FitH`;
  }, [fileUrl, page, zoom]);
  const dark = theme === 'night' || theme === 'black';

  useEffect(() => {
    setPage(clamp(initialPage || 1, 1, total));
  }, [editionId, initialPage, total]);

  useEffect(() => {
    const controls: ReaderControls = {
      next: async () => setPage((current) => clamp(current + 1, 1, total)),
      prev: async () => setPage((current) => clamp(current - 1, 1, total)),
      jumpToProgress: async (value) => {
        const nextPage = total > 1 ? Math.round((clamp(value, 0, 100) / 100) * (total - 1)) + 1 : 1;
        setPage(clamp(nextPage, 1, total));
      },
      jumpToIndex: async (index) => setPage(clamp(index, 1, total))
    };
    onControls(controls);
    return () => onControls(null);
  }, [onControls, total]);

  useEffect(() => {
    const nextProgress = pageProgress(page, total);
    onProgress(nextProgress, { pageIndex: page, totalPages: total, zoom, readerType: 'pdf' });
  }, [onProgress, page, total, zoom]);

  if (failed) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
        <div className="max-w-sm rounded-2xl bg-white/10 p-5 text-sm">
          <div className="font-medium">PDF 加载失败</div>
          <div className="mt-2 opacity-70">请确认文件仍在监控目录中，或返回设置检查来源路径。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <iframe
        key={`${editionId}:${page}:${Math.round((zoom || 1) * 100)}`}
        title={title}
        src={src}
        className="h-full w-full border-0"
        style={{ backgroundColor: dark ? '#111827' : '#F8FAFC' }}
        onLoad={onReady}
        onError={() => {
          setFailed(true);
          onError('PDF 文件加载失败');
        }}
      />
      <div className="pointer-events-none absolute inset-x-4 top-4 rounded-full bg-black/35 px-3 py-1.5 text-center text-xs text-white opacity-70 md:left-1/2 md:right-auto md:-translate-x-1/2">
        {pageProgress(page, total).label}
      </div>
    </div>
  );
}
