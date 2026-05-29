'use client';

import { MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Cover } from '../../components/book/cover';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/cn';
import { PageTitle } from '../../components/ui/page-title';
import type { BookView } from '../../lib/books';

type BooksPayload = {
  ok: boolean;
  data?: { books: BookView[]; page: number; totalPages: number };
};

const shelfDefs = [
  { name: '正在阅读', match: (book: BookView) => book.statusValue === 'READING' || book.progress > 0 },
  { name: '想看', match: (book: BookView) => book.statusValue === 'WANT' },
  { name: '已完成', match: (book: BookView) => book.statusValue === 'FINISHED' || book.progress >= 99 },
  { name: '最近添加', match: () => true }
];

export function ShelvesPage() {
  const [books, setBooks] = useState<BookView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadAllBooks() {
      const collected: BookView[] = [];
      let nextPage = 1;
      let totalPages = 1;
      do {
        const response = await fetch(`/api/books?page=${nextPage}&pageSize=60&sort=created`);
        const payload = (await response.json()) as BooksPayload;
        if (!payload.ok || !payload.data) break;
        collected.push(...payload.data.books);
        totalPages = payload.data.totalPages;
        nextPage += 1;
      } while (nextPage <= totalPages);
      if (active) setBooks(collected);
    }
    loadAllBooks().catch(() => undefined).finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const shelves = useMemo(() => shelfDefs.map((shelf) => ({ ...shelf, books: books.filter(shelf.match).slice(0, 4), count: books.filter(shelf.match).length })), [books]);

  return (
    <div className="space-y-6">
      <PageTitle title="书架" desc="按收藏、阅读状态和主题组织你的私人读物。" action={<Button icon={Plus}>创建书架</Button>} />
      <div className="flex gap-2">
        {['全部', '想看', '在读', '已读', '收藏'].map((item, index) => (
          <button key={item} className={cn('rounded-full border px-4 py-2 text-sm', index === 0 ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600')}>{item}</button>
        ))}
      </div>
      {loading ? <div className="rounded-3xl bg-white p-6 text-sm text-slate-500">正在读取书架...</div> : null}
      {!loading && books.length === 0 ? <div className="rounded-3xl bg-white p-6 text-sm text-slate-500">暂无读物，请上传 EPUB/CBZ/ZIP，或在系统设置中添加监控文件夹。</div> : null}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {books.length > 0 ? shelves.map((shelf) => (
          <div key={shelf.name} className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="flex h-32 items-end gap-2 rounded-3xl bg-slate-50 p-4">
              {shelf.books.map((book, index) => <Cover key={`${book.id}-${index}`} book={book} className="h-24 w-16 rotate-[-3deg]" small />)}
              {shelf.books.length === 0 ? <span className="text-sm text-slate-400">暂无读物</span> : null}
            </div>
            <div className="mt-4 flex items-start justify-between">
              <div><div className="font-semibold">{shelf.name}</div><div className="mt-1 text-sm text-slate-500">{shelf.count} 本 · 来自数据库</div></div>
              <MoreHorizontal size={18} className="text-slate-400" />
            </div>
          </div>
        )) : null}
      </div>
      <div className="hidden"><Badge>保留徽标样式</Badge></div>
    </div>
  );
}
