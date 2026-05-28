'use client';

import type { MouseEventHandler } from 'react';
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
  onClick
}: {
  book: CoverBook & { tags: string[]; progress: number; type: string; format: string; totalUnits?: number };
  compact?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onClick?: MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative cursor-pointer rounded-[24px] border bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
        selected ? 'border-blue-400 ring-4 ring-blue-100' : 'border-slate-200'
      )}
    >
      {selectionEnabled ? (
        <label
          className="absolute left-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/80 bg-white/95 shadow-sm"
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
      <Cover book={book} className={compact ? 'h-40 w-full' : 'h-56 w-full'} />
      <div className="mt-3">
        <div className="line-clamp-1 text-sm font-semibold text-slate-950">{book.title}</div>
        <div className="mt-1 text-xs text-slate-500">
          {book.author} · {book.format} · {book.type === 'comic' ? `共 ${book.totalUnits ?? 0} 页` : `共 ${book.totalUnits ?? 0} 章`}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {book.tags.slice(0, compact ? 1 : 2).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Progress value={book.progress} className="flex-1" />
          <span className="text-xs text-slate-500">{book.progress}%</span>
        </div>
      </div>
    </div>
  );
}
