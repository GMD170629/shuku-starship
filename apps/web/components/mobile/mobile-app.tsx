'use client';

import { Archive, BookMarked, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, Download, Home, Moon, Search, Settings, User, Wifi } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BookView } from '../../lib/books';
import { Cover } from '../book/cover';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Progress } from '../ui/progress';

type MobilePage = 'mhome' | 'mshelf' | 'msearch' | 'mprofile' | 'mdetail' | 'mreader';
type UserInfo = { id: string; email: string; name: string; role: string };
type Summary = { totalBooks: number; latestSyncAt: string | null };
type ContinueItem = { book: BookView; progress: number; lastReadAt: string; chapter: string | null } | null;

function MobileFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto h-[844px] w-[390px] overflow-hidden rounded-[42px] border-[10px] border-slate-900 bg-[#F8FAFC] shadow-2xl"><div className="h-full overflow-hidden">{children}</div></div>;
}

function MiniMetric({ value, label }: { value: string; label: string }) {
  return <div className="rounded-2xl bg-slate-50 p-3"><div className="font-semibold text-slate-950">{value}</div><div className="mt-1 text-xs text-slate-500">{label}</div></div>;
}

function MobileBookRow({ book, onClick }: { book: BookView; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-3xl bg-white p-3 text-left shadow-sm">
      <Cover book={book} className="h-20 w-14" small />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{book.title}</div>
        <div className="mt-1 text-xs text-slate-500">{book.author} · {book.type}</div>
        <Progress value={book.progress} className="mt-3" />
      </div>
      <span className="text-xs text-slate-500">{book.progress}%</span>
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-3xl bg-white p-5 text-sm leading-6 text-slate-500 shadow-sm">{children}</div>;
}

export function MobileApp() {
  const [mobilePage, setMobilePage] = useState<MobilePage>('mhome');
  const [books, setBooks] = useState<BookView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [continueItem, setContinueItem] = useState<ContinueItem>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [health, setHealth] = useState<{ status: string } | null>(null);
  const [night, setNight] = useState(true);
  const [tools, setTools] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/books?pageSize=20').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/continue-reading').then((response) => response.json()).catch(() => null),
      fetch('/api/dashboard/summary').then((response) => response.json()).catch(() => null),
      fetch('/api/auth/me').then((response) => response.json()).catch(() => null),
      fetch('/api/system/health').then((response) => response.json()).catch(() => null)
    ]).then(([booksPayload, continuePayload, summaryPayload, userPayload, healthPayload]) => {
      if (booksPayload?.ok) setBooks(booksPayload.data.books ?? []);
      if (continuePayload?.ok) setContinueItem(continuePayload.data.item);
      if (summaryPayload?.ok) setSummary(summaryPayload.data);
      if (userPayload?.ok) setUser(userPayload.data.user);
      if (healthPayload?.ok) setHealth(healthPayload.data);
    });
  }, []);

  const selectedBook = useMemo(() => books.find((book) => book.id === selectedId) ?? continueItem?.book ?? books[0] ?? null, [books, continueItem, selectedId]);

  function openBook(book: BookView) {
    setSelectedId(book.id);
    setMobilePage('mdetail');
  }

  const tabs = [
    { key: 'mhome' as const, icon: Home, label: '首页' },
    { key: 'mshelf' as const, icon: BookMarked, label: '书架' },
    { key: 'msearch' as const, icon: Search, label: '搜索' },
    { key: 'mprofile' as const, icon: User, label: '我的' }
  ];

  return (
    <MobileFrame>
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-auto">
          {mobilePage === 'mhome' ? (
            <div className="p-5">
              <div className="flex items-center justify-between pt-2">
                <div><div className="text-sm text-slate-500">{user?.name ?? '读者'}</div><h1 className="text-2xl font-semibold">继续你的阅读</h1></div>
                <Badge tone={summary?.latestSyncAt ? 'green' : 'amber'}>{summary?.latestSyncAt ? '有进度' : '暂无同步'}</Badge>
              </div>
              {continueItem ? (
                <div className="mt-6 rounded-[28px] bg-white p-4 shadow-sm">
                  <div className="flex gap-4">
                    <Cover book={continueItem.book} className="h-44 flex-1" />
                    <div className="w-40 py-1">
                      <div className="text-lg font-semibold leading-tight">{continueItem.book.title}</div>
                      <div className="mt-2 text-xs text-slate-500">{continueItem.chapter ?? continueItem.book.chapter} · {Math.round(continueItem.progress)}%</div>
                      <Progress value={continueItem.progress} className="mt-4" />
                      <Button className="mt-5 w-full" icon={BookOpen} onClick={() => { setSelectedId(continueItem.book.id); setMobilePage('mreader'); }}>继续阅读</Button>
                    </div>
                  </div>
                </div>
              ) : <div className="mt-6"><Empty>暂无继续阅读。</Empty></div>}
              <div className="mt-7 space-y-3">
                <h2 className="font-semibold">最近新增</h2>
                {books.slice(0, 3).map((book) => <MobileBookRow key={book.id} book={book} onClick={() => openBook(book)} />)}
                {books.length === 0 ? <Empty>暂无读物，请上传 EPUB/CBZ/ZIP，或添加监控文件夹。</Empty> : null}
              </div>
            </div>
          ) : null}
          {mobilePage === 'mshelf' || mobilePage === 'msearch' ? (
            <div className="p-5">
              <h1 className="pt-2 text-2xl font-semibold">{mobilePage === 'msearch' ? '搜索' : '我的书架'}</h1>
              <div className="mt-4 flex h-11 items-center gap-2 rounded-2xl bg-white px-4 shadow-sm"><Search size={17} className="text-slate-400" /><input placeholder="搜索书名或作者" className="w-full bg-transparent text-sm outline-none" /></div>
              <div className="mt-5 grid grid-cols-2 gap-4">
                {books.map((book) => <button key={book.id} onClick={() => openBook(book)} className="rounded-[24px] bg-white p-3 text-left shadow-sm"><Cover book={book} className="h-40 w-full" small /><div className="mt-3 line-clamp-1 text-sm font-semibold">{book.title}</div><div className="mt-1 text-xs text-slate-500">{book.progress}% · {book.author}</div></button>)}
              </div>
              {books.length === 0 ? <div className="mt-5"><Empty>暂无读物，请上传 EPUB/CBZ/ZIP，或添加监控文件夹。</Empty></div> : null}
            </div>
          ) : null}
          {mobilePage === 'mdetail' && selectedBook ? (
            <div className="p-5">
              <button onClick={() => setMobilePage('mshelf')} className="mb-4 flex items-center gap-1 text-sm text-slate-500"><ChevronLeft size={16} />返回</button>
              <div className="flex gap-4">
                <Cover book={selectedBook} className="h-48 w-32" />
                <div className="flex-1 pt-2"><h1 className="text-xl font-semibold leading-tight">{selectedBook.title}</h1><div className="mt-2 text-sm text-slate-500">{selectedBook.author}</div><div className="mt-3 flex flex-wrap gap-1">{selectedBook.tags.slice(0, 2).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div><Progress value={selectedBook.progress} className="mt-5" /><Button className="mt-5 w-full" onClick={() => setMobilePage('mreader')}>继续阅读</Button></div>
              </div>
              <p className="mt-6 text-sm leading-7 text-slate-600">{selectedBook.desc}</p>
              <h2 className="mt-7 font-semibold">章节列表</h2>
              <div className="mt-3 space-y-2">{selectedBook.files.length > 0 ? selectedBook.files.map((file) => <button key={file.id} onClick={() => setMobilePage('mreader')} className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left shadow-sm"><span className="truncate">{file.path.split('/').at(-1)}</span><ChevronRight size={16} className="text-slate-400" /></button>) : <Empty>{selectedBook.formatValue === 'EPUB' ? '全文阅读' : '暂无章节信息'}</Empty>}</div>
            </div>
          ) : null}
          {mobilePage === 'mreader' && selectedBook ? (
            <div onClick={() => setTools((value) => !value)} className={cn('relative h-full', night ? 'bg-[#111827] text-slate-100' : 'bg-[#F5F1E8] text-slate-900')}>
              {tools ? <div onClick={(event) => event.stopPropagation()} className="absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-between bg-black/20 px-4 backdrop-blur"><button onClick={() => setMobilePage('mdetail')}><ChevronLeft /></button><div className="truncate text-sm font-medium">{selectedBook.title}</div><CheckCircle2 size={18} className="text-emerald-400" /></div> : null}
              <div className="px-7 pt-24 text-lg leading-[2.05]">
                {selectedBook.formatValue === 'EPUB' ? <iframe title={selectedBook.title} src={`/reader/${selectedBook.editionId ?? selectedBook.id}`} className="h-[620px] w-full rounded-2xl bg-slate-950" /> : selectedBook.formatValue === 'COMIC' && selectedBook.volumes[0] ? <img src={`/api/volumes/${selectedBook.volumes[0].id}/pages/1`} alt={selectedBook.title} className="w-full rounded-2xl" /> : <div className="rounded-3xl bg-white/10 p-5 text-sm">该读物没有可读内容，或文件格式暂不支持。</div>}
              </div>
              {tools ? <div onClick={(event) => event.stopPropagation()} className="absolute inset-x-0 bottom-0 z-10 bg-black/20 p-4 backdrop-blur"><div className="flex items-center gap-3"><Button variant="ghost" icon={ChevronLeft}>上一页</Button><Progress value={selectedBook.progress} className="flex-1" /><Button variant="ghost" icon={ChevronRight}>下一页</Button></div><div className="mt-4 grid grid-cols-4 gap-2 text-xs"><button className="rounded-2xl bg-white/10 p-3">字号</button><button className="rounded-2xl bg-white/10 p-3">亮度</button><button className="rounded-2xl bg-white/10 p-3">行距</button><button onClick={() => setNight((value) => !value)} className="rounded-2xl bg-white/10 p-3">{night ? '护眼' : '夜间'}</button></div></div> : null}
            </div>
          ) : null}
          {mobilePage === 'mprofile' ? (
            <div className="p-5">
              <div className="pt-3 text-center"><div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-slate-900 text-white"><User size={32} /></div><h1 className="mt-3 text-xl font-semibold">{user?.name ?? '当前用户'}</h1><div className="mt-1 text-sm text-slate-500">{health?.status === 'ok' ? 'NAS 状态正常' : 'NAS 状态待检测'} · {summary?.latestSyncAt ? `${new Date(summary.latestSyncAt).toLocaleString()} 同步` : '暂无同步'}</div></div>
              <div className="mt-6 grid grid-cols-3 gap-3 text-center"><MiniMetric value={String(summary?.totalBooks ?? 0)} label="总读物" /><MiniMetric value={summary?.latestSyncAt ? '1' : '0'} label="进度" /><MiniMetric value={books.filter((book) => book.progress > 0).length.toString()} label="在读" /></div>
              <div className="mt-6 space-y-3">{[
                { title: 'NAS 连接状态', icon: Wifi, value: health?.status === 'ok' ? '正常' : '待检测' },
                { title: '本地缓存', icon: Download, value: '未配置' },
                { title: '备份入口', icon: Archive, value: '未配置' },
                { title: '主题切换', icon: Moon, value: '跟随系统' },
                { title: '系统设置', icon: Settings, value: '路径/同步/安全' }
              ].map(({ title, icon: Icon, value }) => <div key={title} className="flex items-center justify-between rounded-3xl bg-white p-4 shadow-sm"><div className="flex items-center gap-3"><Icon size={18} className="text-blue-600" /><span className="font-medium">{title}</span></div><span className="text-sm text-slate-500">{value}</span></div>)}</div>
            </div>
          ) : null}
        </div>
        {mobilePage !== 'mreader' ? <div className="grid h-20 grid-cols-4 border-t border-slate-200 bg-white/90 backdrop-blur-xl">{tabs.map(({ key, icon: Icon, label }) => <button key={key} onClick={() => setMobilePage(key)} className={cn('flex flex-col items-center justify-center gap-1 text-xs', mobilePage === key ? 'text-blue-600' : 'text-slate-400')}><Icon size={20} /><span>{label}</span></button>)}</div> : null}
      </div>
    </MobileFrame>
  );
}
