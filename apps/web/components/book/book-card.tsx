'use client';

import { Trash2 } from 'lucide-react';
import type { MouseEvent, MouseEventHandler } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';
import { Cover } from './cover';
import type { CoverBook } from './cover';

export function BookCard({
  book,
  compact = false,
  selected = false,
  selectionEnabled = false,
  onSelectedChange,
  onDelete,
  onClick
}: {
  book: CoverBook & { tags: string[]; progress: number; type: string; format: string; totalUnits?: number; versionCount?: number; volumeCount?: number; primaryEditionName?: string | null };
  compact?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onDelete?: () => void;
  onClick?: MouseEventHandler<HTMLDivElement>;
}) {
  function deleteBook(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onDelete?.();
  }

  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative cursor-pointer rounded-[18px] border bg-white p-2.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
        selected ? 'border-blue-400 ring-4 ring-blue-100' : 'border-slate-200'
      )}
    >
      {selectionEnabled ? (
        <label
          className="absolute left-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/80 bg-white/95 shadow-sm"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectedChange?.(event.target.checked)}
            className="h-4 w-4 accent-blue-600"
            aria-label={`选择 ${book.title}`}
          />
        </label>
      ) : null}
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
      <Cover book={book} size={compact ? 'small' : 'medium'} className="aspect-[2/3] w-full" />
      <div className="mt-2.5">
        <div className="line-clamp-1 text-sm font-semibold text-slate-950">{book.title}</div>
        <div className="mt-1 line-clamp-1 text-xs text-slate-500">
          {book.author} · {book.format} · {book.type === 'comic' ? `共 ${book.totalUnits ?? 0} 页` : `共 ${book.totalUnits ?? 0} 章`}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(book.versionCount ?? 1) > 1 ? <Badge tone="blue">{book.versionCount} 版本</Badge> : null}
          {(book.volumeCount ?? 0) > 1 ? <Badge tone="green">{book.volumeCount} 卷</Badge> : null}
          {book.tags.slice(0, compact ? 1 : 2).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <Progress value={book.progress} className="flex-1" />
          <span className="text-xs text-slate-500">{book.progress}%</span>
        </div>
      </div>
    </div>
  );
}
