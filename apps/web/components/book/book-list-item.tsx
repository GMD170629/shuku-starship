import type { MockBook } from '@/data/mock-books';

export function BookListItem({ book }: { book: MockBook }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border p-3">
      <div className={`h-14 w-10 rounded bg-gradient-to-br ${book.gradient}`} />
      <div className="flex-1">
        <div className="font-medium">{book.title}</div>
        <div className="text-sm text-slate-500">{book.author}</div>
      </div>
      <div className="text-sm text-slate-600">{book.progress}%</div>
    </div>
  );
}
