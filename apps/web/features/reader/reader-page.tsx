'use client';

import { CheckCircle2, ChevronLeft, ChevronRight, Library, Minus, Moon, Plus, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { Progress } from '../../components/ui/progress';
import type { BookView } from '../../lib/books';
import { EpubReader, type EpubControls } from './epub-reader';

type ProgressPayload = {
  id: string;
  readerType: string;
  position: string;
  page?: number | null;
  percent: number;
  extra: string;
};

function archivePageUrl(bookId: string, pageIndex: number) {
  return `/api/books/${bookId}/pages/${pageIndex}`;
}

function isArchiveComicFile(file: BookView['files'][number] | undefined) {
  if (!file) return false;
  const lowerPath = file.path.toLowerCase();
  return lowerPath.endsWith('.cbz') || lowerPath.endsWith('.zip') || file.mimeType === 'application/vnd.comicbook+zip' || file.mimeType === 'application/zip';
}

export function ReaderPage({ bookId }: { bookId: string }) {
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  const [book, setBook] = useState<BookView | null>(null);
  const [error, setError] = useState('');
  const [tools, setTools] = useState(true);
  const [dark, setDark] = useState(true);
  const [fontSize, setFontSize] = useState(18);
  const [lineHeight, setLineHeight] = useState(1.9);
  const [page, setPage] = useState(1);
  const [archivePageCount, setArchivePageCount] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [percent, setPercent] = useState(0);
  const [position, setPosition] = useState('');
  const [epubLabel, setEpubLabel] = useState('正在定位');
  const epubControlsRef = useRef<EpubControls | null>(null);

  const firstFile = book?.files[0];
  const readerType = useMemo(() => {
    if (!book) return 'unknown';
    if (book.formatValue === 'EPUB') return 'epub';
    if (book.formatValue === 'COMIC') return 'comic';
    return 'unknown';
  }, [book]);
  const archiveComic = readerType === 'comic' && book?.files.length === 1 && isArchiveComicFile(firstFile);
  const totalPages = archiveComic ? archivePageCount ?? 0 : book?.files.length ?? 0;

  useEffect(() => {
    async function load() {
      try {
        const bookPayload = (await fetch(`/api/books/${bookId}`).then((response) => response.json())) as { ok: boolean; data?: { book: BookView }; error?: { message: string } };
        if (!bookPayload.ok || !bookPayload.data?.book) throw new Error(bookPayload.error?.message ?? '读取读物失败');
        setBook(bookPayload.data.book);
        const progressPayload = (await fetch(`/api/books/${bookId}/progress`).then((response) => response.json())) as { ok: boolean; data?: { progress: ProgressPayload | null } };
        const progress = progressPayload.data?.progress;
        if (progress) {
          setPage(progress.page ?? 1);
          setPercent(progress.percent);
          setPosition(progress.position ?? '');
          if (progress.readerType !== 'epub') {
            window.setTimeout(() => contentRef.current?.scrollTo({ top: Number(progress.position) || 0 }), 200);
          }
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '读取读物失败');
      }
    }
    load();
  }, [bookId]);

  useEffect(() => {
    if (!book || readerType !== 'comic' || !archiveComic) return;
    fetch(`/api/books/${book.id}/pages`)
      .then((response) => {
        if (!response.ok) throw new Error('漫画页面索引加载失败');
        return response.json() as Promise<{ ok: boolean; data?: { pageCount: number }; error?: { message: string } }>;
      })
      .then((payload) => {
        if (!payload.ok || !payload.data) throw new Error(payload.error?.message ?? '漫画页面索引加载失败');
        const pageCount = payload.data.pageCount;
        setArchivePageCount(pageCount);
        setPage((current) => Math.max(1, Math.min(current, Math.max(1, pageCount))));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '漫画页面索引加载失败'));
  }, [book, readerType, archiveComic]);

  useEffect(() => {
    if (!book) return;
    const timer = window.setTimeout(() => {
      fetch(`/api/books/${book.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readerType,
          position: readerType === 'epub' ? position : String(contentRef.current?.scrollTop ?? 0),
          page,
          percent,
          extra: { zoom, fontSize, lineHeight }
        })
      }).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [book, readerType, page, percent, position, zoom, fontSize, lineHeight]);

  function updateScrollProgress() {
    if (readerType === 'epub') return;
    const element = contentRef.current;
    if (!element) return;
    const max = Math.max(1, element.scrollHeight - element.clientHeight);
    setPercent(Math.round((element.scrollTop / max) * 100));
  }

  function movePage(delta: number) {
    if (!book) return;
    if (readerType === 'epub') {
      void (delta > 0 ? epubControlsRef.current?.next() : epubControlsRef.current?.prev());
      return;
    }
    const maxPage = Math.max(1, totalPages || 1);
    const next = Math.max(1, Math.min(maxPage, page + delta));
    setPage(next);
    setPercent(Math.round(((next - 1) / Math.max(1, maxPage - 1)) * 100));
  }

  if (error) return <div className="min-h-screen bg-slate-950 p-8 text-red-200">{error}</div>;
  if (!book) return <div className="min-h-screen bg-slate-950 p-8 text-slate-200">正在打开阅读器...</div>;

  const currentFile = firstFile;

  return (
    <div className={cn('relative min-h-screen overflow-hidden transition', dark ? 'bg-[#0F172A] text-slate-100' : 'bg-[#F5F1E8] text-slate-900')}>
      {tools ? (
        <div className={cn('absolute inset-x-0 top-0 z-10 flex h-20 items-center justify-between border-b px-4 backdrop-blur-xl md:px-6', dark ? 'border-white/10 bg-slate-950/75' : 'border-slate-200 bg-white/75')}>
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => router.push(`/books/${book.id}`)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10">
              <ChevronLeft />
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10">
              <Library size={18} />
            </div>
            <div className="min-w-0">
              <div className="truncate font-semibold">{book.title}</div>
              <div className="text-xs opacity-60">{readerType.toUpperCase()} · {book.chapter}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <CheckCircle2 size={18} className="text-emerald-400" />
          </div>
        </div>
      ) : null}
      <div ref={contentRef} onScroll={updateScrollProgress} onClick={() => setTools((value) => !value)} className="h-screen overflow-auto px-4 pb-40 pt-24 md:px-8">
        <div className="mx-auto flex min-h-full max-w-6xl items-start justify-center">
          {readerType === 'epub' ? (
            <EpubReader
              bookId={book.id}
              title={book.title}
              dark={dark}
              fontSize={fontSize}
              lineHeight={lineHeight}
              initialCfi={position}
              onControls={(controls) => {
                epubControlsRef.current = controls;
              }}
              onProgress={(progress) => {
                setPosition(progress.cfi);
                setPage(progress.page);
                setPercent(progress.percent);
                setEpubLabel(progress.label);
              }}
            />
          ) : null}
          {readerType === 'comic' && archiveComic && archivePageCount === null ? (
            <div className="text-slate-300">正在建立漫画页面索引...</div>
          ) : null}
          {readerType === 'comic' && currentFile && archivePageCount !== null ? (
            <div className="flex w-full justify-center">
              <img src={archiveComic ? archivePageUrl(book.id, page) : archivePageUrl(book.id, page)} alt={`${book.title} 第 ${page} 页`} className="max-h-none max-w-full rounded-2xl shadow-2xl" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }} />
            </div>
          ) : null}
          {readerType === 'unknown' ? (
            <div className="rounded-3xl bg-white/10 p-8 text-slate-200">该读物没有可读内容，或文件格式暂不支持。</div>
          ) : null}
        </div>
      </div>
      {tools ? (
        <div className={cn('absolute inset-x-0 bottom-0 z-10 border-t p-4 backdrop-blur-xl md:p-5', dark ? 'border-white/10 bg-slate-950/75' : 'border-slate-200 bg-white/75')}>
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
            <Button variant="ghost" icon={ChevronLeft} onClick={() => movePage(-1)}>上一页</Button>
            <Progress value={percent} className="min-w-40 flex-1" />
            <span className="text-sm text-slate-400">{readerType === 'epub' ? `${epubLabel} · ${percent}%` : `第 ${page} / ${Math.max(1, totalPages || 1)} 页 · ${percent}%`}</span>
            <Button variant="ghost" icon={ChevronRight} onClick={() => movePage(1)}>下一页</Button>
            <Button variant="ghost" icon={Minus} onClick={() => readerType === 'epub' ? setFontSize((value) => Math.max(14, value - 1)) : setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(1))))} />
            <Button variant="ghost" icon={Plus} onClick={() => readerType === 'epub' ? setFontSize((value) => Math.min(28, value + 1)) : setZoom((value) => Math.min(2, Number((value + 0.1).toFixed(1))))} />
            <Button variant="ghost" icon={dark ? Sun : Moon} onClick={() => setDark((value) => !value)}>{dark ? '护眼' : '夜间'}</Button>
          </div>
          <div className="mx-auto mt-4 grid max-w-4xl grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-3">字号 {fontSize}px</div>
            <button className="rounded-2xl border border-white/10 bg-white/10 p-3 text-left" onClick={() => setLineHeight((value) => (value >= 2.2 ? 1.6 : Number((value + 0.1).toFixed(1))))}>行距 {lineHeight}</button>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-3">缩放 {Math.round(zoom * 100)}%</div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-3">背景 {dark ? '深色' : '护眼'}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
