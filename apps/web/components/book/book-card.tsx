'use client';

import { Trash2 } from 'lucide-react';
import type { MouseEvent, MouseEventHandler } from 'react';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { Cover } from './cover';
import type { CoverBook } from './cover';

export function BookCard({
  book,
  compact = false,
  onDelete,
  onClick
}: {
  book: CoverBook & { tags: string[]; progress: number; type: string; format: string; totalUnits?: number; versionCount?: number; volumeCount?: number; primaryEditionName?: string | null };
  compact?: boolean;
  onDelete?: () => void;
  onClick?: MouseEventHandler<HTMLDivElement>;
}) {
  const authorLabel = book.author.trim() && book.author !== '未知作者' ? book.author.trim() : null;

  function deleteBook(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onDelete?.();
  }

  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer rounded-[18px] border border-slate-200 bg-white p-2.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      {onDelete ? (
        <button
          type="button"
          onClick={deleteBook}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-red-100 bg-white/95 text-red-600 opacity-0 shadow-sm transition hover:bg-red-50 focus:opacity-100 group-hover:opacity-100"
          title="删除记录"
          aria-label={`删除 ${book.title}`}
        >
          <Trash2 size={15} />
        </button>
      ) : null}
      <div className="relative">
        <Cover book={book} size={compact ? 'small' : 'medium'} className="aspect-[2/3] w-full" />
        <div className="absolute inset-x-2 bottom-2 rounded-full bg-white/80 p-0.5 shadow-sm backdrop-blur">
          <Progress value={book.progress} className="h-1.5 bg-slate-200/80" />
        </div>
      </div>
      <div className="mt-2.5">
        <div className="line-clamp-1 text-sm font-semibold text-slate-950">{book.title}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {authorLabel ? <Badge className="max-w-full truncate">{authorLabel}</Badge> : null}
          {(book.versionCount ?? 1) > 1 ? <Badge tone="blue">{book.versionCount} 版本</Badge> : null}
          {(book.volumeCount ?? 0) > 1 ? <Badge tone="green">{book.volumeCount} 卷</Badge> : null}
          {book.tags.slice(0, compact ? 1 : 2).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
