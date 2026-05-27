'use client';
import { useState } from 'react';
import { mockBooks } from '@/data/mock-books';
import { BookCard } from '@/components/book/book-card';
import { BookListItem } from '@/components/book/book-list-item';

export function LibraryView() {
  const [mode, setMode] = useState<'grid' | 'list'>('grid');
  return (
    <div>
      <div className="mb-4 flex gap-2">
        <button onClick={() => setMode('grid')} className="rounded border px-3 py-1 text-sm">网格</button>
        <button onClick={() => setMode('list')} className="rounded border px-3 py-1 text-sm">列表</button>
      </div>
      {mode === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{mockBooks.map((b) => <BookCard key={b.id} book={b} />)}</div>
      ) : (
        <div className="space-y-3">{mockBooks.map((b) => <BookListItem key={b.id} book={b} />)}</div>
      )}
    </div>
  );
}
