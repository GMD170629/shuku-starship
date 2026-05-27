'use client';

import { MoreHorizontal, Plus } from 'lucide-react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import { books, shelves } from '../../data/mock-books';

export function ShelvesPage() {
  return (
    <div className="space-y-6">
      <PageTitle title="书架" desc="按收藏、阅读状态和主题组织你的私人读物。" action={<Button icon={Plus}>创建书架</Button>} />
      <div className="flex gap-2">
        {['全部', '想看', '在读', '已读', '搁置', '收藏'].map((item, index) => (
          <button
            key={item}
            className={cn(
              'rounded-full border px-4 py-2 text-sm',
              index === 0 ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600'
            )}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-5">
        {shelves.map((shelf) => (
          <div key={shelf.name} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="flex h-32 items-end gap-2 rounded-3xl bg-slate-50 p-4">
              {shelf.ids.map((id, index) => {
                const book = books.find((item) => item.id === id) ?? books[0];
                return <Cover key={`${id}-${index}`} book={book} className="h-24 w-16 rotate-[-3deg]" small />;
              })}
            </div>
            <div className="mt-4 flex items-start justify-between">
              <div>
                <div className="font-semibold">{shelf.name}</div>
                <div className="mt-1 text-sm text-slate-500">{shelf.count} 本 · 更新 {shelf.updated}</div>
              </div>
              <MoreHorizontal size={18} className="text-slate-400" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden">
        <Badge>保留徽标样式</Badge>
      </div>
    </div>
  );
}
