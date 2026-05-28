'use client';

import { MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { BookView } from '../../lib/books';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';
import { Cover } from './cover';

export function BookTable({
  books,
  selectedIds = [],
  onSelectedChange
}: {
  books: BookView[];
  selectedIds?: string[];
  onSelectedChange?: (bookId: string, selected: boolean) => void;
}) {
  const router = useRouter();
  const selectedSet = new Set(selectedIds);

  return (
    <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {onSelectedChange ? <th className="w-12 p-4">选择</th> : null}
            <th className="p-4">读物</th>
            <th>类型</th>
            <th>标签</th>
            <th>状态</th>
            <th>进度</th>
            <th>最近阅读</th>
            <th className="pr-4 text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {books.map((book) => (
            <tr key={book.id} className="hover:bg-slate-50">
              {onSelectedChange ? (
                <td className="p-4">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(book.id)}
                    onChange={(event) => onSelectedChange(book.id, event.target.checked)}
                    className="h-4 w-4 accent-blue-600"
                    aria-label={`选择 ${book.title}`}
                  />
                </td>
              ) : null}
              <td className="p-4">
                <div className="flex items-center gap-3">
                  <Cover book={book} className="h-16 w-11" small />
                  <div>
                    <div className="font-semibold">{book.title}</div>
                    <div className="text-xs text-slate-500">
                      {book.author} · {book.format} · {book.type === 'comic' ? `共 ${book.totalUnits} 页` : `共 ${book.totalUnits} 章`} · {book.size}
                    </div>
                  </div>
                </div>
              </td>
              <td>{book.type === 'comic' ? '漫画' : '电子书'}</td>
              <td>
                <div className="flex gap-1">
                  {book.tags.slice(0, 2).map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </td>
              <td>
                <Badge tone={book.status === '已读' ? 'green' : 'blue'}>{book.status}</Badge>
              </td>
              <td className="w-40">
                <div className="flex items-center gap-2">
                  <Progress value={book.progress} className="flex-1" />
                  <span className="text-xs text-slate-500">{book.progress}%</span>
                </div>
              </td>
              <td className="text-slate-500">{book.lastRead}</td>
              <td className="pr-4 text-right">
                <Button variant="ghost" icon={MoreHorizontal} onClick={() => router.push(`/books/${book.id}`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
