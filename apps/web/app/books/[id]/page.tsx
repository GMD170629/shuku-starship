import { AppShell } from '@/components/layout/app-shell';
import { mockBooks } from '@/data/mock-books';

export default function BookDetail({ params }: { params: { id: string } }) {
  const book = mockBooks.find((b) => b.id === params.id) ?? mockBooks[0];
  return <AppShell title="图书详情"><div className="space-y-2"><div className={`h-48 w-36 rounded bg-gradient-to-br ${book.gradient}`} /><div>{book.title}</div><div className="text-sm text-slate-500">{book.author}</div></div></AppShell>;
}
