import type { MockBook } from '@/data/mock-books';

export function BookCard({ book }: { book: MockBook }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={`mb-3 h-32 rounded-md bg-gradient-to-br ${book.gradient}`} />
      <div className="font-medium">{book.title}</div>
      <div className="text-sm text-slate-500">{book.author} · {book.format}</div>
    </div>
  );
}
