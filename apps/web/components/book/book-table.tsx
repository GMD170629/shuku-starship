'use client';

import { Eye, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { WorkView } from '../../types/work';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';
import { Cover } from './cover';

export function BookTable({
  books,
  selectedIds = [],
  onSelectedChange,
  onDelete
}: {
  books: WorkView[];
  selectedIds?: string[];
  onSelectedChange?: (bookId: string, selected: boolean) => void;
  onDelete?: (book: WorkView) => void;
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
          {books.map((book) => {
            const authorLabel = book.author.trim() && book.author !== '未知作者' ? book.author.trim() : null;

            return (
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
                      <div className="mt-1 flex max-w-md flex-wrap gap-1">
                        {authorLabel ? <Badge className="max-w-full truncate">{authorLabel}</Badge> : null}
                        {book.versionCount > 1 ? <Badge tone="blue">{book.versionCount} 版本</Badge> : null}
                        {book.volumeCount > 1 ? <Badge tone="green">{book.volumeCount} 卷</Badge> : null}
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
                  <Progress value={book.progress} />
                </td>
                <td className="text-slate-500">{book.lastRead}</td>
                <td className="pr-4 text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" icon={Eye} className="min-h-9 px-3 py-2" onClick={() => router.push(`/works/${book.id}`)}>查看</Button>
                    {onDelete ? <Button variant="danger" icon={Trash2} className="min-h-9 px-3 py-2" onClick={() => onDelete(book)}>删除</Button> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
