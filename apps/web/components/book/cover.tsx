'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '../ui/cn';

export type CoverBook = {
  id?: string | number;
  title: string;
  author: string;
  format: string;
  gradient: string;
  coverUrl?: string;
  coverStatus?: string;
};

export function Cover({
  book,
  className = '',
  small = false,
  size
}: {
  book: CoverBook;
  className?: string;
  small?: boolean;
  size?: 'small' | 'medium' | 'large';
}) {
  const requestedSize = size ?? (small ? 'small' : 'medium');
  const coverUrl = useMemo(() => {
    if (book.coverUrl) return book.coverUrl.replace(/size=(small|medium|large)/, `size=${requestedSize}`);
    return book.id ? `/api/books/${book.id}/cover?size=${requestedSize}` : '';
  }, [book.coverUrl, book.id, requestedSize]);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [coverUrl]);

  if (coverUrl && !imageFailed) {
    return (
      <div className={cn('relative overflow-hidden rounded-2xl bg-slate-100 shadow-sm', className)}>
        <img
          src={coverUrl}
          alt={book.title}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  }

  return (
    <div className={cn('relative overflow-hidden rounded-2xl bg-gradient-to-br shadow-sm', book.gradient, className)}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.34),transparent_30%),linear-gradient(135deg,rgba(255,255,255,.18),transparent_38%)]" />
      <div className="absolute -bottom-8 -right-8 h-28 w-28 rounded-full bg-white/15" />
      <div className="absolute left-3 top-3 rounded-full bg-white/20 px-2 py-1 text-[10px] font-medium text-white backdrop-blur">
        {book.format}
      </div>
      <div className="absolute inset-x-3 bottom-3">
        <div className={cn('font-semibold leading-tight text-white', small ? 'text-xs' : 'text-sm')}>{book.title}</div>
        <div className="mt-1 text-[10px] text-white/75">{book.author}</div>
      </div>
    </div>
  );
}
